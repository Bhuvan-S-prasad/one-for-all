import { describe, expect, it } from "vitest";
import {
  TenantRequiredError,
  asId,
  assertTenant,
  hostMatchesSite,
  loginSecretNames,
  loginSiteOf,
  normalizeLoginSite,
  strictest,
  type TenantContext,
} from "./index";

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

describe("saved login sites", () => {
  it("reduce an address to its site", () => {
    expect(normalizeLoginSite("https://Accounts.Example.com:443/login?x=1")).toBe(
      "accounts.example.com",
    );
    expect(normalizeLoginSite("www.github.com.")).toBe("github.com");
    expect(normalizeLoginSite("https://user:pw@example.org/")).toBe("example.org");
    expect(normalizeLoginSite("localhost")).toBeNull();
    expect(normalizeLoginSite("not a site")).toBeNull();
  });

  it("match only the site and its subdomains", () => {
    expect(hostMatchesSite("login.github.com", "github.com")).toBe(true);
    expect(hostMatchesSite("www.github.com", "github.com")).toBe(true);
    expect(hostMatchesSite("github.com.evil.example", "github.com")).toBe(false);
    expect(hostMatchesSite("notgithub.com", "github.com")).toBe(false);
    expect(loginSiteOf(loginSecretNames("github.com").password)).toBe("github.com");
    expect(loginSiteOf("llm.openrouter.api_key")).toBeNull();
  });
});
