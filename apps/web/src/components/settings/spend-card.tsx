import { useSetSpendCap, useSpend } from "@ofa/client";
import { useEffect, useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Paid app credits (EN.15, ADR-0048): what agents used this month through
 * apps that make pictures and video, and the most they may use. Every paid
 * call asks first anyway; the limit stops them even when a person approves.
 */
export function SpendCard({ canEdit }: { canEdit: boolean }) {
  const { data, error } = useSpend();
  const save = useSetSpendCap();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (data) setValue(data.capUsd === null ? "" : String(data.capUsd));
  }, [data?.capUsd]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = value.trim() === "" ? null : Number(value);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    save.mutate(parsed, {
      onSuccess: (s) =>
        toast(s.capUsd === null ? "No monthly limit" : `Monthly limit set to ${usd(s.capUsd)}`),
    });
  };

  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <CardTitle>Paid app credits</CardTitle>
        <p className="text-sm text-muted-foreground">
          Apps like Runway and Higgsfield use your credits there. Each paid call asks you first and
          shows an estimate; the limit stops agents for the rest of the month once it is reached.
        </p>
      </div>
      {error && <ErrorAlert>{error.message}</ErrorAlert>}
      {data && (
        <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
          <dt className="eyebrow text-muted-foreground">This month</dt>
          <dd className="tabular-nums">
            {usd(data.spentUsd)} estimated
            {data.capUsd !== null && ` of ${usd(data.capUsd)}`}
          </dd>
        </dl>
      )}
      {data && canEdit ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Label htmlFor="spend-cap">Monthly limit in US dollars</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="spend-cap"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="No limit"
              aria-invalid={!valid}
              aria-describedby="spend-cap-note"
              className="sm:max-w-48"
            />
            <Button type="submit" disabled={save.isPending || !valid}>
              Save limit
            </Button>
          </div>
          <p id="spend-cap-note" className="text-sm text-muted-foreground">
            {valid ? "Leave it empty for no limit." : "Enter an amount, like 20 or 12.50."}
          </p>
          {save.error && <ErrorAlert>{save.error.message}</ErrorAlert>}
        </form>
      ) : (
        data && (
          <p className="text-sm text-muted-foreground">
            Only an owner or admin can change the limit.
          </p>
        )
      )}
    </Card>
  );
}
