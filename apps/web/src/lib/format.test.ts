import { describe, expect, it } from "vitest";
import { firstName, initials, roleLabel } from "./format";

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
});
