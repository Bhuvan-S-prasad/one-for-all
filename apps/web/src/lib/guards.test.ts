import { describe, expect, it } from "vitest";
import { safeRedirect } from "./guards";

describe("safeRedirect", () => {
  it("accepts same-site paths", () => {
    expect(safeRedirect("/")).toBe("/");
    expect(safeRedirect("/approvals")).toBe("/approvals");
    expect(safeRedirect("/settings?tab=account")).toBe("/settings?tab=account");
  });

  it("rejects anything that could leave the site", () => {
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("/\\evil.example")).toBeUndefined();
    expect(safeRedirect("javascript:alert(1)")).toBeUndefined();
    expect(safeRedirect("approvals")).toBeUndefined();
  });

  it("ignores non-strings", () => {
    expect(safeRedirect(undefined)).toBeUndefined();
    expect(safeRedirect(["/a"])).toBeUndefined();
  });
});
