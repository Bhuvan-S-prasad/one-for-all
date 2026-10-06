import {
  useConnectMcpServer,
  useDisconnectMcpServer,
  useInstallCatalogEntry,
  useMcpCatalog,
  useMcpServers,
  useRemoveMcpServer,
} from "@ofa/client";
import type { CatalogItem, McpServer } from "@ofa/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KeyRound, Lock, Plug, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { SecretInput } from "@/components/secret-input";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Connections (M4.04): apps from the reviewed catalog. An owner or admin adds
// an app; each person then signs in to it on the app's own page, which sends
// them back here. Agents use an app's tools with the sign-in of the person
// they work for. Per-agent tools, rules and custom servers come in M4.09.

interface ConnectionsSearch {
  connected?: string;
  error?: string;
}

export const Route = createFileRoute("/_app/connections")({
  staticData: { title: "Connections" },
  validateSearch: (search: Record<string, unknown>): ConnectionsSearch => ({
    ...(typeof search.connected === "string" ? { connected: search.connected } : {}),
    ...(typeof search.error === "string" ? { error: search.error.slice(0, 300) } : {}),
  }),
  component: ConnectionsPage,
});

/** One app as the page shows it: a catalog entry, a custom server, or both. */
interface AppRow {
  readonly key: string;
  readonly item: CatalogItem | null;
  readonly server: McpServer | null;
}

