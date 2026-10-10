// Minimal structured logger. Replaced by OpenTelemetry-aware logging in M2.18.
// Never pass request bodies, headers or secrets as fields (hard rule 4).

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: "pretty" | "json";
  /** Output sink; defaults to stdout. Tests pass their own. */
  readonly write?: (line: string) => void;
  /** Replaces known secret values in each line before it is written (hard rule 4). */
  readonly redact?: (text: string) => string;
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return { name: error.name, message: error.message, stack: error.stack };
}

export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const { redact } = options;
  const write = redact ? (line: string) => sink(redact(line)) : sink;
  const threshold = RANK[options.level];

  const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (RANK[level] < threshold) return;
    const all: LogFields = { ...base, ...fields };
    if ("error" in all) all.error = serializeError(all.error);

    if (options.format === "json") {
      write(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...all }));
      return;
    }
    const extras = Object.entries(all)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    write(
      `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${message} ${extras}`.trim(),
    );
  };

  return {
    error: (message, fields) => log("error", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    info: (message, fields) => log("info", message, fields),
    debug: (message, fields) => log("debug", message, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}
