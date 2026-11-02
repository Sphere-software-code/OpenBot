import { describe, expect, spyOn, test } from "bun:test";
import {
  type AbstractAgent,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { EMPTY, lastValueFrom, of } from "rxjs";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  createWakeUpRunner,
  followUpChannelForRun,
  type WakeUpPayload,
  type WakeUpStore,
  wakeUpTools,
} from "../src/agents/wake-up";
import type { AgentChannel } from "../src/channels/routes";
import type { HandoffForRun, RegisteredAgent } from "../src/copilot";
import type { GrantedTool } from "../src/plugins/tools";

/**
 * Where a Bot's follow-up wakes, and that the Bot is offered its follow-up tools exactly once.
 *
 * A follow-up used to wake in the person's direct chat with the Bot whatever conversation it was
 * scheduled from, because the tools were built by the per-Bot loader, which runs before there is a
 * run or a thread to ask. Site PM checked on builds requested in a team channel from a chat nobody
 * in that channel was reading. The tools are now offered per run, beside coordination, where the
 * thread is known; these tests pin both halves of that: the channel is recorded, and moving the
 * tools did not offer them twice (which a remote run refuses outright) or not at all.
 */

const ACTOR = { id: "person-1", role: "user" as const };
const FOLLOW_UPS = [
  "schedule_follow_up",
  "list_follow_ups",
  "cancel_follow_up",
];

/** Threads as `channelSourceForRun` answers them: a channel's own thread, and a Bot in it. */
const CHANNEL_SOURCES = new Map([
  ["channel-thread", { channelId: "channel-1", botId: "site-pm" }],
  // A delegated run is answered with the source channel even when its Bot is not in it.
  ["someone-elses-thread", { channelId: "channel-2", botId: "outreach" }],
]);
// A group Bot's thread is in `group_bot_threads`, not the channel mappings, so it finds nothing.
const channelOf = async (run: { threadId?: string }) =>
  CHANNEL_SOURCES.get(run.threadId ?? "") ?? null;

function fakeStore() {
  const scheduled: Parameters<WakeUpStore["schedule"]>[0][] = [];
  const store = {
    async schedule(input: Parameters<WakeUpStore["schedule"]>[0]) {
      scheduled.push(input);
      return {
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        reason: input.reason,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        dueAt: input.dueAt.toISOString(),
        scheduledAt: new Date().toISOString(),
        id: `wake-${scheduled.length}`,
        state: "scheduled" as const,
      };
    },
    list: async () => [],
    cancel: async () => true,
  };
  return { store: store as unknown as WakeUpStore, scheduled };
}

const toolNamed = (tools: GrantedTool[], name: string) => {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`no ${name} was offered`);
  return found;
};

describe("which channel a follow-up wakes in", () => {
  test("a run in a channel's own thread wakes in that channel", async () => {
    expect(
      await followUpChannelForRun(
        { botId: "site-pm", threadId: "channel-thread" },
        channelOf,
      ),
    ).toBe("channel-1");
  });

  test("a group Bot's thread, or one no channel owns, wakes in the direct conversation", async () => {
    expect(
      await followUpChannelForRun(
        { botId: "site-pm", threadId: "group-bot-thread" },
        channelOf,
      ),
    ).toBeNull();
  });

  test("a channel this Bot is not in is never taken, even when the lookup offers it", async () => {
    expect(
      await followUpChannelForRun(
        { botId: "site-pm", threadId: "someone-elses-thread" },
        channelOf,
      ),
    ).toBeNull();
  });

  test("a run with no thread does not look at all", async () => {
    let asked = 0;
    expect(
      await followUpChannelForRun({ botId: "site-pm" }, async () => {
        asked += 1;
        return { channelId: "channel-1", botId: "site-pm" };
      }),
    ).toBeNull();
    expect(asked).toBe(0);
  });
});

