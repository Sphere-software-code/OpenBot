/**
 * The network a Bot's computer shares with its kernel browser, from `COMPUTER_KERNEL_NETWORK`.
 *
 * A computer built with the kernel backend drives a browser in another container, `kernel-<botId>`,
 * which it reaches by name on a network only the two of them share. Those networks are made outside
 * OpenBot, so a computer this supervisor created (a new Bot, a reset, an image or token change) came
 * up on none of them: it could not resolve its kernel, and every browser action failed until
 * something reconnected it.
 *
 * Derived like every other name the supervisor uses, never named by a caller. `{bot}` stands for the
 * Bot id, which `namesFor` has already validated, the same placeholder the computer's own
 * `COMPUTER_KERNEL_CDP_URL` uses. Unset or blank is `<namespace>-kernel-{bot}`, and `off` joins
 * nothing. Anything else must contain `{bot}`, so each Bot still gets a network of its own and no
 * setting can put every computer on one, and is otherwise held to the namespace's character rules.
 * Like `COMPUTER_NETWORK`, what it names is the deployment's responsibility.
 *
 * Kept out of `index.ts`, which exits at import without its environment, so a test can reach it.
 */

/** The rule `names.ts` holds a Bot id and a namespace to. */
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function kernelNetworkTemplate(
  raw: string | undefined,
  namespace: string,
): { ok: true; template: string | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, template: `${namespace}-kernel-{bot}` };
  if (trimmed === "off") return { ok: true, template: undefined };
  // Checked with a stand-in id. A real one starts with a letter or digit and adds nothing this rule
  // refuses, so a template that passes here gives a valid name for every Bot.
  if (
    !trimmed.includes("{bot}") ||
    !ALLOWED.test(trimmed.replaceAll("{bot}", "a"))
  ) {
    return {
      ok: false,
      reason: `COMPUTER_KERNEL_NETWORK must be off, or a network name containing {bot} and otherwise only letters, digits, hyphen and underscore (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, template: trimmed };
}

/** This Bot's kernel network under a template from {@link kernelNetworkTemplate}, or none. */
export function kernelNetworkFor(
  template: string | undefined,
  botId: string,
): string | undefined {
  return template?.replaceAll("{bot}", botId);
}
