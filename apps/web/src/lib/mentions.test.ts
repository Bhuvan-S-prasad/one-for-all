import { describe, expect, it } from "vitest";
import { insertMention, mentionQuery } from "./mentions";

describe("@name in a group chat (M5.11)", () => {
  it("knows when a name is being typed", () => {
    expect(mentionQuery("@")).toBe("");
    expect(mentionQuery("hi @Wri")).toBe("wri");
    expect(mentionQuery("mail me at sam@rivera.example")).toBeNull();
    expect(mentionQuery("@Writer please")).toBeNull();
  });

  it("puts the chosen name in place of what was typed", () => {
    expect(insertMention("hi @wr", "Writer")).toBe("hi @Writer ");
  });
});
