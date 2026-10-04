import type { Telemetry } from "@ofa/core";
import type { HarnessMiddleware } from "./middleware";

// Spans for runs and model calls (ADR-0019). Tool spans come from the tool
// executor. Every span of a run shares a trace derived from its run ID.

export function createTelemetryMiddleware(telemetry: Telemetry): HarnessMiddleware {
  return {
    name: "telemetry",
    async onRunStart({ ctx, agent }) {
      telemetry
        .startSpan(
          "run.start",
          { "run.id": ctx.runId, "agent.id": agent.id, "agent.tier": agent.modelTier },
          { trace: ctx.runId },
        )
        .end();
    },
    async aroundModel({ ctx }, request, next) {
      const span = telemetry.startSpan(
        "model.call",
        {
          "run.id": ctx.runId,
          "llm.tier": request.tier,
          "prompt.version": request.promptVersion,
          "llm.tools": request.tools?.length ?? 0,
        },
        { trace: ctx.runId },
      );
      try {
        const response = await next(request);
        span.setAttributes({
          "llm.provider": response.provider,
          "llm.model": response.model,
          "llm.tokens.input": response.usage.inputTokens,
          "llm.tokens.output": response.usage.outputTokens,
          "llm.cost_usd": response.usage.costUsd,
          "llm.finish_reason": response.finishReason,
          "llm.fallbacks": response.attempts.length,
        });
        return response;
      } catch (error) {
        span.recordError(error);
        throw error;
      } finally {
        span.end();
      }
    },
    async onRunEnd({ ctx }, info) {
      telemetry
        .startSpan(
          "run.end",
          { "run.id": ctx.runId, "run.status": info.status, "run.stop_reason": info.stopReason },
          { trace: ctx.runId },
        )
        .end();
    },
  };
}
