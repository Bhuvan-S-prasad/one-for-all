import { useDeleteLlmKey, useLlmSettings, useSaveLlmKey } from "@ofa/client";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { roleLabel } from "@/lib/format";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";
import { useSignOut } from "@/lib/use-sign-out";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings")({
  staticData: { title: "Settings" },
  component: SettingsPage,
});

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function SettingsPage() {
  const { session } = Route.useRouteContext();
  const { preference } = useTheme();
  const { signOut, pending } = useSignOut();

  return (
    <div className="flex flex-col gap-4">
      <h2 className="mb-1 text-[44px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-[56px]">
        Settings
      </h2>

      <Card className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Appearance</CardTitle>
          <p className="text-sm text-muted-foreground">
            Choose how One-for-All looks on this device.
          </p>
        </div>
        <div
          role="group"
          aria-label="Theme"
          className="flex gap-1 self-start rounded-full border p-1"
        >
          {THEMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={preference === value}
              onClick={() => setThemePreference(value)}
              className={cn(
                "h-10 rounded-full px-4.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                preference === value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      <ModelCard
        canEdit={session.workspace?.role === "owner" || session.workspace?.role === "admin"}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3.5 px-6 py-5">
          <CardTitle>Workspace</CardTitle>
          {session.workspace ? (
            <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
              <dt className="eyebrow text-muted-foreground">Name</dt>
              <dd>{session.workspace.name}</dd>
              <dt className="eyebrow text-muted-foreground">Your role</dt>
              <dd>{roleLabel(session.workspace.role)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">You are not a member of any workspace.</p>
          )}
        </Card>
        <Card className="flex flex-col gap-3.5 px-6 py-5">
          <CardTitle>Account</CardTitle>
          <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
            <dt className="eyebrow text-muted-foreground">Name</dt>
            <dd>{session.user.name}</dd>
            <dt className="eyebrow text-muted-foreground">Email</dt>
            <dd className="truncate">{session.user.email}</dd>
          </dl>
          <Button variant="outline" className="self-start" disabled={pending} onClick={signOut}>
            Sign out
          </Button>
        </Card>
      </div>
    </div>
  );
}

/** The model provider and this workspace's key (M2.21). The key is never shown back. */
function ModelCard({ canEdit }: { canEdit: boolean }) {
  const { data: settings, error } = useLlmSettings();
  const save = useSaveLlmKey();
  const remove = useDeleteLlmKey();
  const [key, setKey] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    save.mutate(key.trim(), { onSuccess: () => setKey("") });
  };

  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <CardTitle>Model</CardTitle>
        <p className="text-sm text-muted-foreground">
          Agents think with a model from {settings?.provider.label ?? "your provider"}, on your own
          key. Free models work.
        </p>
      </div>
      {error && <ErrorAlert>{error.message}</ErrorAlert>}
      {settings && (
        <>
          <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
            <dt className="eyebrow text-muted-foreground">Provider</dt>
            <dd>{settings.provider.label}</dd>
            <dt className="eyebrow text-muted-foreground">API key</dt>
            <dd className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  settings.key.configured ? "bg-success" : "bg-warning",
                )}
              />
              {settings.key.source === "workspace"
                ? `Saved${settings.key.hint ? ` (${settings.key.hint})` : ""}`
                : settings.key.source === "environment"
                  ? "Set on the server (LLM_API_KEY)"
                  : "Not set: agents can't answer yet"}
            </dd>
            {(["fast", "standard", "strong"] as const).map((tier) => (
              <div key={tier} className="contents">
                <dt className="eyebrow text-muted-foreground">{tier}</dt>
                <dd className="truncate font-mono text-xs leading-5 text-muted-foreground">
                  {settings.tiers[tier]?.join(" → ") || "none"}
                </dd>
              </div>
            ))}
          </dl>
          {canEdit ? (
            <form onSubmit={submit} className="flex flex-col gap-2">
              <Label htmlFor="llm-key">
                {settings.key.source === "workspace"
                  ? "Replace the key"
                  : `${settings.provider.label} API key`}
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="llm-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="Paste the key"
                  aria-describedby="llm-key-note"
                />
                <Button type="submit" disabled={save.isPending || !key.trim()}>
                  Save key
                </Button>
                {settings.key.source === "workspace" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p id="llm-key-note" className="text-sm text-muted-foreground">
                Stored encrypted on this server. It is never shown again, and never reaches an
                agent.
              </p>
              {save.error && <ErrorAlert>{save.error.message}</ErrorAlert>}
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only an owner or admin can change the key.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
