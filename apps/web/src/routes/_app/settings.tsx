import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Appearance</h2>
          <p className="text-sm text-muted-foreground">
            Choose how One-for-All looks on this device.
          </p>
        </div>
        <div
          role="group"
          aria-label="Theme"
          className="flex gap-1 self-start rounded-lg bg-muted p-1"
        >
          {THEMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={preference === value}
              onClick={() => setThemePreference(value)}
              className={cn(
                "h-8.5 rounded-md px-3.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                preference === value
                  ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3.5 p-5">
          <h2 className="text-lg font-semibold">Workspace</h2>
          {session.workspace ? (
            <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{session.workspace.name}</dd>
              <dt className="text-muted-foreground">Your role</dt>
              <dd>{roleLabel(session.workspace.role)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">You are not a member of any workspace.</p>
          )}
        </Card>
        <Card className="flex flex-col gap-3.5 p-5">
          <h2 className="text-lg font-semibold">Account</h2>
          <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{session.user.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
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
