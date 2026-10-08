import type { Approval } from "@ofa/contracts";

// What an approval card shows besides the summary (ADR-0030): the call's
// arguments as labelled fields, the written text the person may change, and
// what the main button says.

export interface ApprovalField {
  readonly name: string;
  readonly label: string;
  /** As text: strings as they are, anything else as compact JSON. */
  readonly value: string;
  readonly editable: boolean;
}

/** `page_title` or `pageTitle` → "Page title". */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * The fields a card lists: every argument when the summary doesn't say them
 * (`showArgs`), otherwise only the ones the person may change. Editable ones
 * come last, where the design puts the message.
 */
export function approvalFields(approval: Approval): ApprovalField[] {
  const args =
    approval.args && typeof approval.args === "object" && !Array.isArray(approval.args)
      ? (approval.args as Record<string, unknown>)
      : {};
  const editable = new Set(approval.editable);
  const fields = Object.entries(args)
    .filter(([name, value]) => (approval.showArgs || editable.has(name)) && value !== undefined)
    .map(([name, value]) => ({
      name,
      label: fieldLabel(name),
      value: asText(value),
      editable: editable.has(name) && typeof value === "string",
    }));
  return [...fields.filter((f) => !f.editable), ...fields.filter((f) => f.editable)];
}

/** Only what really changed, so an untouched field runs as the agent wrote it. */
export function changedText(
  fields: readonly ApprovalField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.editable && value !== undefined && value !== field.value) changed[field.name] = value;
  }
  return changed;
}

/** "Approve and send" for a call that sends or posts something, else "Approve". */
export function approveLabel(tool: string, edited: boolean): string {
  if (edited) return "Approve with your changes";
  const action = tool.split(".").pop() ?? tool;
  return /(^|_)(send|post|reply|publish|comment|message)/.test(action)
    ? "Approve and send"
    : "Approve";
}

/** "expires in 23h", "expires in 40 min", "expired". */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  return `expires in ${Math.floor(minutes / 60)}h`;
}
