import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./index";

const valid = {
  DATABASE_URL: "postgres://app:pw@127.0.0.1:5432/db",
  AUTH_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("applies defaults for a minimal environment", () => {
    const config = loadConfig(valid);
    expect(config.mode).toBe("self-host");
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(3000);
    expect(config.database.migrationUrl).toBe(valid.DATABASE_URL);
    expect(config.inngest.dev).toBe(true);
    expect(config.server.allowedOrigins).toEqual(["http://localhost:3000"]);
    expect(config.server.allowedHosts).toEqual([
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "host.docker.internal:3000",
    ]);
    expect(config.log.format).toBe("pretty");
    expect(config.llm).toEqual({
      provider: "openrouter",
      apiKey: undefined,
      baseUrl: undefined,
      models: { fast: undefined, standard: undefined, strong: undefined },
    });
  });

  it("finds the dev sandbox in development, and needs both settings elsewhere", () => {
    expect(loadConfig({ ...valid, NODE_ENV: "development" }).sandbox).toEqual({
      url: "http://127.0.0.1:7070",
      token: "ofa-sandbox-dev-token",
    });
    expect(loadConfig({ ...valid, NODE_ENV: "production" }).sandbox).toBeNull();
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: "production", SANDBOX_URL: "http://egress:7070" }),
    ).toThrow("SANDBOX_TOKEN");
    expect(() => loadConfig({ ...valid, SANDBOX_TOKEN: "short" })).toThrow(ConfigError);
  });

  it("rejects a malformed provider ID", () => {
    expect(() => loadConfig({ ...valid, LLM_PROVIDER: "Open Router" })).toThrow(ConfigError);
  });

  it("accepts extra hosts, e.g. a Tailscale name", () => {
    const config = loadConfig({
      ...valid,
      APP_URL: "https://box.tail1234.ts.net",
      ALLOWED_HOSTS: "Other.Example:8443, ",
    });
    expect(config.server.allowedHosts).toEqual([
      "box.tail1234.ts.net",
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "host.docker.internal:3000",
      "other.example:8443",
    ]);
  });

  it("includes the web dev server in allowed origins", () => {
    const config = loadConfig({ ...valid, WEB_DEV_URL: "http://localhost:5173/" });
    expect(config.server.allowedOrigins).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({ ...valid, VAULT_KEY: "", PORT: " " });
    expect(config.vault.key).toBeUndefined();
    expect(config.server.port).toBe(3000);
  });

  it("lists every problem at once", () => {
    try {
      loadConfig({ AUTH_SECRET: "short", DATABASE_URL: "mysql://nope" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("DATABASE_URL");
      expect(issues).toContain("AUTH_SECRET");
    }
  });

  it("rejects the placeholder secret in production", () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: "production", AUTH_SECRET: "change-me".padEnd(40, "x") }),
    ).toThrow(ConfigError);
  });

  it("validates the vault key length", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(loadConfig({ ...valid, VAULT_KEY: key }).vault.key).toBe(key);
    expect(() => loadConfig({ ...valid, VAULT_KEY: "dG9vLXNob3J0" })).toThrow(ConfigError);
  });

  it("reads the key source and previous keys for rotation", () => {
    const a = Buffer.alloc(32, 1).toString("base64");
    const b = Buffer.alloc(32, 2).toString("base64");
    expect(loadConfig(valid).vault).toEqual({ source: "env", key: undefined, previousKeys: [] });
    const rotating = loadConfig({
      ...valid,
      VAULT_KEY_SOURCE: "keychain",
      VAULT_PREVIOUS_KEYS: ` ${a}, ${b},`,
    });
    expect(rotating.vault).toMatchObject({ source: "keychain", previousKeys: [a, b] });
    expect(() => loadConfig({ ...valid, VAULT_PREVIOUS_KEYS: `${a},dG9vLXNob3J0` })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...valid, VAULT_KEY_SOURCE: "file" })).toThrow(ConfigError);
  });
});
