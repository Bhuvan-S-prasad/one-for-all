import { createHash } from "node:crypto";
import { context, trace, TraceFlags, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { noopTelemetry, type SpanAttributes, type Telemetry } from "@ofa/core";

// OpenTelemetry behind the core `Telemetry` port (ADR-0019). Traces hold
// private data, so nothing is exported unless an OTLP endpoint is configured
// (a local Phoenix container in self-host mode). Spans carry IDs, names,
// sizes, tokens and verdicts, never message or tool content.

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly version: string;
  /** OTLP/HTTP base URL, e.g. http://phoenix:6006. Unset: telemetry is off. */
  readonly endpoint?: string;
  /** For tests. */
  readonly exporter?: SpanExporter;
  /** Replaces known secret values in attributes and recorded errors (hard rule 4). */
  readonly redact?: (text: string) => string;
}

export interface TelemetryHandle extends Telemetry {
  /** Send buffered spans now. */
  flush(): Promise<void>;
  /** Flush and stop. Call on shutdown. */
  shutdown(): Promise<void>;
}

/** A run's steps execute separately, so its trace ID is derived from the run ID. */
function idsFor(key: string): { traceId: string; spanId: string } {
  const hash = createHash("sha256").update(key).digest("hex");
  return { traceId: hash.slice(0, 32), spanId: hash.slice(32, 48) };
}

type Redact = (text: string) => string;

function clean(
  attributes: SpanAttributes | undefined,
  redact: Redact,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {}))
    if (value !== undefined) out[key] = typeof value === "string" ? redact(value) : value;
  return out;
}

/** An error as a trace may hold it: its name, and its message and stack with secrets replaced. */
function cleanError(error: unknown, redact: Redact): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const copy = new Error(redact(source.message));
  copy.name = source.name;
  copy.stack = source.stack === undefined ? undefined : redact(source.stack);
  return copy;
}

export function createTelemetry(options: TelemetryOptions): TelemetryHandle {
  const exporter =
    options.exporter ??
    (options.endpoint
      ? new OTLPTraceExporter({ url: `${options.endpoint.replace(/\/$/, "")}/v1/traces` })
      : undefined);
  if (!exporter) return { ...noopTelemetry, flush: async () => {}, shutdown: async () => {} };

  // Not registered globally: Inngest's SDK has its own OpenTelemetry setup.
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "service.version": options.version,
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  const tracer: Tracer = provider.getTracer("one-for-all");
  const redact: Redact = options.redact ?? ((text) => text);

  return {
    startSpan(name, attributes, spanOptions) {
      const parent = spanOptions?.trace
        ? trace.setSpanContext(context.active(), {
            ...idsFor(spanOptions.trace),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          })
        : context.active();
      const span = tracer.startSpan(name, { attributes: clean(attributes, redact) }, parent);
      return {
        setAttributes: (more) => void span.setAttributes(clean(more, redact)),
        recordError: (error) => {
          span.recordException(cleanError(error, redact));
          span.setStatus({ code: 2 });
        },
        end: () => span.end(),
      };
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
