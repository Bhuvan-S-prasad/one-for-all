/**
 * Application errors. Each has a stable `code` that the API maps to an HTTP
 * status and that clients can switch on.
 */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "tenant_required",
  "policy_denied",
  "rate_limited",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super("not_found", `${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super("forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class TenantRequiredError extends AppError {
  constructor() {
    super("tenant_required", "This operation requires a tenant context");
    this.name = "TenantRequiredError";
  }
}

export class PolicyDeniedError extends AppError {
  constructor(tool: string, reasons: readonly string[]) {
    super("policy_denied", `Policy denied ${tool}`, { reasons });
    this.name = "PolicyDeniedError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
