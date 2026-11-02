import { describe, expect, test } from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { resolveRuntimeAgents } from "../src/copilot";

/**
 * A `/` skill reaches a built-in Bot's model.
 *
 * The browser inserts a skill's instruction as a system row just ahead of the person's message.
 * The runtime's default dropped every system row on conversion, so for a built-in Bot the skill
 * was silently nothing: offered in the menu, shown invoked in the transcript, never read. This
 * drives the real pipeline, from `addMessage` through the run wrapper and the runtime's own
 * conversion, and reads what the model was actually sent.
 */
describe("skill instructions on a built-in Bot", () => {
  const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };
  const SKILL = "SKILL-INSTRUCTION-7f3a: research the brand before answering.";

  test("a system row from the browser is sent to the model, ahead of the conversation", async () => {
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, { type: "text", content: "Done." });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => "synthetic-model-key",
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "earlier-user",
        role: "user",
        content: "Earlier question.",
      });
      agent.addMessage({
        id: "earlier-assistant",
        role: "assistant",
        content: "Earlier answer.",
      });
      agent.addMessage({ id: "skill-row", role: "system", content: SKILL });
      agent.addMessage({
        id: "request",
        role: "user",
        content: "/research-a-brand acme.com",
      });
      await agent.runAgent();

      const requests = recorder.getRequests();
      expect(requests).toHaveLength(1);
      const body = requests[0]?.body as {
        messages?: { role: string; content: unknown }[];
      };
      const roles = (body.messages ?? []).map((message) => message.role);
      const systemTexts = (body.messages ?? [])
        .filter((message) => message.role === "system")
        .map((message) => String(message.content));

      // The skill is there, as its own system message.
      expect(systemTexts.some((text) => text.includes(SKILL))).toBe(true);
      // And it sits ahead of every user and assistant turn, where any provider accepts it.
      const firstTurn = roles.findIndex((role) => role !== "system");
      const skillAt = (body.messages ?? []).findIndex(
        (message) =>
          message.role === "system" && String(message.content).includes(SKILL),
      );
      expect(skillAt).toBeGreaterThanOrEqual(0);
      expect(skillAt).toBeLessThan(firstTurn);
      // The standing role is in the prompt, not sent a second time as a row.
      expect(
        systemTexts.filter((text) =>
          text.startsWith("You are General Assistant"),
        ),
      ).toHaveLength(0);
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  });
});