describe("schedule_follow_up records where it was scheduled from", () => {
  const schedule = (
    channelId: Parameters<typeof wakeUpTools>[0]["channelId"],
  ) => {
    const { store, scheduled } = fakeStore();
    const tools = wakeUpTools({
      store,
      ownerUserId: ACTOR.id,
      agentId: "site-pm",
      channelId,
    });
    return { tools, scheduled };
  };

  test("the channel the run is in is on the follow-up", async () => {
    const { tools, scheduled } = schedule(() =>
      followUpChannelForRun(
        { botId: "site-pm", threadId: "channel-thread" },
        channelOf,
      ),
    );
    const answer = await toolNamed(tools, "schedule_follow_up").execute({
      reason: "Check the Acme build",
      in_minutes: 20,
    });
    expect(answer.startsWith("Refused.")).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.channelId).toBe("channel-1");
  });

  test("a channel already known is recorded as given", async () => {
    const { tools, scheduled } = schedule("channel-9");
    await toolNamed(tools, "schedule_follow_up").execute({
      reason: "Check the build",
      in_minutes: 5,
    });
    expect(scheduled[0]?.channelId).toBe("channel-9");
  });

  test("nothing found leaves it off, which wakes it in the direct conversation", async () => {
    const { tools, scheduled } = schedule(() =>
      followUpChannelForRun(
        { botId: "site-pm", threadId: "group-bot-thread" },
        channelOf,
      ),
    );
    await toolNamed(tools, "schedule_follow_up").execute({
      reason: "Check the build",
      in_minutes: 5,
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).not.toHaveProperty("channelId");
  });

  test("a lookup that fails still schedules the follow-up, without a channel", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { tools, scheduled } = schedule(async () => {
        throw new Error("connection reset");
      });
      const answer = await toolNamed(tools, "schedule_follow_up").execute({
        reason: "Check the build",
        in_minutes: 5,
      });
      expect(answer.startsWith("Refused.")).toBe(false);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).not.toHaveProperty("channelId");
    } finally {
      warn.mockRestore();
    }
  });

  test("listing and cancelling never look the channel up", async () => {
    let asked = 0;
    const { tools } = schedule(async () => {
      asked += 1;
      return "channel-1";
    });
    await toolNamed(tools, "list_follow_ups").execute({});
    await toolNamed(tools, "cancel_follow_up").execute({ id: "wake-1" });
    expect(asked).toBe(0);
  });
});

describe("a Bot is offered its follow-up tools once, per run", () => {
  const vendorTool: GrantedTool = {
    name: "mcp__site_builder__start_demo",
    ref: "site-builder/start_demo",
    description: "Start a demo build",
    parameters: z.object({ lead_id: z.string() }),
    execute: async () => "queued",
  };
  const askPerson: GrantedTool = {
    name: "ask_person",
    ref: "bot/ask_person",
    description: "Ask the owner",
    parameters: z.object({ question: z.string() }),
    execute: async () => "asked",
  };

  /**
   * The two loaders as index.ts wires them: the per-Bot loader holds the grants and no follow-ups,
   * and the per-run one adds them beside coordination, bound to the run's thread.
   */
  function resolver(store: WakeUpStore, agent: RegisteredAgent) {
    const perRun: HandoffForRun = async (botId, input) => [
      askPerson,
      ...wakeUpTools({
        store,
        ownerUserId: ACTOR.id,
        agentId: botId,
        channelId: () =>
          followUpChannelForRun({ botId, threadId: input.threadId }, channelOf),
      }),
    ];
    return createActorAgentResolver({
      loadAgents: async () => [agent],
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "synthetic-key",
      loadToolsForActor: () => async () => [vendorTool],
      handoffForActor: () => perRun,
    });
  }

  const count = (names: readonly string[], name: string) =>
    names.filter((candidate) => candidate === name).length;

  test.each([
    ["a channel's thread", "channel-thread", "channel-1"],
    ["a group Bot's thread", "group-bot-thread", undefined],
  ])(
    "a remote Bot's follow-up scheduled from %s",
    async (_label, threadId, channelId) => {
      const { store, scheduled } = fakeStore();
      const requests: RunAgentInput[] = [];
      const run = spyOn(HttpAgent.prototype, "run").mockImplementation(
        (input) => {
          requests.push(input);
          const call =
            requests.length === 1
              ? [
                  {
                    type: "TOOL_CALL_START" as const,
                    toolCallId: "call-1",
                    toolCallName: "schedule_follow_up",
                    parentMessageId: "message-1",
                  },
                  {
                    type: "TOOL_CALL_ARGS" as const,
                    toolCallId: "call-1",
                    delta: JSON.stringify({
                      reason: "Check the Acme demo build",
                      in_minutes: 22,
                    }),
                  },
                  { type: "TOOL_CALL_END" as const, toolCallId: "call-1" },
                ]
              : [];
          return of(
            {
              type: "RUN_STARTED" as const,
              threadId: input.threadId,
              runId: input.runId,
            },
            ...call,
            {
              type: "RUN_FINISHED" as const,
              threadId: input.threadId,
              runId: input.runId,
            },
          );
        },
      );
      try {
        const agent = await resolver(store, {
          id: "site-pm",
          name: "Site PM",
          type: "remote_ag_ui",
          endpoint: "https://site-pm.test/ag-ui",
          standingMessage: {
            id: "standing-role:site-pm",
            role: "system",
            content: "Run website builds.",
          },
        }).resolveAgentForActor(ACTOR, "site-pm");
        agent.threadId = threadId;
        agent.messages = [
          { id: "ask", role: "user", content: "Build demos for the top 3" },
        ];
        await agent.runAgent({ runId: "run-1" });

        const offered = requests[0]?.tools.map((tool) => tool.name) ?? [];
        for (const name of FOLLOW_UPS) expect(count(offered, name)).toBe(1);
        // Run here, by the deployment, like any granted tool; only coordination calls back.
        expect(requests[0]?.forwardedProps.openbotDeploymentTools).toEqual([
          "ask_person",
        ]);
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.channelId).toBe(channelId);
      } finally {
        run.mockRestore();
      }
    },
  );

  test("a built-in Bot is offered each once too, and records the channel", async () => {
    const { store, scheduled } = fakeStore();
    let configured: GrantedTool[] = [];
    const spy = spyOn(BuiltInAgent.prototype, "run").mockImplementation(
      function (this: AbstractAgent) {
        configured =
          (this as unknown as { configuration: { tools?: GrantedTool[] } })
            .configuration.tools ?? [];
        return EMPTY;
      },
    );
    try {
      const agent = await resolver(store, {
        id: "site-pm",
        name: "Site PM",
        type: "built_in",
        systemPrompt: "Run website builds.",
      }).resolveAgentForActor(ACTOR, "site-pm");
      await lastValueFrom(
        agent.run({
          threadId: "channel-thread",
          runId: "run-1",
          messages: [{ id: "ask", role: "user", content: "Check the build" }],
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
        }),
        { defaultValue: undefined },
      );
    } finally {
      spy.mockRestore();
    }
    const names = configured.map((tool) => tool.name);
    for (const name of FOLLOW_UPS) expect(count(names, name)).toBe(1);
    expect(count(names, vendorTool.name)).toBe(1);
    await toolNamed(configured, "schedule_follow_up").execute({
      reason: "Check the build",
      in_minutes: 10,
    });
    expect(scheduled[0]?.channelId).toBe("channel-1");
  });
});

