import type { ErrorResponse } from "@ofa/contracts";
import { AppError, isAppError, type ErrorCode } from "@ofa/core";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  tenant_required: 403,
  policy_denied: 403,
  rate_limited: 429,
  internal: 500,
};

const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "bad_request",
  422: "validation_failed",
  429: "rate_limited",
};

export interface HttpError {
  readonly status: ContentfulStatusCode;
  readonly body: ErrorResponse;
  /** Unexpected errors are logged with a stack; expected ones are not. */
  readonly unexpected: boolean;
}

/**
 * Turn anything thrown into the API's error shape. Unexpected errors never
 * leak their message or stack to the client.
 */
export function toHttpError(error: unknown): HttpError {
  if (isAppError(error)) {
    return {
      status: STATUS_BY_CODE[error.code],
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      unexpected: error.code === "internal",
    };
  }
  if (error instanceof HTTPException) {
    const code = CODE_BY_STATUS[error.status] ?? "internal";
    return {
      status: STATUS_BY_CODE[code],
      body: { error: { code, message: error.message || code } },
      unexpected: code === "internal",
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "Something went wrong" } },
    unexpected: true,
  };
}

export const unauthorized = () => new AppError("unauthorized", "Sign in to continue");
