import type { TenantContext } from "../tenant";
import type { ToolDescriptor } from "./tools";

/** Agents ask for a tier, never a model; the workspace maps tiers to models. */
export const MODEL_TIERS = ["fast", "standard", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Why a model call failed, independent of the provider:
 * - `rate_limited`: the provider said slow down (HTTP 429)
 * - `capacity`: our own queue for the provider's quota is full
 * - `auth`: missing or rejected API key
 * - `bad_request`: the provider rejected the request itself
 * - `context_length`: the prompt does not fit the model's window
 * - `unavailable`: provider or model down (5xx, network)
 * - `timeout`: no answer in time
 */
export const MODEL_ERROR_CODES = [
  "rate_limited",
  "capacity",
  "auth",
  "bad_request",
  "context_length",
  "unavailable",
  "timeout",
  "unknown",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export type LLMMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly LLMToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
    };

export interface LLMToolCall {
  readonly id: string;
  /** The tool's own name (`web.search`), whatever the provider needed on the wire. */
  readonly name: string;
  readonly args: unknown;
  /**
   * Set when the model named an unknown tool or sent arguments that fail the
   * tool's schema. The harness returns this to the model instead of running it.
   */
  readonly invalid?: string;
}

export interface LLMRequest {
  readonly tier: ModelTier;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly ToolDescriptor[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Version of the prompt template, recorded on the trace. */
  readonly promptVersion?: string;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** A model that was tried and failed before the one that answered. */
export interface LLMAttempt {
  readonly provider: string;
  readonly model: string;
  readonly code: ModelErrorCode;
  readonly message: string;
}

export interface LLMResponse {
  readonly text: string;
  readonly toolCalls: readonly LLMToolCall[];
  readonly usage: LLMUsage;
  /** The provider and model that actually served the request, after any fallback. */
  readonly provider: string;
  readonly model: string;
  /** `stop`, `length`, `tool-calls`, `content-filter`, `error` or `other`. */
  readonly finishReason: string;
  readonly durationMs: number;
  /** Earlier models in the tier's chain that failed; empty when the first answered. */
  readonly attempts: readonly LLMAttempt[];
}

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | undefined;
}

/**
 * The only way the system reaches a language model (ARCHITECTURE.md §3, L6).
 * Callers name a tier; which provider and model serve it is configuration.
 */
export interface LLMGateway {
  generate(request: LLMRequest, ctx: TenantContext): Promise<LLMResponse>;
  /** The model a tier currently maps to, for context budgets (§7). */
  modelFor(tier: ModelTier, ctx: TenantContext): Promise<ModelInfo>;
}
