import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVENANCE_GUIDANCE } from "@openbot/shared/bot-prompt";
import { builtInAgentConfiguration, standingRoleMessage } from "../src/copilot";
import { houseRulesGuidance, soulGuidance } from "../src/soul";

/**
 * House rules reach every Bot or they are not house rules: a remote Bot hears them in its standing
 * role message, a built-in one in its prompt, and neither hears anything when the file says nothing.
 */
describe("house rules", () => {
  let directory: string;
  let file: string;
  const before = process.env.SOUL_FILE;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openbot-soul-"));
    file = join(directory, "soul.md");
  });

  afterEach(() => {
    if (before === undefined) delete process.env.SOUL_FILE;
    else process.env.SOUL_FILE = before;
    rmSync(directory, { recursive: true, force: true });
  });

  test("no file configured means no house rules", () => {
    expect(soulGuidance({})).toBeNull();
    expect(soulGuidance({ SOUL_FILE: "  " })).toBeNull();
  });

  test("a file that only explains itself holds no rule", () => {
    writeFileSync(file, "<!-- Write one rule per line.\nNothing yet. -->\n\n");
    expect(soulGuidance({ SOUL_FILE: file })).toBeNull();
  });

  test("the rules are framed, the comments are dropped, and the house rule wins", () => {
    expect(
      houseRulesGuidance(
        "<!-- for the editor -->\nNever quote a price.\n\nWrite in plain English.\n",
      ),
    ).toBe(
      [
        "House rules. Every Bot in this organisation follows these, in every channel and on every routine run:",
        "Never quote a price.\n\nWrite in plain English.",
        "Where a house rule conflicts with your role, the house rule wins.",
      ].join("\n\n"),
    );
  });

  test("an edit lands on the next run without a restart", () => {
    writeFileSync(file, "Never quote a price.");
    expect(soulGuidance({ SOUL_FILE: file })).toContain("Never quote a price.");

    writeFileSync(file, "Never promise a delivery date.");
    // Same-millisecond writes of equal length would look unchanged; a real edit never is.
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const edited = soulGuidance({ SOUL_FILE: file });
    expect(edited).toContain("Never promise a delivery date.");
    expect(edited).not.toContain("Never quote a price.");
  });

  test("a missing file costs the rules, not the run, and says so once", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const missing = join(directory, "not-here.md");
      expect(soulGuidance({ SOUL_FILE: missing })).toBeNull();
      expect(soulGuidance({ SOUL_FILE: missing })).toBeNull();
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("a remote Bot hears them straight after its role", () => {
    writeFileSync(file, "Never quote a price.");
    process.env.SOUL_FILE = file;

    const content = standingRoleMessage({
      id: "outreach",
      name: "Outreach",
      title: "Outreach agent",
      roleDescription: "Write first-touch emails.",
    }).content;

    const role = content.indexOf("Write first-touch emails.");
    const rule = content.indexOf("Never quote a price.");
    expect(role).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(role);
    expect(rule).toBeLessThan(content.indexOf(PROVENANCE_GUIDANCE));
  });

  test("a built-in Bot hears them between its role and the person's instructions", () => {
    writeFileSync(file, "Never quote a price.");
    process.env.SOUL_FILE = file;

    const prompt = builtInAgentConfiguration(
      {
        id: "general-assistant",
        name: "General Assistant",
        type: "built_in",
        systemPrompt: "You are a helpful general assistant.",
      },
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "openai-secret",
      [],
      undefined,
      [],
      "Answer in one line.",
    ).prompt as string;

    const rule = prompt.indexOf("Never quote a price.");
    expect(rule).toBeGreaterThan(
      prompt.indexOf("You are a helpful general assistant."),
    );
    expect(rule).toBeLessThan(prompt.indexOf("Answer in one line."));
  });

  test("with nothing configured, both prompts are exactly what they were", () => {
    delete process.env.SOUL_FILE;

    const content = standingRoleMessage({
      id: "outreach",
      name: "Outreach",
      title: "Outreach agent",
      roleDescription: "Write first-touch emails.",
    }).content;
    expect(content).not.toContain("House rules.");
  });
});
