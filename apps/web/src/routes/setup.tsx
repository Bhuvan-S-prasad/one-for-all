import { ApiError, useFirstRunSetup } from "@ofa/client";
import { firstRunSetupRequestSchema, type FirstRunSetupRequest } from "@ofa/contracts";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { LayoutPanelTop, Lock, UserRound, type LucideIcon } from "lucide-react";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { BrandMark } from "@/components/brand-mark";
import { FormField } from "@/components/form-field";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

const POINTS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: UserRound, title: "Your owner account", body: "Full control of this install." },
  {
    icon: LayoutPanelTop,
    title: "Your first workspace",
    body: "Agents, threads and connections live inside it.",
  },
  {
    icon: Lock,
    title: "Sign-up stays closed",
    body: "Nobody else can create an account on this install.",
  },
];

function SetupPage() {
  const navigate = useNavigate();
  const setup = useFirstRunSetup();
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
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="grid w-full max-w-[920px] overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgb(21_33_44/0.06),0_8px_24px_rgb(21_33_44/0.06)] md:grid-cols-2">
        <section className="flex flex-col gap-8 bg-[#15212c] p-8 text-[#dde5ed] md:p-10">
          <span className="flex items-center gap-2.5">
            <BrandMark className="size-7 text-[#7daef5]" />
            <span className="font-display text-xl font-semibold">One-for-All</span>
          </span>
          <div className="flex flex-col gap-3">
            <h1 className="text-[34px] leading-tight font-semibold text-white">
              Welcome. Let’s set up this install.
            </h1>
            <p className="text-[15px] leading-relaxed text-[#b4c2cf]">
              You’re the first person here, so you become the owner. This only happens once.
            </p>
          </div>
          <ul className="flex flex-col gap-5">
            {POINTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-[#7daef5]" aria-hidden />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[15px] font-semibold text-white">{title}</span>
                  <span className="text-sm text-[#b4c2cf]">{body}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5 p-8 md:p-10">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold">Create the owner account</h2>
            <p className="text-sm text-muted-foreground">
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
          <FormField label="Your name" autoComplete="name" maxLength={80} {...bind("name")} />
          <FormField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            {...bind("email")}
          />
          <FormField
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters."
            maxLength={128}
            {...bind("password")}
          />
          <Button
            type="submit"
            size="lg"
            className="mt-1 h-11 text-[15px]"
            disabled={setup.isPending}
          >
            {setup.isPending ? "Creating…" : "Create workspace"}
          </Button>
        </form>
      </div>
    </main>
  );
}
