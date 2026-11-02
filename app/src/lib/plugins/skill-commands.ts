import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

/** The granted skills of one Bot as `/` menu commands, from the plugins answer for that Bot. */
export function skillCommandsFor(
  data: Pick<GrantedPlugins, "skills"> | undefined,
): CommandOption[] {
  return (data?.skills ?? []).map((skill) => ({
    id: skill.slug,
    name: skill.slug,
    description: skill.summary || skill.title,
    /*
     * A CHIP, NOT AN EXPANSION. `prompt` used to paste the skill's whole instruction into the
     * box, which meant a person watched a paragraph they did not write appear over the message
     * they were typing, and had to scroll past it to reach their own words.
     *
     * The chip stays, one token wide, and `channel-chat` reads `draft.commandIds` on send and
     * puts the instruction in front of the run. Nothing is hidden by this that was not already:
     * the instruction is the skill's own text, visible on the skills page, and a skill is an
     * instruction rather than a capability — it can only ask for tools the Bot already holds.
     */
    kind: "chip" as const,
    /*
     * Carried on the option rather than looked up again at send time. `applyCommandChips` only
     * substitutes `prompt` for `kind: "prompt"`, so on a chip this is inert payload, and the
     * alternative is a second query racing the first for the same rows.
     */
    prompt: skill.instructions,
  }));
}

/**
 * Granted skills as `/` menu commands. Each one inserts a chip, not composer text.
 */
export function useSkillCommands(agentId: string): CommandOption[] {
  const { data } = useQuery(agentPluginsQueryOptions(agentId));
  return useMemo(() => skillCommandsFor(data), [data]);
}

/**
 * The skill instructions of a draft sent from a screen that offers no `/` menu, such as the home
 * screen, where the Bot is only known once the draft names it. Read at send time from the same
 * query the menu is built from, so a typed `/slug` counts there exactly as it does in a channel.
 * A failed read sends the message without its skill rather than not at all; the Bot then answers
 * the words, which is what happened on every screen before this existed.
 */
export async function skillInstructionsForAgent(
  queryClient: QueryClient,
  agentId: string,
  draft: Pick<ComposerDraft, "text" | "commandIds">,
): Promise<string[]> {
  if (!draft.text.includes("/") && draft.commandIds.length === 0) return [];
  const data = await queryClient
    .fetchQuery(agentPluginsQueryOptions(agentId))
    .catch(() => undefined);
  return skillInstructionsFor(draft, skillCommandsFor(data));
}

/**
 * The instructions a draft was sent with, in the order they were typed.
 *
 * Two ways a skill gets onto a message, resolved the same way so the Bot cannot tell them apart.
 * A chip from the `/` menu arrives as `commandIds`. A slug typed by hand, `/research-a-brand acme`,
 * arrives as text, and the transcript already draws a known one as a chip, so a person who typed it
 * believes they invoked the skill. Before this, only the chip reached the Bot: the typed form was
 * sent as plain words and the Bot answered that no such skill existed. Only a leading slug counts,
 * and only one the Bot actually holds, for the reason the transcript gives: "/etc/hosts is broken"
 * is a sentence.
 */
export function skillInstructionsFor(
  draft: Pick<ComposerDraft, "text" | "commandIds">,
  commands: CommandOption[],
): string[] {
  const ids = [...draft.commandIds];
  /*
   * The leading token, matched against the known slugs by prefix and taking the longest. By
   * prefix, because the composer's menu filters as the slug is typed and a person who then types
   * straight on gets `/research-a-branddrycleansavannah.com`, with no space: every run of that
   * shape was sent as plain words, and the transcript gave no sign. A slug is specific enough
   * that a sentence starting with one and more letters is not a sentence anybody writes.
   */
  // After an `@` mention, when there is one: the home screen's text starts with the coworker's
  // name, `@General Assistant /research-a-brand acme`, and the slug comes next.
  const token = /^(?:@[^/\n]*?\s+)?\/(\S+)/.exec(draft.text)?.[1];
  if (token) {
    const typed = commands
      .map((command) => command.id)
      .filter((id) => token === id || token.startsWith(id))
      .sort((a, b) => b.length - a.length)[0];
    if (typed && !ids.includes(typed)) ids.push(typed);
  }
  return ids
    .map((id) => commands.find((command) => command.id === id)?.prompt)
    .filter((instruction): instruction is string => Boolean(instruction));
}
