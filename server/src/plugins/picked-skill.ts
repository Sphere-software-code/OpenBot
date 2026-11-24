/**
 * The skill a person picked for a message, and the instructions the Bot is given for it.
 *
 * A skill is picked from the composer's `/` menu, which puts a chip at the start of the message
 * that is sent as `/<command>`. The Bot has to be told what that skill says, and it has to be told
 * by this server: the browser used to send the instructions as a system row of its own, and no Bot
 * read them as instructions. A built-in Bot's runtime drops every system row, and each harness this
 * deployment runs reads a system row that is not the server's own as conversation data, which is
 * right for anything a browser can write. On the Mac Desktop a person's "Pirate haiku" skill was
 * guessed at from its name, and the Bot, asked, said it had been given no instructions.
 *
 * So the server reads the command, checks it against the skills this Bot holds, and puts that
 * skill's stored instructions into the instructions it writes for the run itself: the built-in
 * prompt, or the standing role a remote Bot is sent. Nothing a request carries becomes an
 * instruction; a command only chooses among what the Bot already holds, as typing it does.
 */
import type { RunAgentInput } from "@ag-ui/client";
import { PICKED_SKILL_PROP } from "@openbot/toolkit/run-turn";
import { latestUserText } from "./selection";

export { PICKED_SKILL_PROP };

/** A skill as a run needs it: its command, its name, and what it tells the Bot. */
export type PickableSkill = {
  slug: string;
  title: string;
  instructions?: string;
};

/**
 * The command a message starts with, or undefined.
 *
 * Only at the very start, as the composer's `/` menu only opens there, and only a whole command
 * followed by a space, a line break or the end: "please /pirate-haiku" and "/pirate-haiku," are
 * words, not a pick. Lower-case letters, numbers and hyphens, the characters a command is made of.
 */
export function leadingSkillCommand(text: string): string | undefined {
  return /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(text)?.[1];
}

/**
 * The command this run was asked to use: the one a headless host stated for its turn, or the one
 * the person's latest message starts with. An earlier message's command is not this run's.
 */
export function pickedSkillCommand(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
): string | undefined {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  const stated = props?.[PICKED_SKILL_PROP];
  if (typeof stated === "string") return stated;
  return leadingSkillCommand(latestUserText(input.messages));
}

/**
 * The held skill a person typed by hand when no whole command matched (Sphere).
 *
 * The composer's menu filters as the slug is typed, and a person who then types straight on sends
 * `/research-a-branddrycleansavannah.com`, with no space; on the home screen the text starts with the
 * coworker's name, `@General Assistant /research-a-brand acme`. Both were sent as plain words and
 * the Bot answered that no such skill existed. So the leading token, after an optional `@` mention,
 * is matched against the slugs this Bot holds by prefix, longest first. A slug is specific enough
 * that a message starting with one and more letters is not a sentence anybody writes. A command a
 * headless host stated is that host's pick, and nothing is guessed beside it.
 */
function typedSkill(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  held: readonly PickableSkill[],
): PickableSkill | undefined {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  if (typeof props?.[PICKED_SKILL_PROP] === "string") return undefined;
  const token = /^\s*(?:@[^/\n]*?\s+)?\/(\S+)/.exec(
    latestUserText(input.messages),
  )?.[1];
  if (!token) return undefined;
  return held
    .filter(
      (candidate) =>
        candidate.slug.length > 0 && token.startsWith(candidate.slug),
    )
    .sort((a, b) => b.slug.length - a.slug.length)[0];
}

/**
 * What the Bot is told for the skill this run picked among the ones it holds, or undefined when it
 * picked none, picked one the Bot does not hold, or one with no instructions.
 */
export function pickedSkillGuidance(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  held: readonly PickableSkill[],
): string | undefined {
  const command = pickedSkillCommand(input);
  const skill =
    (command
      ? held.find((candidate) => candidate.slug === command)
      : undefined) ?? typedSkill(input, held);
  const instructions = skill?.instructions?.trim();
  if (!skill || !instructions) return undefined;
  return [
    `The person picked the skill "${skill.title || skill.slug}" (/${skill.slug}) for their latest message. Follow its instructions for this reply:`,
    instructions,
  ].join("\n\n");
}
