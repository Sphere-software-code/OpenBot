/**
 * Clear what would stop Playwright attaching to a kernel browser, before it tries.
 *
 * `connectOverCDP` returns only once every open page has answered it, so one page that cannot
 * answer holds the connect until it times out, and the next connect, and every one after that. A
 * page showing a JavaScript dialog (alert, confirm, prompt) that opened while nothing was connected
 * is such a page. A connected Playwright dismisses dialogs as they open; between connections nobody
 * does, and the page waits for an answer that never comes. A new CDP session cannot give it one:
 * enabling the Page domain does not announce a dialog that was already showing, and
 * `Page.handleJavaScriptDialog` answers that none is. Sending the page to about:blank does clear
 * it, though not always at the first attempt, and closing the tab always works.
 *
 * So every page is asked to evaluate `1`, twice, so that a page busy for a moment is not taken for
 * a blocked one. A page that answers neither is sent to about:blank, at most twice, and given ten
 * seconds each time to answer again. One that still does not is closed, after a blank tab is
 * opened if closing it would leave none: Chromium exits when its last page closes, and its tabs and
 * session cookies go with it.
 *
 * Over the browser's own WebSocket rather than through Playwright, because Playwright is what
 * cannot attach. Its own file, with no Playwright import, so a test can drive it against a fake CDP
 * server. Bounded, and it never throws: whatever it could not clear, the connect that follows still
 * runs and reports its own failure.
 */

/** What the preflight found and what it did, naming each page by the address it was on. */
export type KernelPreflight = {
  /** How many pages the browser had open. */
  pages: number;
  /** Pages that answered again once sent to about:blank. */
  unstuck: string[];
  /** Pages closed because nothing else made them answer. */
  closed: string[];
  /** Pages that still do not answer, including any the time ran out on. */
  unresponsive: string[];
  ms: number;
  /** Why it could not look at the pages, or stopped before it was done. Absent otherwise. */
  error?: string;
};

/**
 * How long each step may take.
 *
 * The defaults keep the whole preflight inside about forty-five seconds: ten for the two questions,
 * up to fifteen for each of two navigations, and five held back to close what those did not clear.
 * The pages are handled side by side, so that bound does not grow with the number of tabs. A test
 * passes shorter ones rather than wait that long on a page it made unresponsive itself.
 */
export type PreflightTiming = {
  /** The whole preflight. No step runs past it. */
  budgetMs: number;
  /** Each request that is not a question to a page: version, socket, attach, navigate, close. */
  requestMs: number;
  /** Each of the two first questions to a page. */
  answerMs: number;
  /** How long a page sent to about:blank is given to answer again. */
  settleMs: number;
  /** Each question asked while it settles. */
  pollMs: number;
};

export const PREFLIGHT_TIMING: PreflightTiming = {
  budgetMs: 45_000,
  requestMs: 5_000,
  answerMs: 5_000,
  settleMs: 10_000,
  pollMs: 2_000,
};

/** How much of a page's address is kept, which is enough to recognise it in a log line. */
const ADDRESS_LIMIT = 200;

type TargetInfo = { targetId: string; type: string; url: string };

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  ms?: number,
) => Promise<T>;

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** `work`, or a rejection naming `what` once `ms` has passed. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${ms} ms.`)),
      Math.max(0, ms),
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The browser's own WebSocket address.
 *
 * kernel's API fills in the host of `webSocketDebuggerUrl` itself, and that need not be an address
 * this container can reach. The path is what identifies the browser, so it is joined to the address
 * that was reached.
 */
async function browserSocketUrl(cdpUrl: string, ms: number): Promise<string> {
  if (/^wss?:/i.test(cdpUrl)) return cdpUrl;
  const reached = new URL(cdpUrl);
  const versionUrl = new URL(reached);
  versionUrl.pathname = `${reached.pathname.replace(/\/+$/, "")}/json/version`;
  const version = await within(
    fetch(versionUrl, { signal: AbortSignal.timeout(ms) }).then((response) => {
      if (!response.ok)
        throw new Error(`GET ${versionUrl} answered ${response.status}.`);
      return response.json() as Promise<{ webSocketDebuggerUrl?: unknown }>;
    }),
    ms,
    `GET ${versionUrl}`,
  );
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error(`GET ${versionUrl} named no browser socket.`);
  }
  const named = new URL(version.webSocketDebuggerUrl);
  const scheme = reached.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${reached.host}${named.pathname}${named.search}`;
}

function openSocket(url: string, ms: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`The browser socket did not open within ${ms} ms.`));
    }, ms);
    const failed = () => {
      clearTimeout(timer);
      reject(new Error(`The browser socket at ${url} could not be opened.`));
    };
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        resolve(socket);
      },
      { once: true },
    );
  });
}

/**
 * CDP requests over `socket`, each bounded by its own allowance and by `deadline`.
 *
 * A request still unanswered when the socket closes fails at once rather than waiting on its timer.
 */
