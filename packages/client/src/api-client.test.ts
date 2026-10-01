import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "./index";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const session = {
  user: { id: "u1", email: "a@example.com", name: "A" },
  workspace: { id: "w1", name: "Home", role: "owner" },
};

describe("createApiClient", () => {
  it("sends JSON with credentials and parses the response", async () => {
    const { fetch, calls } = fakeFetch(200, session);
    const api = createApiClient({ fetch, baseUrl: "http://api", workspaceId: () => "w1" });

    expect(await api.login({ email: "a@example.com", password: "pw" })).toEqual(session);
    expect(calls[0]?.url).toBe("http://api/api/session");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-workspace-id": "w1" },
    });
  });

  it("turns error responses into ApiError with field messages", async () => {
    const { fetch } = fakeFetch(422, {
      error: {
        code: "validation_failed",
        message: "Some fields are invalid",
        details: { issues: [{ path: "password", message: "Too short" }] },
      },
    });
    const error = await createApiClient({ fetch })
      .setup({ workspaceName: "W", name: "N", email: "a@example.com", password: "x" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("validation_failed");
    expect((error as ApiError).fieldErrors()).toEqual({ password: "Too short" });
  });

  it("returns null for the session when signed out", async () => {
    const { fetch } = fakeFetch(401, { error: { code: "unauthorized", message: "Sign in" } });
    expect(await createApiClient({ fetch }).session()).toBeNull();
  });

  it("rejects responses that do not match the contract", async () => {
    const { fetch } = fakeFetch(200, { needsSetup: "yes" });
    await expect(createApiClient({ fetch }).setupStatus()).rejects.toThrow();
  });

  it("reports network failures as status 0", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(createApiClient({ fetch }).health()).rejects.toMatchObject({ status: 0 });
  });
});
