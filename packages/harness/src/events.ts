import { runEventInputSchema, type RunEventPayload, type RunEventType } from "@ofa/contracts";
import type { LLMResponse, ModelTier, RunEventWrite } from "@ofa/core";

/** Build a run-log entry, checked against the contracts schema (hard rule 7). */
export function runEvent<T extends RunEventType>(
  key: string,
  type: T,
  payload: RunEventPayload<T>,
): RunEventWrite {
  const parsed = runEventInputSchema.parse({ type, payload });
  return { key, type: parsed.type, payload: parsed.payload as Record<string, unknown> };
}

/**
 * Every model call is logged, including the harness's own (compaction,
 * memory extraction), with any models that failed before one answered.
 */
export function modelCallEvents(
  key: string,
  tier: ModelTier,
  response: LLMResponse,
  promptVersion: string | undefined,
): RunEventWrite[] {
  return [
    ...response.attempts.map((a, n) =>
      runEvent(`${key}-fail-${n}`, "model.failed", {
        provider: a.provider,
        model: a.model,
        tier,
        code: a.code,
        message: a.message,
      }),
    ),
    runEvent(key, "model.called", {
      provider: response.provider,
      model: response.model,
      tier,
      promptVersion,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      durationMs: response.durationMs,
      finishReason: response.finishReason,
      toolCalls: response.toolCalls.length,
      ...(response.attempts.length ? { fellBackFrom: response.attempts.map((a) => a.model) } : {}),
    }),
  ];
}
