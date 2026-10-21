import { describe, expect, it } from "vitest";
import { discussionFor, pickResponder, type GroupMember } from "./routing";

// Who answers in a group thread (M5.04).

const member = (id: string, name: string, slug = name.toLowerCase()): GroupMember => ({
  id,
  slug,
  name,
  status: "active",
});
const chief = member("c", "Chief");
const researcher = member("r", "Researcher");
const writer = member("w", "Writer");
const inbox = member("i", "Inbox Clerk", "inbox-clerk");
const team = [chief, researcher, writer, inbox];

const who = (text: string) => pickResponder(text, team, "c");

describe("pickResponder", () => {
  it("gives the message to the member mentioned first, by handle or name", () => {
    expect(who("@researcher when was pgvector 0.9 released?")).toEqual({
      member: researcher,
      mentioned: true,
    });
    expect(who("Thanks @Writer, and @Researcher please check it")?.member).toBe(writer);
    expect(who("Can @Inbox Clerk sort my mail?")?.member).toBe(inbox);
    expect(who("(@inbox-clerk) anything new?")?.member).toBe(inbox);
  });

  it("goes to the coordinator when nobody is mentioned", () => {
    expect(who("Find the release date and draft a note.")).toEqual({
      member: chief,
      mentioned: false,
    });
    // Without a coordinator, the first member answers.
    expect(pickResponder("hi", team, null)?.member).toBe(chief);
    expect(pickResponder("hi", [], null)).toBeNull();
  });

  it("doesn't take an address or a longer word for a mention", () => {
    expect(who("Email sam@researcher.example about it")?.member).toBe(chief);
    expect(who("Ask @researchers in general")?.member).toBe(chief);
    expect(who("Ask @writer2")?.member).toBe(chief);
  });
});

// A message to the whole group starts a discussion (ADR-0050).
describe("discussionFor", () => {
  const ask = (text: string) => discussionFor(text, team, "c")?.members.map((m) => m.name) ?? null;

  it("asks everyone but the coordinator, in roster order", () => {
    expect(ask("@all which laptop should we buy?")).toEqual([
      "Researcher",
      "Writer",
      "Inbox Clerk",
    ]);
    expect(ask("What do you think, @everyone?")).toEqual(["Researcher", "Writer", "Inbox Clerk"]);
    expect(ask("/discuss the launch date")).toEqual(["Researcher", "Writer", "Inbox Clerk"]);
    expect(ask("@Team thoughts?")).toEqual(["Researcher", "Writer", "Inbox Clerk"]);
  });

  it("takes the members it names, in the order named, when it names two or more", () => {
    expect(ask("@all @writer then @researcher: is this clear?")).toEqual(["Writer", "Researcher"]);
    // The coordinator too, if named.
    expect(ask("/discuss @chief and @inbox-clerk: archive or keep?")).toEqual([
      "Chief",
      "Inbox Clerk",
    ]);
    // One name alone doesn't narrow it.
    expect(ask("@all, especially @writer: thoughts?")).toEqual([
      "Researcher",
      "Writer",
      "Inbox Clerk",
    ]);
  });

  it("leaves paused members out", () => {
    const paused = { ...writer, status: "paused" as const };
    expect(
      discussionFor("@all go", [chief, researcher, paused], "c")?.members.map((m) => m.name),
    ).toEqual(["Researcher"]);
  });

  it("is not a discussion otherwise", () => {
    expect(ask("@researcher find the date")).toBeNull();
    expect(ask("Email all@example.com and the team")).toBeNull();
    expect(ask("@allison can you help?")).toBeNull();
    expect(ask("Let's /discuss later")).toBeNull();
  });
});
