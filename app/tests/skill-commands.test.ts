import { describe, expect, test } from "bun:test";
import type { CommandOption } from "../src/components/channels/composer";
import {
  skillCommandsFor,
  skillInstructionsFor,
} from "../src/lib/plugins/skill-commands";

const commands: CommandOption[] = [
  {
    id: "research-a-brand",
    name: "research-a-brand",
    description: "Research a brand",
    kind: "chip",
    prompt: "Research the brand.",
  },
  {
    id: "build-a-react-site",
    name: "build-a-react-site",
    description: "Build a site",
    kind: "chip",
    prompt: "Build the site.",
  },
];

describe("skillInstructionsFor", () => {
  test("a chip from the menu resolves to its instruction", () => {
    expect(
      skillInstructionsFor(
        { text: "/research-a-brand acme", commandIds: ["research-a-brand"] },
        commands,
      ),
    ).toEqual(["Research the brand."]);
  });

  test("a slug typed by hand resolves the same way", () => {
    expect(
      skillInstructionsFor(
        { text: "/research-a-brand acme", commandIds: [] },
        commands,
      ),
    ).toEqual(["Research the brand."]);
  });

  test("a chip and the same typed slug are one invocation", () => {
    expect(
      skillInstructionsFor(
        { text: "/research-a-brand acme", commandIds: ["research-a-brand"] },
        commands,
      ),
    ).toHaveLength(1);
  });

  test("a slash that is not a known skill is a sentence", () => {
    expect(
      skillInstructionsFor(
        { text: "/etc/hosts is broken", commandIds: [] },
        commands,
      ),
    ).toEqual([]);
    expect(
      skillInstructionsFor(
        { text: "/nothing-here acme", commandIds: [] },
        commands,
      ),
    ).toEqual([]);
  });

  test("a slug after an @ mention counts, as the home screen sends it", () => {
    expect(
      skillInstructionsFor(
        {
          text: "@General Assistant /research-a-brand drycleansavannah.com",
          commandIds: [],
        },
        commands,
      ),
    ).toEqual(["Research the brand."]);
    expect(
      skillInstructionsFor(
        {
          text: "@General Assistant /research-a-branddrycleansavannah.com",
          commandIds: [],
        },
        commands,
      ),
    ).toEqual(["Research the brand."]);
  });

  test("only a leading slug counts", () => {
    expect(
      skillInstructionsFor(
        { text: "please run /research-a-brand acme", commandIds: [] },
        commands,
      ),
    ).toEqual([]);
  });

  test("a slug typed straight into the next word still counts", () => {
    // The menu filters as the slug is typed; typing on without a space is the common case.
    expect(
      skillInstructionsFor(
        { text: "/research-a-branddrycleansavannah.com", commandIds: [] },
        commands,
      ),
    ).toEqual(["Research the brand."]);
  });

  test("the longest known slug wins when one is a prefix of another", () => {
    const nested: CommandOption[] = [
      ...commands,
      {
        id: "research-a-brand-deeply",
        name: "research-a-brand-deeply",
        kind: "chip",
        prompt: "Go deep.",
      },
    ];
    expect(
      skillInstructionsFor(
        { text: "/research-a-brand-deeply acme", commandIds: [] },
        nested,
      ),
    ).toEqual(["Go deep."]);
  });

  test("an unknown slug glued to a word is still a sentence", () => {
    expect(
      skillInstructionsFor(
        { text: "/researchacme now", commandIds: [] },
        commands,
      ),
    ).toEqual([]);
  });
});

describe("skillCommandsFor", () => {
  test("maps a Bot's granted skills to chip commands carrying their instructions", () => {
    expect(
      skillCommandsFor({
        skills: [
          {
            slug: "research-a-brand",
            title: "Research a brand",
            summary: "Look a company up.",
            instructions: "Research the brand.",
          },
        ],
      }),
    ).toEqual([
      {
        id: "research-a-brand",
        name: "research-a-brand",
        description: "Look a company up.",
        kind: "chip",
        prompt: "Research the brand.",
      },
    ]);
  });

  test("no answer yet means no commands, not a crash", () => {
    expect(skillCommandsFor(undefined)).toEqual([]);
  });
});
