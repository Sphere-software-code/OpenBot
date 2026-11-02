/**
 * The conversation AG-UI carries, as LangChain's message classes.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at module
 * scope, so importing it to reach one pure function binds a port. `agent-computer/src/control.ts`
 * was split out for the same reason, to keep state-machine tests away from a browser.
 */
import type { RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { COMPUTER_GUIDANCE, NO_ANSWER_CAME } from "../../shared/bot-prompt";
import { userContent } from "../../shared/user-content";

/*
 * Re-exported so this module's own tests and callers keep reading it from here, while the wording
 * itself lives in `shared` where the other Bot can reach it. Both have to say the same thing.
 */
export { NO_ANSWER_CAME };

/**
 * The providers that take one system prompt, and take it first.
 *
 * Anthropic's Messages API has the system prompt as a field of the request rather than as a turn,
 * and Gemini has it as `systemInstruction`, so neither integration has anywhere to put a second one:
 * `@langchain/anthropic` throws "System messages are only permitted as the first passed message."
 * and `@langchain/google-genai` throws "System message should be the first one", both before any
 * request is made. OpenAI takes a system turn anywhere in a conversation.
 */
const ONE_SYSTEM_PROMPT = new Set(["anthropic", "google"]);

/** Translate the conversation AG-UI carries into LangChain's message classes. */
export function toLangChainMessages(
  input: RunAgentInput,
  provider = "openai",
): BaseMessage[] {
  const messages: BaseMessage[] = [
    new SystemMessage(COMPUTER_GUIDANCE),
    // AG-UI carries application context separately from conversation history. CopilotKit puts
    // the A2UI catalog and tool instructions here; dropping it leaves the model guessing the
    // component schema and can strand the renderer on an invalid, never-painted surface.
    ...(input.context ?? []).map(
      ({ description, value }) => new SystemMessage(`${description}\n${value}`),
    ),
  ];

  /*
   * Which calls in this history were ever answered.
   *
   * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
   * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot
   * asks for the wheel to get past a sign-in and the person decides they do not need it after all —
   * no answer is ever carried, and the call stays in the history with nothing following it.
   *
   * OpenAI rejects that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
   * followed by tool messages responding to each 'tool_call_id'". So the conversation was not merely
   * stuck on that request, it was finished. Every later message failed the same way, and the only
   * escape was starting a new one, which loses it.
   *
   * Collected up front because an answer arrives as a later message than the call it answers.
   */
  const answered = new Set(
    input.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId?: string }).toolCallId)
      .filter((id): id is string => Boolean(id)),
  );

  /*
   * Tool results, by the call they answer.
   *
   * The history is not guaranteed to arrive with a result after the call it belongs to. Read back
   * from the durable thread store it arrives the other way round, result first, which is a payload
   * no provider accepts: a tool message with no preceding call, and then a call with nothing
   * following it. The model answers that with silence rather than an error, which is the worst of
   * both, so the pairing is rebuilt here instead of trusted.
   */
  const resultsByCall = new Map<string, string>();
  for (const message of input.messages) {
    if (message.role !== "tool") continue;
    const id = (message as { toolCallId?: string }).toolCallId;
    if (id) resultsByCall.set(id, String(message.content ?? ""));
  }
  /*
   * The one screenshot the model gets to see as a picture: the latest answered one. Every earlier
   * one is described in words instead, so a long review session costs a few hundred tokens per
   * screenshot rather than a million. See `shapeToolResult`.
   */
  let latestScreenshot: string | undefined;
  for (const message of input.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (
        call.id &&
        answered.has(call.id) &&
        callDetails(call).name === "computer_screenshot" &&
        screenshotOf(resultsByCall.get(call.id) ?? "")
      ) {
        latestScreenshot = call.id;
      }
    }
  }

  for (const message of input.messages) {
    // Placed with the call they answer, below, rather than wherever they arrived.
    if (message.role === "tool") continue;
    if (message.role === "user") {
      messages.push(
        new HumanMessage({ content: userContent(message.content) }),
      );
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push(new SystemMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "assistant") {
      messages.push(
        new AIMessage({
          content: message.content ?? "",
          tool_calls:
            message.toolCalls?.map((call) => ({
              id: call.id,
              name: callDetails(call).name,
              // LangChain wants parsed arguments where AG-UI carries the raw string. A call whose
              // arguments did not parse is passed as empty rather than dropped: the model needs to
              // see that it made the call, or it makes it again.
              args: parseArguments(callDetails(call).arguments),
            })) ?? [],
        }),
      );

      /*
       * Every call this message made, answered, immediately after it.
       *
       * The real result where there is one, wherever it arrived in the input, and `NO_ANSWER_CAME`
       * where there is not. Both cases are the same requirement: a call must be followed by its
       * result, and the provider rejects the message outright otherwise.
       */
      for (const call of message.toolCalls ?? []) {
        if (!call.id) continue;
        const raw = resultsByCall.get(call.id) ?? "";
        messages.push(
          new ToolMessage({
            tool_call_id: call.id,
            content: answered.has(call.id)
              ? shapeToolResult(raw, call.id === latestScreenshot)
              : NO_ANSWER_CAME,
            name: callDetails(call).name,
          }),
        );
        const shot = call.id === latestScreenshot ? screenshotOf(raw) : null;
        if (shot && showable(shot)) {
          // A user-role turn straight after the tool result; the providers that take one user
          // turn at a time merge the two, and all three read an image_url part.
          messages.push(
            new HumanMessage({
              content: [
                { type: "text", text: "The screenshot that call returned:" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${shot.base64}` },
                },
              ],
            }),
          );
        }
      }
    }
  }

  /*
   * A run that carries no human turn is answered by OpenAI and refused by the strict providers.
   *
   * OpenAI tolerates a history that opens on an assistant or tool message. Anthropic and the strict
   * OpenAI-compatible providers (z.ai GLM among them) require the first non-system message to be a
   * human one, and will not answer a history that is only deltas: an assistant turn and its tool
   * results with nothing a person said to respond to. A follow-up run continuing after a tool result
   * is exactly that shape, so on those providers it came back empty and the run ended in silence.
   *
   * A neutral continuation turn gives them one to answer. It is appended only when the history holds
   * no human turn at all, so a normal conversation is untouched, and OpenAI — which already answered
   * the same history — sees no change beyond one trailing line asking it to continue.
   */
  const hasHumanTurn = messages.some(
    (message): message is HumanMessage => message instanceof HumanMessage,
  );
  if (!hasHumanTurn) {
    messages.push(new HumanMessage(CONTINUE_TURN));
  }

  /*
   * Every run holds more than one system message, so on those providers every run failed.
   *
   * The computer guidance opens this list and the caller's context follows it, and the server puts a
   * coworker's standing role at the head of `input.messages` on every run it sends a remote Bot. A
   * skill somebody picks arrives as a system turn ahead of their message, too. So a Bot set to
   * `BOT_PROVIDER=anthropic` or `google` answered nothing at all: each run ended in the integration's
   * refusal, before the model was asked.
   *
   * Folded into one, in the order given, and only for those providers. On OpenAI a skill's
   * instruction stays beside the message it was picked for.
   */
  return ONE_SYSTEM_PROMPT.has(provider)
    ? withOneSystemPrompt(messages)
    : messages;
}

/** The continuation a strict provider needs when a run carries only deltas. See toLangChainMessages. */
const CONTINUE_TURN = "Continue from where the conversation above left off.";

/** Every system message's text as one system message at the top, and the rest as they were. */
function withOneSystemPrompt(messages: BaseMessage[]): BaseMessage[] {
  const system = messages.filter((message) => message instanceof SystemMessage);
  return [
    new SystemMessage(
      system.map((message) => String(message.content)).join("\n\n"),
    ),
    ...messages.filter((message) => !(message instanceof SystemMessage)),
  ];
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A tool call's name and arguments, in whichever dialect it arrived in.
 *
 * TWO SPELLINGS, ONE CALL. AG-UI describes `{id, type: "function", function: {name, arguments}}` and
 * the history store writes `{id, name, args}`. Read back from a thread, every call arrives in the
 * second, so `call.function.name` here did not merely degrade: it threw, and took the run with it.
 */
function callDetails(call: {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
  args?: unknown;
}): { name: string; arguments: string } {
  const name = call.function?.name ?? call.name;
  const args = call.function?.arguments ?? call.args;
  return {
    name: typeof name === "string" && name ? name : "tool",
    arguments:
      typeof args === "string"
        ? args
        : args === undefined || args === null
          ? "{}"
          : JSON.stringify(args),
  };
}

/**
 * WHY TOOL RESULTS ARE SHAPED BEFORE THE MODEL SEES THEM.
 *
 * A tool result travels as text. `computer_screenshot` answers with a PNG as base64, which is the
 * right shape for the transcript to draw and the wrong shape for a model to read: base64 tokenises
 * at close to a token per character, so one full-size screenshot is around a million tokens, and
 * every later turn sends it again. Found live: a Site PM review thread died with "prompt is too
 * long: 1156376 tokens" after a single screenshot, and stayed dead, because the thread keeps the
 * result. The picture still reaches the model, once, as an image part on the latest screenshot,
 * where it costs a few hundred to a few thousand tokens. Anything else that is plainly a base64
 * blob, and any result past a generous length, is cut with a note that says so.
 */
const MAX_TOOL_RESULT_CHARS = 120_000;
const BASE64_BLOB = /^[A-Za-z0-9+/\s]{4096,}={0,2}$/;
/** Anthropic refuses an image past 5 MB or 8000 px on a side; the others are no stricter. */
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024 * (4 / 3);
const MAX_IMAGE_SIDE = 8000;

type Screenshot = { base64: string; width: number; height: number };

function screenshotOf(raw: string): Screenshot | null {
  if (!raw.includes('"base64"')) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.base64 === "string" &&
      parsed.base64.length >= 64 &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number"
    ) {
      return {
        base64: parsed.base64,
        width: parsed.width,
        height: parsed.height,
      };
    }
  } catch {
    // Not JSON: not a screenshot.
  }
  return null;
}

function showable(shot: Screenshot): boolean {
  return (
    shot.base64.length <= MAX_IMAGE_BASE64_CHARS &&
    shot.width <= MAX_IMAGE_SIDE &&
    shot.height <= MAX_IMAGE_SIDE
  );
}

function kilobytes(base64: string): number {
  return Math.round((base64.length * 3) / 4 / 1024);
}

export function shapeToolResult(raw: string, latestScreenshot = false): string {
  const shot = screenshotOf(raw);
  let text = raw;
  if (shot) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const where = latestScreenshot
      ? showable(shot)
        ? "shown to you as an image right after this result"
        : "too large to show you; use computer_read or computer_snapshot instead"
      : "an earlier screenshot, no longer shown; take a new one if you need to look again";
    parsed.base64 = `[PNG ${shot.width}x${shot.height}, ${kilobytes(shot.base64)} KB; ${where}]`;
    text = JSON.stringify(parsed);
  } else if (raw.includes('"') || raw.includes("{")) {
    // Any other base64 blob riding inside a JSON result, whatever the field is called.
    try {
      const parsed = JSON.parse(raw) as unknown;
      let changed = false;
      const strip = (value: unknown): unknown => {
        if (typeof value === "string") {
          if (value.length >= 4096 && BASE64_BLOB.test(value)) {
            changed = true;
            return `[binary data omitted, ${kilobytes(value)} KB]`;
          }
          return value;
        }
        if (Array.isArray(value)) return value.map(strip);
        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
              k,
              strip(v),
            ]),
          );
        }
        return value;
      };
      const stripped = strip(parsed);
      if (changed) text = JSON.stringify(stripped);
    } catch {
      // Not JSON: left as it is, subject to the length cap below.
    }
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[result cut at ${MAX_TOOL_RESULT_CHARS} characters; ${text.length - MAX_TOOL_RESULT_CHARS} more were not shown]`;
  }
  return text;
}
