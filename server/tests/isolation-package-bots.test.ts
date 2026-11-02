import { describe, expect, test } from "bun:test";
import { isolationState, runsIsolated } from "../src/agents/isolation";

/*
 * Sphere: every Bot here browses through a kernel container of its own, reachable only from that
 * Bot's own computer. The built-in (package) Bots have no owner, so upstream would never isolate
 * them and they would land on a person's computer with no way to reach their kernel. An operator
 * sets `agent_profiles.isolated` for them in the database instead, and that has to be honoured.
 */
type Row = {
  isolated: boolean;
  ownerUserId: string | null;
  deletedAt: Date | null;
};
const databaseWith = (row: Row | undefined) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (row ? [row] : []) }),
      }),
    }),
  }) as unknown as Parameters<typeof runsIsolated>[0];

describe("isolated package Bots", () => {
  test("an ownerless Bot flagged isolated runs on a computer of its own", async () => {
    expect(
      await runsIsolated(
        databaseWith({ isolated: true, ownerUserId: null, deletedAt: null }),
        "knowledge",
      ),
    ).toBe(true);
  });

  test("an ownerless Bot that is not flagged stays on the person's computer", async () => {
    expect(
      await runsIsolated(
        databaseWith({ isolated: false, ownerUserId: null, deletedAt: null }),
        "knowledge",
      ),
    ).toBe(false);
  });

  test("a deleted or missing Bot is never isolated", async () => {
    expect(
      await runsIsolated(
        databaseWith({
          isolated: true,
          ownerUserId: null,
          deletedAt: new Date(),
        }),
        "knowledge",
      ),
    ).toBe(false);
    expect(await runsIsolated(databaseWith(undefined), "knowledge")).toBe(
      false,
    );
  });

  test("its Setup shows it isolated, unless the deployment cannot make a second computer", () => {
    expect(
      isolationState({ isolated: true, ownerUserId: null }, true, false),
    ).toEqual({
      isolationActive: true,
      isolationOffReason: null,
    });
    expect(
      isolationState({ isolated: true, ownerUserId: null }, false, false),
    ).toEqual({
      isolationActive: false,
      isolationOffReason: "deployment",
    });
    expect(
      isolationState({ isolated: false, ownerUserId: null }, true, true),
    ).toEqual({
      isolationActive: false,
      isolationOffReason: null,
    });
  });
});
