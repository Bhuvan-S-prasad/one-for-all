import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  errorResponseSchema,
  firstRunSetupRequestSchema,
  pageSchema,
  paginationQuerySchema,
} from "./index";

describe("errorResponseSchema", () => {
  it("accepts known error codes and rejects unknown ones", () => {
    expect(
      errorResponseSchema.safeParse({ error: { code: "not_found", message: "x" } }).success,
    ).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { code: "oops", message: "x" } }).success).toBe(
      false,
    );
  });
});

describe("paginationQuerySchema", () => {
  it("coerces and bounds the limit", () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(25);
    expect(paginationQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(paginationQuerySchema.safeParse({ limit: "1000" }).success).toBe(false);
  });
});

describe("pageSchema", () => {
  it("wraps items with a cursor", () => {
    const page = pageSchema(z.object({ id: z.string() }));
    expect(page.parse({ items: [{ id: "a" }], nextCursor: null }).items).toHaveLength(1);
  });
});

describe("firstRunSetupRequestSchema", () => {
  const request = {
    workspaceName: "  Home  ",
    name: "Owner",
    email: "owner@example.com",
    password: "a-long-enough-password",
  };

  it("trims names and accepts a valid request", () => {
    expect(firstRunSetupRequestSchema.parse(request).workspaceName).toBe("Home");
  });

  it("rejects short passwords", () => {
    expect(firstRunSetupRequestSchema.safeParse({ ...request, password: "short" }).success).toBe(
      false,
    );
  });
});