describe("the follow-up runner wakes where it was scheduled", () => {
  const channel = (
    id: string,
    threadId: string,
    agentIds: string[],
  ): AgentChannel => ({
    id,
    name: id,
    agentIds,
    threadId,
    active: true,
    lastMessageAt: null,
  });

  function runner(payload: WakeUpPayload, scheduledFrom: AgentChannel | null) {
    const turns: string[] = [];
    const recorded: string[] = [];
    const notified: string[] = [];
    const looked: string[] = [];
    const wake = createWakeUpRunner({
      queue: {
        claim: async () => [
          { kind: "bot.wakeup", key: "w1", payload, attempts: 1 },
        ],
        finish: async () => true,
        purge: async () => 0,
      },
      store: { settle: async () => {} } as never,
      owner: "replica",
      actorFor: async (id) => ({ id, role: "user" }),
      channels: {
        get: async (_actor, id) => {
          looked.push(id);
          return scheduledFrom;
        },
        direct: async () =>
          channel("direct-channel", "direct-thread", [payload.agentId]),
        recordActivity: async (_actor, channelId) =>
          void recorded.push(channelId),
      },
      runTurn: async (input) => {
        turns.push(input.threadId);
        return { replyText: "Two of three demos are ready." };
      },
      notify: async (scope) => void notified.push(scope.channelId),
    });
    return { wake, turns, recorded, notified, looked };
  }

  const payload: WakeUpPayload = {
    ownerUserId: ACTOR.id,
    agentId: "site-pm",
    reason: "Check the demo builds",
    dueAt: new Date().toISOString(),
    scheduledAt: new Date().toISOString(),
  };

  test("in the channel it was scheduled from, while the Bot is in it", async () => {
    const f = runner(
      { ...payload, channelId: "channel-1" },
      channel("channel-1", "channel-thread", ["site-pm", "outreach"]),
    );
    expect(await f.wake.sweep()).toEqual({ ran: ["w1"], skipped: [] });
    expect(f.turns).toEqual(["channel-thread"]);
    expect(f.recorded).toEqual(["channel-1"]);
    expect(f.notified).toEqual(["channel-1"]);
  });

  test("in the direct conversation once the Bot has been taken out of that channel", async () => {
    const f = runner(
      { ...payload, channelId: "channel-1" },
      channel("channel-1", "channel-thread", ["outreach"]),
    );
    await f.wake.sweep();
    expect(f.turns).toEqual(["direct-thread"]);
    expect(f.recorded).toEqual(["direct-channel"]);
  });

  test("in the direct conversation when the channel is gone or the person left it", async () => {
    const f = runner({ ...payload, channelId: "channel-1" }, null);
    await f.wake.sweep();
    expect(f.turns).toEqual(["direct-thread"]);
  });

  test("in the direct conversation, without looking, when none was recorded", async () => {
    const f = runner(payload, channel("channel-1", "channel-thread", []));
    await f.wake.sweep();
    expect(f.looked).toEqual([]);
    expect(f.turns).toEqual(["direct-thread"]);
  });
});