function requestsOver(
  socket: WebSocket,
  deadline: number,
  defaultMs: number,
): Send {
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    let message: {
      id?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiter =
      typeof message.id === "number" ? waiting.get(message.id) : undefined;
    if (!waiter) return;
    waiting.delete(message.id as number);
    if (message.error)
      waiter.reject(new Error(message.error.message ?? "CDP error"));
    else waiter.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => {
    for (const waiter of waiting.values())
      waiter.reject(new Error("The browser socket closed."));
    waiting.clear();
  });

  return <T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    ms = defaultMs,
  ) =>
    new Promise<T>((resolve, reject) => {
      const allowed = Math.min(ms, deadline - Date.now());
      if (allowed <= 0) {
        reject(new Error(`No time was left for ${method}.`));
        return;
      }
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} was not answered within ${allowed} ms.`));
      }, allowed);
      waiting.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        waiting.get(id)?.reject(new Error(reason(error)));
        waiting.delete(id);
      }
    });
}

async function clearPages(
  send: Send,
  found: KernelPreflight,
  timing: PreflightTiming,
  deadline: number,
): Promise<void> {
  const openPages = async () =>
    (
      await send<{ targetInfos: TargetInfo[] }>("Target.getTargets")
    ).targetInfos.filter((target) => target.type === "page");
  const answers = (sessionId: string, ms: number) =>
    send(
      "Runtime.evaluate",
      { expression: "1", returnByValue: true },
      sessionId,
      ms,
    ).then(
      () => true,
      () => false,
    );

  const pages = await openPages();
  found.pages = pages.length;

  // Every page at once, so a tab that does not answer does not spend the time the next one needs.
  const checked = await Promise.all(
    pages.map(async (page) => {
      const address = page.url.slice(0, ADDRESS_LIMIT);
      const sessionId = await send<{ sessionId: string }>(
        "Target.attachToTarget",
        {
          targetId: page.targetId,
          flatten: true,
        },
      ).then(
        (attached) => attached.sessionId,
        () => undefined,
      );
      // Twice, so a page that is merely busy for a moment is not taken for a blocked one.
      const answering =
        sessionId !== undefined &&
        ((await answers(sessionId, timing.answerMs)) ||
          (await answers(sessionId, timing.answerMs)));
      return { page, address, sessionId, answering };
    }),
  );

  // Held back so a page the navigations did not clear can still be closed inside the budget.
  const navigateBy = deadline - timing.requestMs;
  const sendAway = async (sessionId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (Date.now() >= navigateBy) break;
      await send(
        "Page.navigate",
        { url: "about:blank" },
        sessionId,
        Math.min(timing.requestMs, navigateBy - Date.now()),
      ).catch(() => undefined);
      const settleBy = Math.min(Date.now() + timing.settleMs, navigateBy);
      while (Date.now() < settleBy) {
        const askedAt = Date.now();
        const allowed = Math.min(timing.pollMs, settleBy - askedAt);
        if (await answers(sessionId, allowed)) return true;
        // A refusal comes back at once, so the rest of the interval passes before asking again.
        await sleep(Math.min(askedAt + timing.pollMs, settleBy) - Date.now());
      }
    }
    return false;
  };

  const stuck = checked.filter((page) => !page.answering);
  // A page that could not be attached to cannot be navigated either. The connect will report it.
  for (const page of stuck)
    if (page.sessionId === undefined) found.unresponsive.push(page.address);
  const blocked = stuck.filter((page) => page.sessionId !== undefined);
  const cleared = await Promise.all(
    blocked.map((page) => sendAway(page.sessionId as string)),
  );
  const closing = blocked.filter((page, index) => {
    if (cleared[index]) found.unstuck.push(page.address);
    return !cleared[index];
  });
  if (closing.length === 0) return;

  // Never the last page, which would take Chromium down with it. Counted again rather than from the
  // list above, because tabs may have opened or closed while this ran.
  const leaving = new Set(closing.map((page) => page.page.targetId));
  const staying = await openPages().then(
    (now) => now.filter((target) => !leaving.has(target.targetId)).length,
    () => 0,
  );
  if (staying === 0) {
    const opened = await send("Target.createTarget", {
      url: "about:blank",
    }).then(
      () => true,
      () => false,
    );
    if (!opened) {
      for (const page of closing) found.unresponsive.push(page.address);
      return;
    }
  }
  for (const page of closing) {
    const closed = await send("Target.closeTarget", {
      targetId: page.page.targetId,
    }).then(
      () => true,
      () => false,
    );
    (closed ? found.closed : found.unresponsive).push(page.address);
  }
}

/**
 * Make every page of the kernel browser at `cdpUrl` answer, or close the ones that will not.
 *
 * Resolves with what it found and did, never rejects, and takes no longer than the budget. Logs
 * only when it changed something or could not look, so a healthy connect costs no line.
 */
export async function preflightKernel(
  cdpUrl: string,
  botId: string,
  timing: Partial<PreflightTiming> = {},
): Promise<KernelPreflight> {
  const limits = { ...PREFLIGHT_TIMING, ...timing };
  const startedAt = Date.now();
  const deadline = startedAt + limits.budgetMs;
  const found: KernelPreflight = {
    pages: 0,
    unstuck: [],
    closed: [],
    unresponsive: [],
    ms: 0,
  };
  let socket: WebSocket | undefined;
  let over = false;
  const work = (async () => {
    const url = await browserSocketUrl(cdpUrl, limits.requestMs);
    socket = await openSocket(
      url,
      Math.max(0, Math.min(limits.requestMs, deadline - Date.now())),
    );
    if (over) {
      socket.close();
      return;
    }
    await clearPages(
      requestsOver(socket, deadline, limits.requestMs),
      found,
      limits,
      deadline,
    );
  })();
  try {
    // Every step is bounded by the deadline already. This guarantees that nothing outlives it.
    await within(work, deadline - Date.now() + 1_000, "The preflight");
  } catch (error) {
    found.error = reason(error);
  } finally {
    over = true;
    socket?.close();
  }
  found.ms = Date.now() - startedAt;
  if (
    found.error ||
    found.unstuck.length ||
    found.closed.length ||
    found.unresponsive.length
  ) {
    console.info(
      JSON.stringify({
        type: "computer-kernel-preflight",
        botId,
        pages: found.pages,
        unstuck: found.unstuck,
        closed: found.closed,
        unresponsive: found.unresponsive,
        ms: found.ms,
        ...(found.error ? { error: found.error } : {}),
      }),
    );
  }
  return found;
}
