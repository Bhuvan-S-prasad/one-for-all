import { createFileRoute } from "@tanstack/react-router";
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
