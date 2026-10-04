export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface Span {
  setAttributes(attributes: SpanAttributes): void;
  recordError(error: unknown): void;
  end(): void;
}

export interface SpanOptions {
  /**
   * Groups spans into one trace. A run executes as many separate Inngest
   * steps, so its spans share a trace derived from the run ID rather than a
   * parent span held in memory.
   */
  readonly trace?: string;
}

/** Thin wrapper over OpenTelemetry so packages do not depend on it directly (ADR-0019). */
export interface Telemetry {
  startSpan(name: string, attributes?: SpanAttributes, options?: SpanOptions): Span;
}

/** Telemetry that records nothing: the self-host default (ADR-0019). */
export const noopTelemetry: Telemetry = {
  startSpan: () => ({ setAttributes() {}, recordError() {}, end() {} }),
};
