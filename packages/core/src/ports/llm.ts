import type { TenantContext } from "../tenant";
import type { ToolDescriptor } from "./tools";

export type ModelTier = "fast" | "standard" | "strong";

export type LLMMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly LLMToolCall[];
    }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface LLMRequest {
  readonly tier: ModelTier;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly ToolDescriptor[];
  readonly maxOutputTokens?: number;
  /** Version of the prompt template, recorded on the trace. */
  readonly promptVersion?: string;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface LLMResponse {
  readonly text: string;
  readonly toolCalls: readonly LLMToolCall[];
  readonly usage: LLMUsage;
  /** The model that actually served the request, after any fallback. */
  readonly model: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly contextWindow: number;
}

export interface LLMGateway {
  generate(request: LLMRequest, ctx: TenantContext): Promise<LLMResponse>;
  modelFor(tier: ModelTier, ctx: TenantContext): Promise<ModelInfo>;
}
