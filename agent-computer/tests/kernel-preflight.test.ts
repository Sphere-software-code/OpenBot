import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type PreflightTiming, preflightKernel } from "../src/kernel-preflight";

/**
 * Clearing what would stop Playwright attaching to a kernel browser.
 *
 * `connectOverCDP` waits for every page to answer, so a page showing a dialog that opened while
 * nothing was connected holds every connect until it times out. The preflight finds such pages over
 * the browser's own socket and sends them to about:blank, or closes them when that does not work.
 *
 * Driven against a fake browser rather than a real one, because the cases worth testing are pages
 * that will not answer, and a fake can be made to stay silent on cue. Verified against a real kernel
 * separately: a dialog opened with nobody connected blocks the connect, and navigating its page away
 * or closing the tab clears it.
 */

/** Short enough that a page made to hang costs seconds, long enough for a busy machine to answer. */
const QUICK: Partial<PreflightTiming> = {
  budgetMs: 15_000,
  requestMs: 1_000,
  answerMs: 1_000,
  settleMs: 1_500,
  pollMs: 250,
};

/** How each fake page treats a question: answer it, or stay silent until navigated, or forever. */
type Behaviour =
  | "answers"
  | "after-navigating"
  | "after-navigating-twice"
  | "never";

type FakePage = {
  targetId: string;
  url: string;
  behaviour: Behaviour;
  navigations: number;
};

/**
 * A browser that speaks just enough CDP for the preflight, with pages that behave as told.
 *
 * Its `/json/version` names a host nobody can reach, as kernel's API may, so a preflight that took
 * that address at its word would fail every case here.
 */
function fakeKernel(pages: { url: string; behaviour: Behaviour }[]) {
  let counter = 0;
  const open = new Map<string, FakePage>();
  const sessions = new Map<string, string>();
  const calls: string[] = [];
  let emptied = false;
  for (const page of pages) {
    counter += 1;
    const targetId = `page-${counter}`;
    open.set(targetId, { targetId, navigations: 0, ...page });
  }
  const answering = (page: FakePage) =>
    page.behaviour === "answers" ||
    (page.behaviour === "after-navigating" && page.navigations >= 1) ||
    (page.behaviour === "after-navigating-twice" && page.navigations >= 2);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/json/version") {
        return Response.json({
          Browser: "Chrome/152.0.0.0",
          webSocketDebuggerUrl:
            "ws://kernel-elsewhere.invalid:9222/devtools/browser/fake",
        });
      }
      if (pathname === "/devtools/browser/fake" && server.upgrade(request)) {
        return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const { id, method, params, sessionId } = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params: { targetId?: string; url?: string };
          sessionId?: string;
        };
        calls.push(method);
        const reply = (result: object) =>
          socket.send(JSON.stringify({ id, result, sessionId }));
        const refuse = (message: string) =>
          socket.send(
            JSON.stringify({ id, error: { code: -32000, message }, sessionId }),
          );
        const page = open.get(sessions.get(sessionId ?? "") ?? "");
        switch (method) {
          case "Target.getTargets":
            return reply({
              targetInfos: [
                ...[...open.values()].map(({ targetId, url }) => ({
                  targetId,
                  type: "page",
                  url,
                  title: "",
                  attached: false,
                })),
                // Kernel's own toolbar is a target too, and not a page anybody browses.
                {
                  targetId: "toolbar",
                  type: "browser_ui",
                  url: "chrome://webui-toolbar.top-chrome/",
                  title: "",
                  attached: false,
                },
              ],
            });
          case "Target.attachToTarget": {
            if (!open.has(params.targetId ?? ""))
              return refuse("No target with given id found");
            counter += 1;
            sessions.set(`session-${counter}`, params.targetId ?? "");
            return reply({ sessionId: `session-${counter}` });
          }
          case "Runtime.evaluate":
            // A blocked page says nothing at all, which is what a dialog nobody answers looks like.
            if (page && answering(page))
              reply({ result: { type: "number", value: 1, description: "1" } });
            return;
          case "Page.navigate":
            if (!page) return refuse("Not attached to an active page");
            page.navigations += 1;
            return reply({ frameId: page.targetId, loaderId: `loader-${id}` });
          case "Target.createTarget": {
            counter += 1;
            const targetId = `page-${counter}`;
            open.set(targetId, {
              targetId,
              url: params.url ?? "",
              behaviour: "answers",
              navigations: 0,
            });
            return reply({ targetId });
          }
          case "Target.closeTarget":
            if (!open.delete(params.targetId ?? ""))
              return refuse("No target with given id found");
            // Chromium exits when its last page closes, so this is the failure being guarded.
            if (open.size === 0) emptied = true;
            return reply({ success: true });
          default:
            return reply({});
        }
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    open,
    calls,
    emptied: () => emptied,
    stop: () => server.stop(true),
  };
}

let logged: ReturnType<typeof spyOn<Console, "info">>;
const preflightLines = () =>
  logged.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => line.type === "computer-kernel-preflight");

let stops: (() => void)[] = [];
beforeEach(() => {
  logged = spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  logged.mockRestore();
  for (const stop of stops) stop();
  stops = [];
});
const started = (pages: { url: string; behaviour: Behaviour }[]) => {
  const kernel = fakeKernel(pages);
  stops.push(kernel.stop);
  return kernel;
};

const ALERT_PAGE = "data:text/html,<title>ALERTPAGE</title>";

