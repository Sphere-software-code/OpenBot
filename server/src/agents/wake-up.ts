/**
 * A Bot deciding to come back later, on its own: "I will check the build again in an hour."
 *
 * ONE-SHOT AND BOUNDED. A follow-up is one future turn with a stated reason, no sooner than a
 * minute and no later than a week away, and a Bot may hold only a few at once per person and start
 * only so many a day. A Bot that schedules a follow-up from inside a follow-up is still inside the
 * same caps, so it cannot build itself a loop.
 *
 * THE SAME QUEUE AND THE SAME TURN AS A ROUTINE. The follow-up is a `work_items` row of kind
 * `bot.wakeup`, claimed with a lease like every other durable job here, and it runs through the
 * headless turn runner, which is the normal AG-UI path: the Bot's own tools, its governance, its
 * approvals, and the pause guard at the top of every headless turn.
 *
 * Identities come from the run that scheduled it, never from model arguments: the person and the
 * Bot are bound when the tools are built, and so is where it wakes. A follow-up scheduled in a
 * channel wakes in that channel; one scheduled anywhere else wakes in the person's own conversation
 * with the Bot.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditInitiator, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AgentChannel } from "../channels/routes";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import type { GrantedTool } from "../plugins/tools";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { WorkQueue } from "../work/queue";
import { BotPausedError } from "./lifecycle";
import type { AgentActor } from "./profile-types";

export const WAKE_UP_KIND = "bot.wakeup";
export const WAKE_UP_MIN_DELAY_MS = 60_000;
export const WAKE_UP_MAX_DELAY_MS = 7 * 24 * 60 * 60_000;
/** Follow-ups one Bot may have waiting for one person at once. */
export const WAKE_UP_MAX_PENDING = 5;
/** Follow-ups one Bot may schedule for one person in a day, fired or not. */
export const WAKE_UP_MAX_PER_DAY = 20;

export type WakeUpPayload = {
  ownerUserId: string;
  agentId: string;
  reason: string;
  instruction?: string;
  /** Where to wake up. Absent means the person's own conversation with this Bot. */
  channelId?: string;
  dueAt: string;
  scheduledAt: string;
  /** Written when it has run, was cancelled, or was skipped. */
  outcome?: {
    status: "succeeded" | "failed" | "waiting" | "skipped" | "cancelled";
    at: string;
    detail?: string;
  };
};

export type WakeUpRecord = WakeUpPayload & {
  id: string;
  state: "scheduled" | "running" | "done";
};

export class WakeUpRefusedError extends Error {
  override name = "WakeUpRefusedError";
}

const scheduleSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    in_minutes: z
      .number()
      .int()
      .min(WAKE_UP_MIN_DELAY_MS / 60_000)
      .max(WAKE_UP_MAX_DELAY_MS / 60_000)
      .optional(),
    at: z.string().datetime({ offset: true }).optional(),
    instruction: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine(
    (value) => (value.in_minutes === undefined) !== (value.at === undefined),
    {
      message: "Give exactly one of in_minutes or at.",
    },
  );

const keyPrefix = (ownerUserId: string, agentId: string) =>
  `wake:${JSON.stringify([ownerUserId, agentId])}:`;

const owned = (ownerUserId: string, agentId: string) =>
  and(
    eq(workItems.kind, WAKE_UP_KIND),
    sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
    sql`${workItems.payload}->>'agentId' = ${agentId}`,
  );

function toRecord(row: typeof workItems.$inferSelect): WakeUpRecord {
  const payload = row.payload as WakeUpPayload;
  const running =
    !row.finishedAt &&
    row.claimedBy !== null &&
    row.leaseUntil !== null &&
    row.leaseUntil.getTime() > Date.now();
  return {
    ...payload,
    id: row.key,
    state: row.finishedAt ? "done" : running ? "running" : "scheduled",
  };
}

export type WakeUpStore = ReturnType<typeof createWakeUpStore>;

