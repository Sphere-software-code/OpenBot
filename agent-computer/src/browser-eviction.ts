/**
 * Which Bots' browsers to close, and when.
 *
 * Its own file, with no Playwright import, for the reason `authorisation.ts` and `bot-id.ts` are:
 * `profiles.ts` imports Playwright at module scope, so anything living there needs a browser merely
 * to be imported by a test. A decision this size should be testable without one, and `profiles.ts`
 * owns the launching, so a test that went through it would be testing Playwright rather than the
 * choice being made.
 *
 * The choice is worth testing on its own. There was no cap and no timeout: a context was started the
 * first time each Bot was used and kept, and the only things that dropped one were an explicit stop,
 * a browser that had already died, and shutdown. A deployment where every employee has a Bot trends
 * toward one resident Chromium per employee in a single container, at a few hundred MB each, until
 * it is killed for memory and relaunches its way back to the same state.
 *
 * Closing one loses nothing. The profile is on disk, so the Bot's logins survive and its next request
 * starts where it left off, which is already what `stop` means here.
 */

import type { BrowserRuntime } from "./browser-runtime";
import { numberFromEnv } from "./env";

/** Enough of a live entry for either decision. Keeps this file independent of what else is on one. */
export type Evictable = { usedAt: number };

/**
 * Which to close because there are too many running.
 *
 * Least recently used first: the Bot that has been quiet longest. Applied after a launch, so the Bot
 * that just asked is the most recently used and is therefore never the one closed.
 */
export function chooseEvictions(
  running: Iterable<[string, Evictable]>,
  max: number,
): string[] {
  const entries = [...running];
  if (entries.length <= max) return [];

  return entries
    .sort(([, a], [, b]) => a.usedAt - b.usedAt)
    .slice(0, entries.length - max)
    .map(([botId]) => botId);
}

/**
 * Which to close because nothing has touched them.
 *
 * The other half of the answer: a deployment under the cap still holds a browser for a Bot used once
 * last Tuesday, and that memory is doing nothing for anybody. A timeout of zero or less switches this
 * off, so a deployment can keep browsers resident if it would rather.
 */
export function chooseIdle(
  running: Iterable<[string, Evictable]>,
  idleTimeoutMs: number,
  now: number,
): string[] {
  if (idleTimeoutMs <= 0) return [];
  const cutoff = now - idleTimeoutMs;

  return [...running]
    .filter(([, entry]) => entry.usedAt <= cutoff)
    .map(([botId]) => botId);
}

/**
 * How long a browser may sit untouched before the sweep closes it, where zero means never.
 *
 * Thirty minutes for a browser this process starts, for the reason above: it holds a few hundred MB
 * here, and the profile on disk brings the Bot back where it left off.
 *
 * Never, by default, for a kernel browser, because closing one frees nothing and costs a great
 * deal. Chromium and its tabs keep running in kernel's container, so all a close drops is the CDP
 * connection. Dropping it interrupts the Bot's run, and its next action is refused until it takes a
 * fresh snapshot. If a person held control at that moment, the Bot refuses every action until
 * somebody takes control and hands it back. While nothing is connected, a page that opens a
 * JavaScript dialog blocks every later connect, where a connected Playwright would have dismissed
 * it. And reconnecting to a kernel the host has partly swapped out takes several seconds.
 *
 * `COMPUTER_BROWSER_IDLE_MS` still decides when an operator has set it, on either backend.
 */
export function idleTimeoutMsFor(backend: BrowserRuntime["backend"]): number {
  return numberFromEnv(
    "COMPUTER_BROWSER_IDLE_MS",
    backend === "kernel" ? 0 : 30 * 60_000,
    { zeroSwitchesItOff: true },
  );
}
