import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import type { ApprovalInboxData } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * A server tool the gate is holding draws its decision in the conversation.
 *
 * An MCP call has no renderer of its own, so the transcript draws it as a plain tool line. When the
 * server holds one — a safety hand-off, a rule that asks — the call has no result until somebody
 * decides, and the line is all the person watching can see. These pin that the card is on that line,
 * that deciding there is the one decision, and that a call which already answered draws no card.
 */

const HELD_CALL = "toolu_held_video";

function inboxWith(status: string): ApprovalInboxData {
  return {
    enabled: false,
    requests: [
      {
        id: "request-video",
        status,
        createdAt: "2026-10-27T12:13:01.231Z",
        action: {
          botId: "general-assistant",
          toolRef: "social-video/validate_social_script",
          effect: "write",
          scope: "social-video",
          threadId: "thread-1",
          toolCallId: HELD_CALL,
          args: { script: { title: "Retyping data slows you down" } },
          target: { serverId: "social-video" },
          policy: {
            behaviour: "hand_off",
            source: "safety",
            reason:
              "Paying, purchasing or moving money is always done by the person.",
          },
        },
      },
    ],
    rules: [],
    teamRules: [],
    questions: [],
  };
}

let inbox: ApprovalInboxData = inboxWith("pending");
let sent: { path: string; method?: string; body?: unknown }[] = [];
let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    sent.push({
      path,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return Promise.resolve().then(() =>
      path.endsWith("/api/approvals")
        ? Response.json(inbox)
        : Response.json({ ok: true }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  inbox = inboxWith("pending");
  sent = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

function conversation(result?: string): Message[] {
  return [
    {
      id: "u1",
      role: "user",
      content: "Make a short social video about retyping data between tools.",
    },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: HELD_CALL,
          type: "function",
          function: {
            name: "mcp__social-video__validate_social_script",
            arguments: '{"script":{"title":"Retyping data slows you down"}}',
          },
        },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: "t1",
            role: "tool" as const,
            toolCallId: HELD_CALL,
            content: result,
          },
        ]),
  ];
}

/** The real provider, with no runtime behind it: an MCP call has no renderer registered in it. */
function renderTranscript(messages: Message[]) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChatTranscript messages={messages} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("a held MCP call draws its hand-off card on its own line, and deciding there sends the decision", async () => {
  const view = renderTranscript(conversation());

  const card = await view.findByRole("region", {
    name: "Waiting for your approval",
  });
  expect(card.textContent).toContain("This needs you");
  expect(card.textContent).toContain(
    "Paying, purchasing or moving money is always done by the person.",
  );
  expect(view.getByRole("button", { name: "I did it myself" })).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Don't do it" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-video/decision",
      method: "POST",
      body: { decision: "deny" },
    }),
  );
});

test("a call that already answered draws no card, even beside a request for it", async () => {
  const view = renderTranscript(conversation('{"ok":true}'));
  await settleReactWork();
  expect(
    view.queryByRole("region", { name: "Waiting for your approval" }),
  ).toBeNull();
});

test("a decided request draws no card for a call still without its result", async () => {
  inbox = inboxWith("denied");
  const view = renderTranscript(conversation());
  await waitFor(() =>
    expect(sent.some((entry) => entry.path.endsWith("/api/approvals"))).toBe(
      true,
    ),
  );
  await settleReactWork();
  expect(
    view.queryByRole("region", { name: "Waiting for your approval" }),
  ).toBeNull();
});
