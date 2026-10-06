import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createTelemetry } from "./index";

describe("telemetry", () => {
  it("is a no-op without an endpoint", async () => {
    const telemetry = createTelemetry({ serviceName: "test", version: "0" });
    const span = telemetry.startSpan("x", { a: 1 });
    span.end();
    await telemetry.shutdown();
  });

  it("groups a run's spans into one trace derived from the run ID", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry({ serviceName: "test", version: "0", exporter });
    telemetry
      .startSpan("model.call", { "llm.model": "m", skipped: undefined }, { trace: "run_1" })
      .end();
    telemetry.startSpan("tool.call", {}, { trace: "run_1" }).end();
    telemetry.startSpan("other", {}, { trace: "run_2" }).end();
    await telemetry.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["model.call", "tool.call", "other"]);
    const [a, b, c] = spans.map((s) => s.spanContext().traceId);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(spans[0]?.attributes).toEqual({ "llm.model": "m" });
  });

  it("redacts string attributes and recorded errors", async () => {
    const exporter = new InMemorySpanExporter();
    const secret = "secret-value-0123";
    const telemetry = createTelemetry({
      serviceName: "test",
      version: "0",
      exporter,
      redact: (text) => text.split(secret).join("[REDACTED]"),
    });
    const span = telemetry.startSpan("tool.call", { note: `has ${secret}` });
    span.recordError(new Error(`failed with ${secret}`));
    span.end();
    await telemetry.flush();
    const [recorded] = exporter.getFinishedSpans();
    expect(recorded?.attributes).toEqual({ note: "has [REDACTED]" });
    expect(recorded?.events[0]?.attributes?.["exception.message"]).toBe("failed with [REDACTED]");
    expect(JSON.stringify(recorded?.events)).not.toContain(secret);
  });
});
