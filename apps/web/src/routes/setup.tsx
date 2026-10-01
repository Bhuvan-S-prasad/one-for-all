import { ApiError, useFirstRunSetup, useHealth } from "@ofa/client";
import { firstRunSetupRequestSchema, type FirstRunSetupRequest } from "@ofa/contracts";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Wordmark } from "@/components/brand-mark";
import { Familiar } from "@/components/familiar";
import { FormField } from "@/components/form-field";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { HOUSEHOLD } from "@/lib/familiars";
import { loadSetupStatus } from "@/lib/guards";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await loadSetupStatus(context);
    if (!status.needsSetup) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

type Field = keyof FirstRunSetupRequest;
const EMPTY: FirstRunSetupRequest = { workspaceName: "", name: "", email: "", password: "" };

const STEPS = [
  { title: "Owner account", body: "Full control of this install." },
  { title: "First workspace", body: "Agents, threads and connections live inside it." },
  { title: "Sign-up closes", body: "Nobody else can create an account here." },
];

function SetupPage() {
  const navigate = useNavigate();
  const setup = useFirstRunSetup();
  const health = useHealth();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string>();

  const bind = (field: Field) => ({
    value: values[field],
    error: errors[field],
    onChange: (event: ChangeEvent<HTMLInputElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value })),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);

    // Same schema the API validates with, so most mistakes show without a round trip.
    const parsed = firstRunSetupRequestSchema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});

    setup.mutate(parsed.data, {
      onSuccess: () => navigate({ to: "/" }),
      onError: (error) => {
        if (error instanceof ApiError && error.code === "validation_failed") {
          setErrors(error.fieldErrors() as Partial<Record<Field, string>>);
        } else {
          setFormError(error.message);
        }
      },
    });
  }

  return (
    <main className="flex min-h-dvh flex-col px-4 pt-7 pb-10">
      <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col gap-10">
        <div className="flex items-center justify-between gap-4 px-2">
          <Wordmark />
          <span className="eyebrow text-muted-foreground">
            Self-hosted{health.data && ` · v${health.data.version}`}
          </span>
        </div>

        <div className="grid flex-1 items-stretch gap-10 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-7 px-2">
            <span className="eyebrow text-highlight">First run · This happens once</span>
            <h1 className="text-[clamp(52px,7vw,96px)] leading-[0.88] font-extrabold tracking-[-0.05em]">
              You’re the first one here.
            </h1>
            <p className="max-w-[460px] text-lg leading-normal text-muted-foreground">
              So you become the owner of this install. Set up your account and first workspace, and
              sign-up closes behind you.
            </p>
            <ol className="grid border-t sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex flex-col gap-1.5 pt-4 pr-4">
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[15px] font-semibold">{step.title}</span>
                  <span className="text-sm leading-snug text-muted-foreground">{step.body}</span>
                </li>
              ))}
            </ol>
            <div className="mt-auto hidden items-end overflow-hidden border-b sm:flex">
              <Familiar look={HOUSEHOLD.inbox} gaze="right" size={108} />
              <Familiar look={HOUSEHOLD.ledger} gaze="right" size={124} />
              <Familiar look={HOUSEHOLD.scout} gaze="right" size={148} />
              <Familiar look={HOUSEHOLD.chef} gaze="right" size={112} />
            </div>
          </section>

          <form
            noValidate
            onSubmit={onSubmit}
            className="flex w-full min-w-0 flex-col gap-4.5 self-center rounded-2xl border bg-card p-7 md:p-9"
          >
            <div className="mb-1 flex flex-col gap-1.5">
              <h2 className="text-4xl leading-none font-extrabold">Create the owner account</h2>
              <p className="text-[15px] text-muted-foreground">
                You’ll use this email and password to sign in.
              </p>
            </div>
            {formError && <ErrorAlert>{formError}</ErrorAlert>}
            <FormField
              label="Workspace name"
              placeholder="e.g. Home lab"
              maxLength={80}
              autoFocus
              {...bind("workspaceName")}
            />
            <div className="grid gap-3.5 sm:grid-cols-2">
              <FormField label="Your name" autoComplete="name" maxLength={80} {...bind("name")} />
              <FormField
                label="Email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...bind("email")}
              />
            </div>
            <FormField
              label="Password"
              type="password"
              autoComplete="new-password"
              hint="At least 12 characters."
              maxLength={128}
              {...bind("password")}
            />
            <Button type="submit" size="lg" className="mt-1.5" disabled={setup.isPending}>
              {setup.isPending ? "Creating…" : "Create workspace"}
              <ArrowRight aria-hidden />
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
