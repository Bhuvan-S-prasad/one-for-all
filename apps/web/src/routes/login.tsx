import { useHealth, useLogin } from "@ofa/client";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Wordmark } from "@/components/brand-mark";
import { FormField } from "@/components/form-field";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loadSession, loadSetupStatus, safeRedirect } from "@/lib/guards";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search.redirect);
    return target ? { redirect: target } : {};
  },
  beforeLoad: async ({ context, search }) => {
    const status = await loadSetupStatus(context);
    if (status.needsSetup) throw redirect({ to: "/setup" });
    if (await loadSession(context)) throw redirect({ href: search.redirect ?? "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const { redirect: target } = Route.useSearch();
  const login = useLogin();
  const health = useHealth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => router.history.push(target ?? "/") });
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12">
      <Wordmark className="[&_span]:text-[22px] [&_svg]:size-7" />
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-[380px] flex-col gap-5 rounded-xl border bg-card p-8 shadow-[0_1px_2px_rgb(21_33_44/0.06),0_8px_24px_rgb(21_33_44/0.06)]"
      >
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[26px] font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Use the owner account you created during setup.
          </p>
        </div>
        {login.error && <ErrorAlert>{login.error.message}</ErrorAlert>}
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" size="lg" className="h-11 text-[15px]" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span>Self-hosted</span>
        {health.data && (
          <>
            <span aria-hidden>·</span>
            <span className="font-mono text-xs">v{health.data.version}</span>
          </>
        )}
      </p>
    </main>
  );
}
