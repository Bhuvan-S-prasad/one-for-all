import {
  useDeleteLlmKey,
  useDeleteLogin,
  useHealth,
  useLlmSettings,
  useSaveLlmKey,
  useSaveLogin,
  useSavedLogins,
} from "@ofa/client";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/secret-input";
import { NotificationsCard } from "@/components/settings/notifications-card";
import { RulesCard } from "@/components/settings/rules-card";
import { Card, CardTitle } from "@/components/ui/card";
import { roleLabel, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
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

      <SavedLoginsCard
        canEdit={session.workspace?.role === "owner" || session.workspace?.role === "admin"}
      />

      <NotificationsCard />

      <RulesCard
        canEditWorkspace={
          session.workspace?.role === "owner" || session.workspace?.role === "admin"
        }
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
      <AboutLine />
    </div>
  );
}

/** Version and server state, moved here from the header (UX.03). */
function AboutLine() {
  const health = useHealth();
  if (!health.data) return null;
  return (
    <p className="px-1 font-mono text-xs text-muted-foreground">
      One-for-All {health.data.version} · {health.data.mode} ·{" "}
      {health.data.status === "ok" ? "server healthy" : "server degraded"}
    </p>
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
                <div className="flex-1">
                  <SecretInput
                    id="llm-key"
                    value={key}
                    onChange={setKey}
                    placeholder="Paste the key"
                    aria-describedby="llm-key-note"
                  />
                </div>
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

/**
 * Saved logins (M3.08, M3.10): an agent with "Sign in with saved logins"
 * types them into that site's own pages and never sees them. The values go
 * from this form to the vault and never come back.
 */
function SavedLoginsCard({ canEdit }: { canEdit: boolean }) {
  const { data: logins, error } = useSavedLogins();
  const save = useSaveLogin();
  const remove = useDeleteLogin();
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!site.trim() || !username || !password) return;
    save.mutate(
      { site: site.trim(), username, password },
      {
        onSuccess: (saved) => {
          setSite("");
          setUsername("");
          setPassword("");
          toast(`Saved the login for ${saved.site}`);
        },
      },
    );
  };

  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <CardTitle>Saved logins</CardTitle>
        <p className="text-sm text-muted-foreground">
          An agent allowed to sign in with saved logins types these into the site's own pages. It
          never sees them, and they are never shown again here.
        </p>
      </div>
      {error && <ErrorAlert>{error.message}</ErrorAlert>}
      {logins && logins.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {logins.map((login) => (
            <li key={login.site} className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1 font-semibold">{login.site}</span>
              <span className="font-mono text-xs text-muted-foreground">
                saved {timeAgo(login.updatedAt)}
              </span>
              {canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(login.site, {
                      onSuccess: () => toast(`Removed the login for ${login.site}`),
                      onError: (e) => toast({ message: e.message, tone: "error" }),
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-site">Site</Label>
            <Input
              id="login-site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="github.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-username">Username or email</Label>
            <Input
              id="login-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-password">Password</Label>
            <SecretInput id="login-password" value={password} onChange={setPassword} />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <Button
              type="submit"
              disabled={save.isPending || !site.trim() || !username || !password}
            >
              Save login
            </Button>
            <span className="text-sm text-muted-foreground">
              Stored encrypted on this server. Passwords need at least 8 characters.
            </span>
          </div>
          {save.error && (
            <div className="sm:col-span-3">
              <ErrorAlert>{save.error.message}</ErrorAlert>
            </div>
          )}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">Only an owner or admin can save logins.</p>
      )}
    </Card>
  );
}