export function createWakeUpStore(
  database: Database,
  options: { auditStore?: AuditStore; now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  async function audit(
    eventType: "bot.follow_up_scheduled" | "bot.follow_up_cancelled",
    payload: WakeUpPayload & { id: string },
    initiator?: AuditInitiator,
  ) {
    if (!options.auditStore) return;
    try {
      await recordAuditEvent(options.auditStore, {
        eventType,
        targetType: "agent",
        targetId: payload.agentId,
        actorUserId: payload.ownerUserId,
        ...(initiator ? { initiator } : {}),
        payload: {
          bot: payload.agentId,
          followUp: payload.id,
          reason: payload.reason.slice(0, 500),
          dueAt: payload.dueAt,
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "follow-up-audit-write-failed",
          eventType,
          error: String(error),
        }),
      );
    }
  }

  return {
    /**
     * Schedule one follow-up, inside the caps, as one serialised step per person and Bot so a
     * model asking five times at once cannot pass a cap of five with six.
     */
    async schedule(input: {
      ownerUserId: string;
      agentId: string;
      reason: string;
      dueAt: Date;
      instruction?: string;
      channelId?: string;
      initiator?: AuditInitiator;
    }): Promise<WakeUpRecord> {
      const delay = input.dueAt.getTime() - now().getTime();
      if (!Number.isFinite(delay) || delay < WAKE_UP_MIN_DELAY_MS - 1_000)
        throw new WakeUpRefusedError(
          "A follow-up has to be at least a minute away.",
        );
      if (delay > WAKE_UP_MAX_DELAY_MS)
        throw new WakeUpRefusedError(
          "A follow-up can be at most seven days away.",
        );
      const id = `${keyPrefix(input.ownerUserId, input.agentId)}${randomUUID()}`;
      const payload: WakeUpPayload = {
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        reason: input.reason,
        ...(input.instruction ? { instruction: input.instruction } : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        dueAt: input.dueAt.toISOString(),
        scheduledAt: now().toISOString(),
      };
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${WAKE_UP_KIND}:${input.ownerUserId}:${input.agentId}`}))`,
        );
        const [counts] = await transaction
          .select({
            pending: sql<number>`count(*) filter (where ${workItems.finishedAt} is null)::int`,
            today: sql<number>`count(*) filter (where ${workItems.createdAt} > now() - interval '1 day')::int`,
          })
          .from(workItems)
          .where(owned(input.ownerUserId, input.agentId));
        if ((counts?.pending ?? 0) >= WAKE_UP_MAX_PENDING)
          throw new WakeUpRefusedError(
            `This Bot already has ${WAKE_UP_MAX_PENDING} follow-ups waiting. Cancel one first.`,
          );
        if ((counts?.today ?? 0) >= WAKE_UP_MAX_PER_DAY)
          throw new WakeUpRefusedError(
            `This Bot has scheduled ${WAKE_UP_MAX_PER_DAY} follow-ups today, which is the most it may.`,
          );
        await transaction.insert(workItems).values({
          kind: WAKE_UP_KIND,
          key: id,
          runAt: input.dueAt,
          payload,
        });
      });
      await audit(
        "bot.follow_up_scheduled",
        { ...payload, id },
        input.initiator,
      );
      return { ...payload, id, state: "scheduled" };
    },

    /** This person's follow-ups with this Bot: waiting, running, and the last few that are done. */
    async list(ownerUserId: string, agentId: string): Promise<WakeUpRecord[]> {
      const rows = await database
        .select()
        .from(workItems)
        .where(owned(ownerUserId, agentId))
        .orderBy(asc(workItems.runAt))
        .limit(100);
      return rows.map(toRecord);
    },

    /** Cancel one that has not started. False when it is not theirs, not there, or already over. */
    async cancel(
      ownerUserId: string,
      agentId: string,
      id: string,
      initiator?: AuditInitiator,
    ): Promise<boolean> {
      const [row] = await database
        .select()
        .from(workItems)
        .where(and(owned(ownerUserId, agentId), eq(workItems.key, id)))
        .limit(1);
      if (!row || row.finishedAt) return false;
      const payload = row.payload as WakeUpPayload;
      const cancelled: WakeUpPayload = {
        ...payload,
        outcome: { status: "cancelled", at: now().toISOString() },
      };
      const [updated] = await database
        .update(workItems)
        .set({
          finishedAt: sql`now()`,
          claimedBy: null,
          leaseUntil: null,
          lastError: "Cancelled",
          payload: cancelled,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            owned(ownerUserId, agentId),
            eq(workItems.key, id),
            isNull(workItems.finishedAt),
          ),
        )
        .returning({ key: workItems.key });
      if (!updated) return false;
      await audit("bot.follow_up_cancelled", { ...payload, id }, initiator);
      return true;
    },

    /** Cancel every waiting follow-up for the pair. Used by reset. Returns how many. */
    async cancelAll(ownerUserId: string, agentId: string): Promise<number> {
      const cancelled = await database
        .update(workItems)
        .set({
          finishedAt: sql`now()`,
          claimedBy: null,
          leaseUntil: null,
          lastError: "Cancelled by reset",
          updatedAt: sql`now()`,
        })
        .where(and(owned(ownerUserId, agentId), isNull(workItems.finishedAt)))
        .returning({ key: workItems.key });
      return cancelled.length;
    },

    /** Record how a follow-up ended, on its own row. */
    async settle(id: string, outcome: NonNullable<WakeUpPayload["outcome"]>) {
      await database
        .update(workItems)
        .set({
          payload: sql`${workItems.payload} || ${JSON.stringify({ outcome })}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(workItems.kind, WAKE_UP_KIND), eq(workItems.key, id)));
    },
  };
}

/**
 * The channel a follow-up scheduled from this run should wake in, or null for the direct one.
 *
 * ONLY A CHANNEL'S OWN THREAD, AND ONLY ONE THIS BOT IS IN. `channelOf` is the lookup a channel's
 * coordination callbacks are authorised by: the run's thread mapped to a live channel the person is
 * a member of. For a delegated run it also answers with a channel the Bot need not be in, and a
 * follow-up woken there would put a Bot into a conversation nobody added it to, so that answer is
 * not taken.
 *
 * A Bot's thread in a group conversation is not a channel's thread and finds nothing here, on
 * purpose. The wake runner runs in the channel's own thread and records through the channel store,
 * which is the wrong conversation for a group Bot's turn, so those keep waking in the direct one.
 */
export async function followUpChannelForRun<
  Run extends { botId: string; threadId?: string },
>(
  run: Run,
  channelOf: (run: Run) => Promise<{ channelId: string; botId: string } | null>,
): Promise<string | null> {
  if (!run.threadId) return null;
  const source = await channelOf(run);
  return source?.botId === run.botId ? source.channelId : null;
}

/**
 * Where to wake, read when a follow-up is scheduled and not before.
 *
 * A lookup that fails costs the follow-up its channel, not the follow-up: it wakes in the person's
 * own conversation with this Bot, which is where every follow-up went before channels were
 * recorded, and still somewhere they will see it.
 */
async function wakeUpChannel(
  channel: string | (() => Promise<string | null | undefined>) | undefined,
): Promise<string | undefined> {
  if (typeof channel !== "function") return channel || undefined;
  try {
    return (await channel()) || undefined;
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "follow-up-channel-lookup-failed",
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

/** The Bot's own tools for this, bound to the person and the Bot of the run that is offered them. */
export function wakeUpTools(options: {
  store: WakeUpStore;
  ownerUserId: string;
  agentId: string;
  initiator?: AuditInitiator;
  /**
   * Which channel a follow-up wakes in: the one the run that scheduled it is in.
   *
   * Without it, a Bot asked to build something in a team channel checked on the build in the
   * person's direct chat with it, where nobody who asked was looking, and three builds went
   * unreviewed that way. Bound here with the person and the Bot, from the run, never from model
   * arguments, for the reason they are.
   *
   * A function as well as a string, because finding it is a query and most runs never schedule
   * anything: asked only when one is, so the others never pay for it. Absent, or nothing found,
   * means the person's own conversation with this Bot.
   */
  channelId?: string | (() => Promise<string | null | undefined>);
  now?: () => Date;
}): GrantedTool[] {
  const { store, ownerUserId, agentId, initiator } = options;
  const now = options.now ?? (() => new Date());
  function tool<T>(
    name: string,
    description: string,
    parameters: z.ZodType<T>,
    execute: (value: T) => Promise<unknown>,
  ): GrantedTool {
    return {
      name,
      ref: `lifecycle/${name}`,
      description,
      parameters,
      async execute(args) {
        const value = parameters.safeParse(args);
        if (!value.success)
          return `${REFUSAL_MARKER} ${value.error.issues[0]?.message ?? "Invalid follow-up arguments."}`;
        try {
          return JSON.stringify(await execute(value.data));
        } catch (error) {
          if (error instanceof WakeUpRefusedError)
            return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    };
  }
  return [
    tool(
      "schedule_follow_up",
      `Wake yourself up later to continue this work without the person asking: once, at one moment between 1 minute and 7 days from now. Give the reason (shown to the person) and either in_minutes or an ISO-8601 time in at. At most ${WAKE_UP_MAX_PENDING} may be waiting at once. Use it when something needs checking again later, not to repeat on a schedule (that is a routine).`,
      scheduleSchema,
      async (value) => {
        const dueAt =
          value.at !== undefined
            ? new Date(value.at)
            : new Date(now().getTime() + (value.in_minutes ?? 0) * 60_000);
        const channelId = await wakeUpChannel(options.channelId);
        const record = await store.schedule({
          ownerUserId,
          agentId,
          reason: value.reason,
          dueAt,
          ...(value.instruction ? { instruction: value.instruction } : {}),
          ...(channelId ? { channelId } : {}),
          ...(initiator ? { initiator } : {}),
        });
        return { scheduled: record.id, dueAt: record.dueAt };
      },
    ),
    tool(
      "list_follow_ups",
      "List the follow-ups you have scheduled for yourself with this person.",
      z.object({}).strict(),
      async () =>
        (await store.list(ownerUserId, agentId))
          .filter((record) => record.state !== "done")
          .map(({ id, reason, dueAt, state }) => ({
            id,
            reason,
            dueAt,
            state,
          })),
    ),
    tool(
      "cancel_follow_up",
      "Cancel a follow-up you scheduled that has not started yet.",
      z.object({ id: z.string().min(1).max(400) }).strict(),
      async ({ id }) => ({
        cancelled: await store.cancel(ownerUserId, agentId, id, initiator),
      }),
    ),
  ];
}

/** The message the Bot wakes up to. The reason is its own words, quoted back to it. */
export function wakeUpInstruction(payload: WakeUpPayload): string {
  const lines = [
    `You scheduled this follow-up for yourself on ${payload.scheduledAt}. Your reason: ${payload.reason}`,
  ];
  if (payload.instruction)
    lines.push(`What you meant to do: ${payload.instruction}`);
  lines.push(
    "Pick it up now. Tell the person what you found or did, in a sentence or two.",
  );
  return lines.join("\n");
}

export type WakeUpTurn = (input: {
  ownerUserId: string;
  routineId: string;
  agentId: string;
  threadId: string;
  instruction: string;
  initiator: AuditInitiator;
}) => Promise<{ replyText: string }>;

/**
 * Run the follow-ups that are due, one claim at a time.
 *
 * NO RETRY. A follow-up whose turn failed is recorded as failed rather than handed out again: the
 * failed turn may already have called a tool, and a Bot waking twice for one reason is the kind of
 * surprise this feature must not produce.
 */
export function createWakeUpRunner(options: {
  queue: Pick<WorkQueue, "claim" | "finish" | "purge">;
  store: WakeUpStore;
  owner: string;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  channels: {
    get(actor: AgentActor, channelId: string): Promise<AgentChannel | null>;
    direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;
    recordActivity(
      actor: AgentActor,
      channelId: string,
      activity: { text: string; agentId: string | null; at: Date },
      source?: { id: string },
    ): Promise<void>;
  };
  runTurn: WakeUpTurn;
  /** Tell the person off the web (push, Slack, SMS), subject to their routing. Best effort. */
  notify?: (
    scope: {
      ownerUserId: string;
      channelId: string;
      agentId: string;
      threadId: string;
    },
    input: { id: string; text: string; kind: "reply" },
  ) => Promise<void>;
  leaseMs?: number;
}) {
  const { queue, store, owner, actorFor, channels, runTurn, notify } = options;
  const leaseMs = options.leaseMs ?? 15 * 60_000;
  return {
    async sweep(): Promise<{ ran: string[]; skipped: string[] }> {
      const report = { ran: [] as string[], skipped: [] as string[] };
      const claimed = await queue.claim({
        kind: WAKE_UP_KIND,
        owner,
        leaseMs,
        limit: 1,
        maxAttempts: 1,
      });
      for (const item of claimed) {
        const payload = item.payload as unknown as WakeUpPayload;
        const at = () => new Date().toISOString();
        const done = async (
          outcome: NonNullable<WakeUpPayload["outcome"]>["status"],
          detail?: string,
        ) => {
          await store.settle(item.key, {
            status: outcome,
            at: at(),
            ...(detail ? { detail: detail.slice(0, 500) } : {}),
          });
          await queue.finish({ kind: WAKE_UP_KIND, key: item.key, owner });
        };
        try {
          if (!payload?.ownerUserId || !payload.agentId) {
            await done("skipped", "not a follow-up");
            report.skipped.push(item.key);
            continue;
          }
          const actor = await actorFor(payload.ownerUserId);
          const scheduledFrom = payload.channelId
            ? await channels.get(actor, payload.channelId)
            : null;
          /*
           * The channel it was scheduled from, while this Bot is still in it. One the person has
           * left or deleted reads as null, and one the Bot was taken out of since is passed over:
           * both wake in the direct conversation instead, which the person still reads and which
           * never puts the Bot back into a conversation it was removed from.
           */
          const channel =
            (scheduledFrom?.agentIds.includes(payload.agentId)
              ? scheduledFrom
              : null) ?? (await channels.direct(actor, payload.agentId));
          const initiator: AuditInitiator = {
            kind: "routine",
            id: `follow-up:${item.key}`,
          };
          try {
            const { replyText } = await runTurn({
              ownerUserId: payload.ownerUserId,
              routineId: `follow-up:${item.key}`,
              agentId: payload.agentId,
              threadId: channel.threadId,
              instruction: wakeUpInstruction(payload),
              initiator,
            });
            await channels.recordActivity(
              actor,
              channel.id,
              { text: replyText, agentId: payload.agentId, at: new Date() },
              { id: `follow-up:${item.key}` },
            );
            await done("succeeded");
            report.ran.push(item.key);
            await notify?.(
              {
                ownerUserId: payload.ownerUserId,
                channelId: channel.id,
                agentId: payload.agentId,
                threadId: channel.threadId,
              },
              { id: `follow-up:${item.key}`, text: replyText, kind: "reply" },
            ).catch((error: unknown) =>
              console.warn("Could not notify about a follow-up.", error),
            );
          } catch (error) {
            if (error instanceof BotPausedError) {
              await done("skipped", error.message);
              report.skipped.push(item.key);
            } else if (error instanceof HeadlessToolSuspension) {
              await channels
                .recordActivity(
                  actor,
                  channel.id,
                  {
                    text: error.message,
                    agentId: payload.agentId,
                    at: new Date(),
                  },
                  { id: `follow-up:${item.key}` },
                )
                .catch(() => {});
              await done("waiting", error.message);
              report.ran.push(item.key);
            } else {
              await done(
                "failed",
                error instanceof Error ? error.message : String(error),
              );
              report.skipped.push(item.key);
            }
          }
        } catch (error) {
          // The channel or the person could not be resolved: over, and said on the row.
          await done(
            "failed",
            error instanceof Error ? error.message : String(error),
          ).catch(() => {});
          report.skipped.push(item.key);
        }
      }
      return report;
    },
    /** Drop follow-ups that ended more than a week ago. */
    reap: () =>
      queue.purge({
        kind: WAKE_UP_KIND,
        olderThanMs: 7 * 24 * 60 * 60_000,
        maxAttempts: 1,
      }),
  };
}
