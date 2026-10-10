import { describe, expect, it } from "vitest";
import { pickResponder, type GroupMember } from "./routing";

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
