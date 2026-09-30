import { describe, expect, it } from "vitest";
import { TenantRequiredError, asId, assertTenant, strictest, type TenantContext } from "./index";

describe("assertTenant", () => {
  it("accepts a context with workspace and user", () => {
    const ctx: TenantContext = { workspaceId: asId("ws_1"), userId: asId("usr_1") };
    expect(() => assertTenant(ctx)).not.toThrow();
  });

  it("rejects a missing context", () => {
    expect(() => assertTenant(undefined)).toThrow(TenantRequiredError);
  });

  it("rejects an empty workspace id", () => {
    expect(() => assertTenant({ workspaceId: asId(""), userId: asId("usr_1") })).toThrow(
      TenantRequiredError,
    );
  });
});

describe("strictest", () => {
  it("keeps the stricter verdict regardless of order", () => {
    expect(strictest("auto", "approve")).toBe("approve");
    expect(strictest("deny", "auto")).toBe("deny");
    expect(strictest("human", "approve")).toBe("human");
    expect(strictest("auto", "auto")).toBe("auto");
  });
});