function ConnectionsPage() {
  const { session } = Route.useRouteContext();
  const canEdit = session.workspace?.role === "owner" || session.workspace?.role === "admin";
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const catalog = useMcpCatalog();
  const servers = useMcpServers();
  // Back from signing in with a problem: show it until the next attempt.
  const [failure, setFailure] = useState<string | null>(() => search.error ?? null);

  // Back from signing in: say how it went once, then tidy the address.
  useEffect(() => {
    if (!search.connected && !search.error) return;
    if (search.connected) {
      const name = servers.data?.find((s) => s.slug === search.connected)?.name;
      toast(`Connected to ${name ?? search.connected}`);
    }
    void navigate({ search: {}, replace: true });
  }, [search.connected, search.error, servers.data, navigate]);

  const byCatalog = new Map((servers.data ?? []).map((s) => [s.catalogId, s]));
  const rows: AppRow[] = [
    ...(catalog.data?.items ?? []).map((item) => ({
      key: item.id,
      item,
      server: byCatalog.get(item.id) ?? null,
    })),
    ...(servers.data ?? [])
      .filter((s) => !s.catalogId)
      .map((server) => ({ key: server.id, item: null, server })),
  ];
  const signedIn = (row: AppRow) =>
    row.server?.connection?.status === "active" ||
    row.server?.connection?.status === "needs_reauth";
  const connected = rows.filter(signedIn);
  const available = rows.filter((row) => !signedIn(row));
  const loading = catalog.isPending || servers.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-[44px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-[56px]">
          Connections
        </h2>
        <p className="max-w-2xl text-[15px] text-muted-foreground">
          Let your agents work in the apps you use. You sign in once, on the app's own page; agents
          then act with your access, within the permissions you give them.
        </p>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3" aria-label="How connections work">
        <Step n={1} icon={<Plug className="size-4" />} title="Add an app">
          {canEdit
            ? "Choose from reviewed apps. Some need an OAuth app you create first."
            : "An owner or admin chooses which apps your workspace can use."}
        </Step>
        <Step n={2} icon={<Lock className="size-4" />} title="Sign in">
          On the app's own page. The sign-in is stored encrypted; agents never see it.
        </Step>
        <Step n={3} icon={<Wrench className="size-4" />} title="Allow tools">
          Choose, per agent, which of the app's tools it may use and which need your approval.
        </Step>
      </ol>

      {failure && <ErrorAlert>{failure}</ErrorAlert>}
      {(catalog.error || servers.error) && (
        <ErrorAlert>{(catalog.error ?? servers.error)?.message}</ErrorAlert>
      )}

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton h-[196px] rounded-[20px]" />
          ))}
        </div>
      ) : (
        <>
          <Section title="Connected" count={connected.length}>
            {connected.length === 0 ? (
              <p className="rounded-[20px] border border-dashed px-5 py-6 text-sm text-muted-foreground">
                Nothing connected yet. Pick an app below to get started.
              </p>
            ) : (
              <Grid>
                {connected.map((row) => (
                  <AppCard
                    key={row.key}
                    row={row}
                    canEdit={canEdit}
                    redirectUrl={catalog.data?.redirectUrl ?? ""}
                    onError={setFailure}
                  />
                ))}
              </Grid>
            )}
          </Section>
          {available.length > 0 && (
            <Section title="Available apps" count={available.length}>
              <Grid>
                {available.map((row) => (
                  <AppCard
                    key={row.key}
                    row={row}
                    canEdit={canEdit}
                    redirectUrl={catalog.data?.redirectUrl ?? ""}
                    onError={setFailure}
                  />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Step({
  n,
  icon,
  title,
  children,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 rounded-[16px] border bg-card px-4 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="eyebrow text-[10.5px] text-muted-foreground">Step {n}</span>
        <span className="font-semibold">{title}</span>
        <span className="text-[13px] leading-snug text-muted-foreground">{children}</span>
      </div>
    </li>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h3 className="eyebrow flex items-center gap-2 text-[11px] text-muted-foreground">
        {title}
        <span className="rounded-full bg-accent px-1.5 py-px font-mono">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</ul>;
}

type State = "connected" | "reauth" | "ready" | "not_added";

function stateOf(server: McpServer | null): State {
  if (!server) return "not_added";
  if (server.connection?.status === "active") return "connected";
  if (server.connection?.status === "needs_reauth") return "reauth";
  return "ready";
}

/** The status in a word, with a dot for scanning; never colour alone. */
function StatusPill({ state }: { state: State }) {
  const [word, tone] = {
    connected: ["Connected", "bg-primary/15 text-highlight"],
    reauth: ["Sign in again", "bg-destructive-surface text-destructive"],
    ready: ["Not signed in", "bg-accent text-muted-foreground"],
    not_added: ["Not added", "bg-accent text-muted-foreground"],
  }[state];
  return (
    <span
      className={cn(
        "eyebrow inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[10.5px] whitespace-nowrap",
        tone,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {word}
    </span>
  );
}

function AppCard({
  row,
  canEdit,
  redirectUrl,
  onError,
}: {
  row: AppRow;
  canEdit: boolean;
  redirectUrl: string;
  onError: (message: string) => void;
}) {
  const { item, server } = row;
  const name = item?.name ?? server?.name ?? "";
  const state = stateOf(server);
  const install = useInstallCatalogEntry();
  const connect = useConnectMcpServer();
  const disconnect = useDisconnectMcpServer();
  const remove = useRemoveMcpServer();
  const [settingUp, setSettingUp] = useState(false);
  const busy = install.isPending || connect.isPending || disconnect.isPending || remove.isPending;

  const signIn = (id: string) =>
    connect.mutate(id, {
      onSuccess: (result) => {
        if (result.status === "redirect") window.location.assign(result.authorizationUrl);
        else toast(`Connected to ${name}`);
      },
      onError: (error) => onError(error.message),
    });

  let detail: ReactNode = null;
  if (state === "connected") {
    detail = server?.connection?.lastUsedAt
      ? `Last used ${timeAgo(server.connection.lastUsedAt)}`
      : "Not used by an agent yet";
  } else if (state === "reauth") {
    detail = server?.connection?.lastError ?? "The sign-in expired.";
  } else if (state === "not_added" && item) {
    detail =
      item.setup === "automatic" ? (
        "No setup needed"
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="size-3.5" aria-hidden />
          Needs an OAuth app you create first
        </span>
      );
  } else if (!item && server) {
    detail = <span className="font-mono text-xs break-all">{server.url}</span>;
  }

  let primary: ReactNode = null;
  if (state === "connected" && server) {
    primary = (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          disconnect.mutate(server.id, {
            onSuccess: () => toast(`Signed out of ${name}`),
            onError: (error) => onError(error.message),
          })
        }
      >
        Disconnect
      </Button>
    );
  } else if ((state === "reauth" || state === "ready") && server) {
    primary = (
      <Button size="sm" disabled={busy} onClick={() => signIn(server.id)}>
        {state === "reauth" ? "Sign in again" : "Connect"}
      </Button>
    );
  } else if (item && canEdit && item.setup === "automatic") {
    primary = (
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          install.mutate(
            { entry: item.id },
            {
              onSuccess: (added) => signIn(added.id),
              onError: (error) => onError(error.message),
            },
          )
        }
      >
        Add and connect
      </Button>
    );
  } else if (item && canEdit && !settingUp) {
    primary = (
      <Button size="sm" variant="outline" onClick={() => setSettingUp(true)}>
        Set up
      </Button>
    );
  } else if (item && !canEdit) {
    primary = (
      <span className="text-[13px] text-muted-foreground">Ask an owner or admin to add it</span>
    );
  }

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-[20px] border bg-card px-4 pt-4 pb-3.5",
        settingUp && "md:col-span-2 xl:col-span-3",
      )}
    >
      <div className="flex items-start gap-3">
        <AppIcon id={item?.id ?? null} name={name} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="truncate text-[20px] leading-tight font-bold tracking-[-0.015em]">
              {name}
            </span>
            <StatusPill state={state} />
          </div>
          {item && (
            <p className="text-[13.5px] leading-snug text-muted-foreground">{item.description}</p>
          )}
        </div>
      </div>
      {detail && (
        <p
          className={cn(
            "text-[13px]",
            state === "reauth" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail}
        </p>
      )}
      {settingUp && item && (
        <OwnClientForm item={item} redirectUrl={redirectUrl} onDone={() => setSettingUp(false)} />
      )}
      {(primary || (canEdit && server)) && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {primary}
          {canEdit && server && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Remove ${name}? Everyone's sign-in to it goes too.`)) return;
                remove.mutate(server.id, {
                  onSuccess: () => toast(`Removed ${name}`),
                  onError: (error) => onError(error.message),
                });
              }}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** For apps that can't register One-for-All themselves: the admin's own OAuth app. */
function OwnClientForm({
  item,
  redirectUrl,
  onDone,
}: {
  item: CatalogItem;
  redirectUrl: string;
  onDone: () => void;
}) {
  const install = useInstallCatalogEntry();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const provider = item.name.split(" ")[0];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!clientId.trim()) return;
    install.mutate(
      {
        entry: item.id,
        client: { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) },
      },
      {
        onSuccess: () => {
          toast(`${item.name} is added. Connect to sign in.`);
          onDone();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-[14px] border bg-background p-4">
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] text-muted-foreground">
        <li>
          Create an OAuth app (a "web application" client) in {provider}'s developer settings
          {item.guide ? (
            <>
              {" "}
              (step by step: <span className="font-mono text-xs">{item.guide}</span>)
            </>
          ) : null}
          .
        </li>
        <li>
          Give it this redirect address:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
            {redirectUrl}
          </code>
        </li>
        <li>Paste its client ID and secret here.</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${item.id}-client-id`}>Client ID</Label>
          <Input
            id={`${item.id}-client-id`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${item.id}-client-secret`}>Client secret</Label>
          <SecretInput
            id={`${item.id}-client-secret`}
            value={clientSecret}
            onChange={setClientSecret}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={install.isPending || !clientId.trim()}>
          Add {item.name}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="text-[13px] text-muted-foreground">The secret is stored encrypted.</span>
      </div>
      {install.error && <ErrorAlert>{install.error.message}</ErrorAlert>}
    </form>
  );
}
