import { describe, expect, it } from "vitest";
import {
  TenantRequiredError,
  asId,
  assertTenant,
  givenKeys,
  hostMatchesSite,
  loginSecretNames,
  loginSiteOf,
  normalizeLoginSite,
  strictest,
  urlKey,
  urlsIn,
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
    // A script or file address is no site, whatever host it pretends to have.
    expect(normalizeLoginSite("javascript://shop.example/%0afetch('x')")).toBeNull();
    expect(normalizeLoginSite("file://shop.example/etc/passwd")).toBeNull();
    expect(normalizeLoginSite("http://shop.example/")).toBe("shop.example");
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

describe("addresses a run was given", () => {
  it("finds addresses in text and JSON, without trailing punctuation", () => {
    expect(
      urlsIn(
        'See https://a.example/x. Also {"url":"https://b.example/y?q=1"} and (https://c.example)',
      ),
    ).toEqual(["https://a.example/x", "https://b.example/y?q=1", "https://c.example"]);
  });

  it("treats the same address the same however it is written", () => {
    expect(urlKey("HTTPS://WWW.Shop.example/orders/5512/")).toBe(
      "https://shop.example/orders/5512",
    );
    expect(urlKey("https://shop.example/?q=1")).toBe("https://shop.example?q=1");
    expect(urlKey("https://shop.example/Orders")).not.toBe(urlKey("https://shop.example/orders"));
    expect(urlKey("https://shop.example/orders/5512#")).toBe("https://shop.example/orders/5512");
  });

  it("keeps the fragment, since a page's script reads it", () => {
    expect(urlKey("https://verify.example/check#email=sam@example.com")).toBe(
      "https://verify.example/check#email=sam@example.com",
    );
    expect(urlKey("https://verify.example/check#email=sam@example.com")).not.toBe(
      urlKey("https://verify.example/check"),
    );
    // A given address also lets the run open it without its fragment, not with another one.
    expect(givenKeys("https://www.Docs.example/start/#install")).toEqual([
      "https://docs.example/start#install",
      "https://docs.example/start",
    ]);
    expect(givenKeys("https://docs.example/start")).toEqual(["https://docs.example/start"]);
  });
});
