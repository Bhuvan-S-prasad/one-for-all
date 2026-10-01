import { useHealth, useLogin } from "@ofa/client";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Wordmark } from "@/components/brand-mark";
import { Familiar } from "@/components/familiar";
import { FormField } from "@/components/form-field";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { HOUSEHOLD } from "@/lib/familiars";
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
  // The mascot looks away politely while you type your password.
  const [typingPassword, setTypingPassword] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => router.history.push(target ?? "/") });
  }

  return (
    <main className="bg-dots flex min-h-dvh flex-col items-center justify-center gap-7 px-4 py-12">
      <Wordmark className="[&_span]:text-[22px]" />

      <div className="flex w-full max-w-[420px] flex-col items-center">
        <div className="relative z-10 -mb-6.5">
          <Familiar
            look={HOUSEHOLD.scout}
            mood={login.isError ? "error" : "idle"}
            gaze={typingPassword ? "up" : login.isError ? "auto" : "down"}
            size={150}
            ring="var(--card)"
          />
        </div>
        <form
          onSubmit={onSubmit}
          className="flex w-full flex-col gap-4.5 rounded-2xl border bg-card px-8 pt-10 pb-8"
        >
          <div className="flex flex-col gap-1.5 text-center">
            <h1 className="text-[44px] leading-[0.95] font-extrabold tracking-[-0.04em]">
              Welcome back.
            </h1>
            <p className="text-[15px] text-muted-foreground">
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
            onFocus={() => setTypingPassword(true)}
            onBlur={() => setTypingPassword(false)}
          />
          <Button type="submit" size="lg" className="mt-1" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>

      <p className="eyebrow flex items-center gap-2.5 text-muted-foreground">
        <span>Self-hosted</span>
        {health.data && (
          <>
            <span aria-hidden>·</span>
            <span>v{health.data.version}</span>
          </>
        )}
      </p>
    </main>
  );
}
