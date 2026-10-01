import { describe, expect, it } from "vitest";
import { firstName, initials, partOfDay, roleLabel, shortDate } from "./format";

describe("format", () => {
  it("initials uses the first and last word", () => {
    expect(initials("Sam Taylor")).toBe("ST");
    expect(initials("Ana María de la Cruz")).toBe("AC");
    expect(initials("  prince  ")).toBe("P");
    expect(initials("")).toBe("?");
  });

  it("firstName and roleLabel", () => {
    expect(firstName("Sam Taylor")).toBe("Sam");
    expect(roleLabel("owner")).toBe("Owner");
  });

  it("partOfDay and shortDate", () => {
    expect(partOfDay(new Date(2026, 9, 1, 8))).toBe("Morning");
    expect(partOfDay(new Date(2026, 9, 1, 13))).toBe("Afternoon");
    expect(partOfDay(new Date(2026, 9, 1, 21))).toBe("Evening");
    expect(shortDate(new Date(2026, 9, 1))).toBe("Thu 01 Oct");
  });
});
