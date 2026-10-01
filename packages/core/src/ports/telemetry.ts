export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface Span {
  setAttributes(attributes: SpanAttributes): void;
  recordError(error: unknown): void;
  end(): void;
}

/** Thin wrapper over OpenTelemetry so packages do not depend on it directly (ADR-0019). */
export interface Telemetry {
  startSpan(name: string, attributes?: SpanAttributes): Span;
}
