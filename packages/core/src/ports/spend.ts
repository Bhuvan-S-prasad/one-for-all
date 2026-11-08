import type { RunContext, TenantContext } from "../tenant";

// Paid app credits (EN.15, ADR-0048). The catalog gives each paid call an
// estimate; the executor checks it against the workspace's monthly cap
// before the call and writes it to the ledger when the call starts.

/** The start of the calendar month (UTC) that the cap counts. */
export function spendMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Dollars to whole cents, as the ledger keeps them. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export interface SpendLedger {
  /** This month's spending so far and the cap, in cents; null when there is no cap. */
  month(
    ctx: TenantContext,
  ): Promise<{ readonly spentCents: number; readonly capCents: number | null }>;
  /** Count one call; a second record with the same key is ignored. */
  record(
    ctx: RunContext,
    entry: { readonly idempotencyKey: string; readonly tool: string; readonly costCents: number },
  ): Promise<void>;
}
