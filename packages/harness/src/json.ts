// JSON answers from small models (M5.09). Free models often think aloud
// before answering, sometimes repeating the shape the prompt showed, and a
// long answer can be cut off. So: take the last complete object that has one
// of the expected keys, and treat placeholder text as no value at all.

/** Every balanced `{…}` in the text, outermost only, in order. */
function objectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}

/** The last complete JSON object in the text with any of `keys`, or null. */
export function lastJsonObject(
  text: string,
  keys: readonly string[],
): Record<string, unknown> | null {
  const spans = objectSpans(text);
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(spans[i]!) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        keys.some((k) => k in (parsed as object))
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON (prose with braces, or cut off): try the one before.
    }
  }
  return null;
}

/** "...", "…" or "<one sentence>": a shape copied from the prompt, not an answer. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return /^(\.{2,}|…+|<[^>]*>)$/.test(v);
}
