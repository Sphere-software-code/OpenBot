import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which runner is told to start fresh, asserted against `index.ts`'s own source.
 *
 * `index.ts` cannot be imported to be tested: it boots the whole server as a side effect of loading.
 * So the one line that scopes this setting is a line nothing executes, and every test of the setting
 * passes it directly, which means they would all stay green if it moved to the wrong runner. On the
 * follow-up runner a Bot would wake knowing only the note it left itself, and on the runner inbound
 * messages use a person's Slack conversation would lose its memory.
 *
 * Read as text for the reason `cull-sweep-wiring.test.ts` gives. This proves the wire and nothing
 * else; `routine-run-turn.test.ts` owns what the option does.
 */
const source = readFileSync(
  join(import.meta.dir, "..", "src", "index.ts"),
  "utf8",
);

test("the routine runner is the one runner told to start fresh", () => {
  expect(source.split("freshContextBots:").length - 1).toBe(1);
  const start = source.indexOf("const routineRunner = createRoutineRunner({");
  const end = source.indexOf("const actorAgentResolver", start);
  expect(start).toBeGreaterThan(-1);
  expect(source.slice(start, end)).toContain(
    "freshContextBots: new Set(config.routineFreshContextBots)",
  );
});
