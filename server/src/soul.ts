import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * House rules: what every Bot in this deployment is told, whatever its role.
 *
 * A role is one Bot's and lives on its row. A person's standing instructions are one person's. This
 * is the organisation's: written once, in the file `SOUL_FILE` names, and carried by every Bot, so a
 * rule meant for all of them is not copied into each role and left to drift.
 *
 * READ PER RUN, cached on the file's modification time. Roles are read per run, so an edit to one
 * lands on the next message; a shared rule that needed a restart to land would be the odd one out.
 *
 * NEVER FAILS A RUN. No `SOUL_FILE`, a missing file or an unreadable one all mean no house rules,
 * and the last two say so once in the log. A Bot that cannot start because a text file moved is a
 * worse outcome than a Bot that runs on its role alone.
 *
 * A relative path is read from the server's working directory, the same as `TENANT_PACKAGE_DIR`.
 */
export function soulGuidance(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const configured = environment.SOUL_FILE?.trim();
  if (!configured) return null;

  const path = resolve(configured);
  try {
    const { mtimeMs, size } = statSync(path);
    if (
      cached?.path !== path ||
      cached.mtimeMs !== mtimeMs ||
      cached.size !== size
    ) {
      cached = {
        path,
        mtimeMs,
        size,
        guidance: houseRulesGuidance(readFileSync(path, "utf8")),
      };
    }
    unreadable = undefined;
    return cached.guidance;
  } catch (error) {
    if (unreadable !== path) {
      unreadable = path;
      console.error({
        message:
          "SOUL_FILE could not be read; Bots run without house rules until it can",
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

let cached:
  | { path: string; mtimeMs: number; size: number; guidance: string | null }
  | undefined;
let unreadable: string | undefined;

/**
 * The file's text as the paragraph a Bot reads, or null when it holds no rule.
 *
 * HTML comments are dropped, so the file can explain itself to the person editing it without every
 * Bot reading the explanation on every run. A file that is only comments is an empty file.
 *
 * THE PRECEDENCE SENTENCE IS PART OF THE BLOCK. A house rule that a role could quietly outrank is
 * not a rule for every Bot, and without the sentence the conflict is settled by whichever the model
 * read last.
 */
export function houseRulesGuidance(raw: string): string | null {
  const rules = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (rules.length === 0) return null;

  return [
    "House rules. Every Bot in this organisation follows these, in every channel and on every routine run:",
    rules,
    "Where a house rule conflicts with your role, the house rule wins.",
  ].join("\n\n");
}
