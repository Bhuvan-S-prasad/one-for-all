// Replace known secret values in text before it reaches a log, trace, tool
// result or run event (ADR-0012, ARCHITECTURE.md §10.4).

export const REDACTED = "[REDACTED]";

/** Shorter values would redact ordinary words, so the vault refuses them. */
export const MIN_SECRET_LENGTH = 8;

/**
 * The forms a secret commonly takes in output: as is, escaped inside a JSON
 * string, and URL-encoded (query strings, form bodies).
 */
function variants(secret: string): string[] {
  return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
}

export type Redactor = (text: string) => string;

/** Build a redactor for a set of secret values. Values under the minimum length are ignored. */
export function createRedactor(secrets: Iterable<string>): Redactor {
  const needles = [
    ...new Set(
      [...secrets].filter((secret) => secret.length >= MIN_SECRET_LENGTH).flatMap(variants),
    ),
  ]
    // Longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);

  if (needles.length === 0) return (text) => text;
  return (text) => needles.reduce((out, needle) => out.split(needle).join(REDACTED), text);
}

export function redactSecrets(text: string, secrets: Iterable<string>): string {
  return createRedactor(secrets)(text);
}

/** Redact every string inside a JSON-like value (tool arguments, results). */
export function redactValue<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactValue(item, redact)]),
    ) as T;
  }
  return value;
}