describe("the kernel preflight", () => {
  test("leaves a healthy browser alone and says nothing about it", async () => {
    const kernel = started([
      { url: "https://example.com/", behaviour: "answers" },
    ]);

    const found = await preflightKernel(kernel.url, "bot", QUICK);

    expect(found).toMatchObject({
      pages: 1,
      unstuck: [],
      closed: [],
      unresponsive: [],
    });
    // Reached through the address it was given, not the unreachable one the browser named.
    expect(found.error).toBeUndefined();
    // Asked once, because it answered; asked nothing else.
    expect(kernel.calls.filter((m) => m === "Runtime.evaluate")).toHaveLength(
      1,
    );
    expect(kernel.calls).not.toContain("Page.navigate");
    expect(kernel.calls).not.toContain("Target.closeTarget");
    // A healthy connect costs no log line.
    expect(preflightLines()).toEqual([]);
  }, 30_000);

  test("sends a page that only answers once navigated to about:blank, and keeps it", async () => {
    const kernel = started([
      { url: "https://example.com/", behaviour: "answers" },
      { url: ALERT_PAGE, behaviour: "after-navigating" },
    ]);

    const found = await preflightKernel(kernel.url, "bot", QUICK);

    expect(found).toMatchObject({
      pages: 2,
      unstuck: [ALERT_PAGE],
      closed: [],
      unresponsive: [],
    });
    expect(kernel.open.size).toBe(2);
    expect(kernel.calls).not.toContain("Target.closeTarget");
    const [line, ...rest] = preflightLines();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      type: "computer-kernel-preflight",
      botId: "bot",
      pages: 2,
      unstuck: [ALERT_PAGE],
      closed: [],
      unresponsive: [],
    });
    expect(typeof line?.ms).toBe("number");
    expect(line).not.toHaveProperty("error");
  }, 30_000);

  test("gives a page a second navigation when the first does not clear it", async () => {
    const kernel = started([
      { url: ALERT_PAGE, behaviour: "after-navigating-twice" },
    ]);

    const found = await preflightKernel(kernel.url, "bot", QUICK);

    expect(found.unstuck).toEqual([ALERT_PAGE]);
    expect(found.closed).toEqual([]);
    expect(kernel.calls.filter((m) => m === "Page.navigate")).toHaveLength(2);
  }, 30_000);

  test("closes a page that never answers, after trying two navigations", async () => {
    const kernel = started([
      { url: "https://example.com/", behaviour: "answers" },
      { url: ALERT_PAGE, behaviour: "never" },
    ]);

    const found = await preflightKernel(kernel.url, "bot", QUICK);

    expect(found).toMatchObject({
      pages: 2,
      unstuck: [],
      closed: [ALERT_PAGE],
      unresponsive: [],
    });
    expect(kernel.calls.filter((m) => m === "Page.navigate")).toHaveLength(2);
    // Another page stays open, so no blank one is needed.
    expect(kernel.calls).not.toContain("Target.createTarget");
    expect([...kernel.open.values()].map((page) => page.url)).toEqual([
      "https://example.com/",
    ]);
    expect(preflightLines()[0]).toMatchObject({ closed: [ALERT_PAGE] });
  }, 30_000);

  test("opens a blank tab before closing the only page, so Chromium does not exit", async () => {
    const kernel = started([{ url: ALERT_PAGE, behaviour: "never" }]);

    const found = await preflightKernel(kernel.url, "bot", QUICK);

    expect(found.closed).toEqual([ALERT_PAGE]);
    const created = kernel.calls.indexOf("Target.createTarget");
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(kernel.calls.indexOf("Target.closeTarget"));
    expect(kernel.emptied()).toBe(false);
    expect([...kernel.open.values()].map((page) => page.url)).toEqual([
      "about:blank",
    ]);
  }, 30_000);

  test("keeps a blank tab open when every page is stuck", async () => {
    // Counted from what is open when it closes, so the last stuck page is not closed into nothing.
    const kernel = started([
      { url: `${ALERT_PAGE}1`, behaviour: "never" },
      { url: `${ALERT_PAGE}2`, behaviour: "never" },
    ]);

    const found = await preflightKernel(kernel.url, "bot", QUICK);

    expect(found.closed.sort()).toEqual([`${ALERT_PAGE}1`, `${ALERT_PAGE}2`]);
    expect(kernel.emptied()).toBe(false);
    expect([...kernel.open.values()].map((page) => page.url)).toEqual([
      "about:blank",
    ]);
  }, 30_000);

  test("returns, without throwing, when /json/version cannot be reached", async () => {
    // A port that was listening a moment ago and is not now.
    const gone = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    const url = `http://127.0.0.1:${gone.port}`;
    gone.stop(true);

    const found = await preflightKernel(url, "bot", QUICK);

    expect(found.pages).toBe(0);
    expect(found.error).toBeString();
    expect(preflightLines()[0]).toMatchObject({
      type: "computer-kernel-preflight",
      botId: "bot",
      pages: 0,
      error: found.error,
    });
  }, 30_000);

  test("gives up on a /json/version that never answers, inside its allowance", async () => {
    const silent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => undefined),
    });
    stops.push(() => silent.stop(true));
    const startedAt = Date.now();

    const found = await preflightKernel(
      `http://127.0.0.1:${silent.port}`,
      "bot",
      QUICK,
    );

    expect(found.error).toBeString();
    // The one-second allowance for the request, with room for a busy machine.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);

  test("stops at its budget, and closes nothing it had no time to try", async () => {
    const kernel = started([{ url: ALERT_PAGE, behaviour: "never" }]);
    const startedAt = Date.now();

    const found = await preflightKernel(kernel.url, "bot", {
      ...QUICK,
      budgetMs: 1_500,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_500 + 1_000);
    expect(found.unresponsive).toEqual([ALERT_PAGE]);
    expect(found.closed).toEqual([]);
    expect(kernel.calls).not.toContain("Target.closeTarget");
    expect(kernel.open.size).toBe(1);
  }, 30_000);
});
