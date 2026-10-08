import { ApiError } from "@ofa/client";
import {
  AGENT_VOICES,
  FAMILIAR_COLORS,
  FAMILIAR_EYES,
  FAMILIAR_FORMS,
  FAMILIAR_MARKS,
  FAMILIAR_MOODS,
  FAMILIAR_SKINS,
  type AgentGrant,
  type CreateAgentInput,
  type FamiliarColor,
  type FamiliarLook,
  type FamiliarMood,
} from "@ofa/contracts";
import { MODEL_TIERS } from "@ofa/core";
import { ArrowLeft, ArrowRight, Dices } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { AppGrants } from "@/components/app-grants";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BUILTIN_TOOLS, MOOD_SENTENCES, TIER_INFO } from "@/lib/agents";
import { cn } from "@/lib/utils";

// The hatch flow (M2.24), from the design canvas's "Hatch a new agent":
// 01 Look (familiar, name, voice) → 02 Job → 03 Tools. The same editor
// changes an existing agent.

export interface AgentDraft {
  name: string;
  voice: (typeof AGENT_VOICES)[number];
  look: FamiliarLook;
  job: string;
  description: string;
  tier: (typeof MODEL_TIERS)[number];
  /** Built-in tools switched on. */
  tools: string[];
  /** Every other grant (connected apps, anything set elsewhere), kept as it is unless changed here. */
  grants: AgentGrant[];
}

const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS.map((t) => t.name));

/** The agent's grants, split into built-in switches and the rest. */
export function draftGrants(grants: readonly AgentGrant[]): Pick<AgentDraft, "tools" | "grants"> {
  return {
    tools: grants
      .filter((g) => BUILTIN_NAMES.has(g.tool) && g.mode !== "blocked")
      .map((g) => g.tool),
    grants: grants.filter((g) => !BUILTIN_NAMES.has(g.tool) || g.mode === "blocked"),
  };
}

export function toRequest(draft: AgentDraft): CreateAgentInput {
  const others = draft.grants.filter((g) => !draft.tools.includes(g.tool));
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    spec: { job: draft.job.trim(), modelTier: draft.tier, voice: draft.voice, avatar: draft.look },
    grants: [...draft.tools.map((tool) => ({ tool, mode: "auto" as const })), ...others],
  };
}

const TRAITS = {
  form: {
    label: "Form",
    options: FAMILIAR_FORMS,
    hint: "The silhouette you’ll spot in every list.",
  },
  eyes: {
    label: "Eyes",
    options: FAMILIAR_EYES,
    hint: "Pupils move with what the agent is doing.",
  },
  skin: { label: "Skin", options: FAMILIAR_SKINS, hint: "A print, one tone off the body colour." },
  color: {
    label: "Colour",
    options: Object.keys(FAMILIAR_COLORS) as FamiliarColor[],
    hint: "Ten, tuned to work in light and dark.",
  },
  mark: { label: "Mark", options: FAMILIAR_MARKS, hint: "One small extra that hints at the job." },
} as const;
type Trait = keyof typeof TRAITS;

const STEPS = ["Look", "Job", "Tools"] as const;
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T;

export function randomLook(): FamiliarLook {
  return {
    form: pick(FAMILIAR_FORMS),
    eyes: pick(FAMILIAR_EYES),
    skin: pick(FAMILIAR_SKINS),
    color: pick(Object.keys(FAMILIAR_COLORS) as FamiliarColor[]),
    mark: pick(FAMILIAR_MARKS),
  };
}

interface AgentEditorProps {
  initial: AgentDraft;
  mode: "hatch" | "edit";
  saving: boolean;
  error: unknown;
  onCancel: () => void;
  onSave: (draft: AgentDraft) => void;
}

export function AgentEditor({ initial, mode, saving, error, onCancel, onSave }: AgentEditorProps) {
  const [draft, setDraft] = useState(initial);
  const [step, setStep] = useState(0);
  const [trait, setTrait] = useState<Trait>("form");
  const [mood, setMood] = useState<FamiliarMood>("idle");
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const displayName = draft.name.trim() || "New agent";

  const fieldErrors = error instanceof ApiError ? error.fieldErrors() : {};
  const nameError = touched && !draft.name.trim() ? "Give it a name" : fieldErrors.name;
  const jobError =
    touched && step >= 1 && !draft.job.trim() ? "Say what its one job is" : fieldErrors["spec.job"];

  const next = () => {
    setTouched(true);
    if (step === 0 && !draft.name.trim()) return;
    if (step === 1 && !draft.job.trim()) return;
    if (step < STEPS.length - 1) {
      setTouched(false);
      setStep(step + 1);
    } else {
      onSave(draft);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-4">
        <Button
          variant="outline"
          size="icon"
          aria-label="Back"
          onClick={step === 0 ? onCancel : () => setStep(step - 1)}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <h2 className="flex-1 text-[28px] font-bold tracking-[-0.02em]">
          {mode === "hatch" ? "Hatch a new agent" : `Edit ${initial.name}`}
        </h2>
        <ol aria-label="Steps" className="eyebrow flex gap-1.5 text-xs">
          {STEPS.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className="flex w-24 flex-col gap-1.5"
            >
              <span className={cn("h-1 rounded-full", i <= step ? "bg-primary" : "bg-border")} />
              <button
                type="button"
                className={cn(
                  "text-left",
                  i === step ? "text-foreground" : "text-muted-foreground",
                )}
                onClick={() => (i < step || mode === "edit" ? setStep(i) : undefined)}
              >
                {String(i + 1).padStart(2, "0")} {label}
              </button>
            </li>
          ))}
        </ol>
      </header>

      <div className="grid overflow-hidden rounded-xl border bg-card lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <section
          aria-label="Preview"
          className="bg-dots flex flex-col gap-4 border-b p-6 lg:border-r lg:border-b-0"
        >
          <div className="eyebrow flex justify-between text-xs text-muted-foreground">
            <span>Preview</span>
            <span>
              {capitalise(draft.look.form)} · {capitalise(draft.look.eyes)} ·{" "}
              {capitalise(draft.look.skin)}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1 py-2">
            <Familiar
              look={draft.look}
              mood={mood}
              size={240}
              ring="var(--card)"
              label={`${displayName} familiar, ${mood}`}
            />
            <span className="max-w-full truncate text-[48px] leading-none font-extrabold tracking-[-0.04em]">
              {displayName}
            </span>
            <span className="mt-2 font-mono text-[13px] text-muted-foreground">
              {MOOD_SENTENCES[mood]}
            </span>
          </div>
          <div className="flex flex-col gap-2.5">
            <span id="mood-preview" className="eyebrow text-xs text-muted-foreground">
              Preview a mood
            </span>
            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-labelledby="mood-preview"
                className="flex flex-1 flex-wrap gap-1.5"
              >
                {FAMILIAR_MOODS.map((m) => (
                  <Chip key={m} pressed={m === mood} onClick={() => setMood(m)}>
                    {capitalise(m)}
                  </Chip>
                ))}
              </div>
              <button
                type="button"
                onClick={() => set({ look: randomLook() })}
                aria-label="Surprise me: random look"
                title="Surprise me"
                className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Dices className="size-6" aria-hidden />
              </button>
            </div>
          </div>
        </section>

        <section aria-label="Customise" className="flex min-w-0 flex-col gap-5 p-6">
          {step === 0 && (
            <>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Field label="Name" error={nameError}>
                  {(id, describedBy) => (
                    <Input
                      id={id}
                      value={draft.name}
                      maxLength={40}
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={describedBy}
                      onChange={(e) => set({ name: e.target.value })}
                      className="font-display text-[22px] font-bold"
                    />
                  )}
                </Field>
                <div className="flex flex-col gap-2">
                  <span id="voice-label" className="eyebrow text-xs text-muted-foreground">
                    Voice
                  </span>
                  <div
                    role="group"
                    aria-labelledby="voice-label"
                    className="flex gap-1 rounded-md border bg-field p-1"
                  >
                    {AGENT_VOICES.map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={draft.voice === v}
                        onClick={() => set({ voice: v })}
                        className={cn(
                          "h-10 rounded-sm px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          draft.voice === v
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {capitalise(v)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div role="group" aria-label="Trait" className="flex flex-wrap gap-2 border-b pb-4">
                {(Object.keys(TRAITS) as Trait[]).map((t) => (
                  <Chip key={t} pressed={t === trait} onClick={() => setTrait(t)} large>
                    {TRAITS[t].label}
                    <span className="font-mono text-[11px] font-medium opacity-70">
                      {TRAITS[t].options.length}
                    </span>
                  </Chip>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-[26px] font-bold tracking-[-0.02em]">{TRAITS[trait].label}</h3>
                <p className="text-[15px] text-muted-foreground">{TRAITS[trait].hint}</p>
              </div>

              {trait === "color" ? (
                <div className="grid grid-cols-5 gap-2.5">
                  {TRAITS.color.options.map((c) => (
                    <Tile
                      key={c}
                      pressed={draft.look.color === c}
                      onClick={() => set({ look: { ...draft.look, color: c } })}
                    >
                      <span
                        aria-hidden
                        className="size-9 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
                        style={{ background: FAMILIAR_COLORS[c] }}
                      />
                      <span className="eyebrow text-[11px]">{c}</span>
                    </Tile>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {(TRAITS[trait].options as readonly string[]).map((option) => {
                    const look = { ...draft.look, [trait]: option } as FamiliarLook;
                    return (
                      <Tile
                        key={option}
                        pressed={draft.look[trait] === option}
                        onClick={() => set({ look })}
                        tall
                      >
                        <Familiar look={look} size={92} ring="var(--card)" />
                        <span className="eyebrow text-[11px]">{option}</span>
                      </Tile>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex flex-col gap-1">
                <h3 className="text-[26px] font-bold tracking-[-0.02em]">
                  What is {displayName} for?
                </h3>
                <p className="text-[15px] text-muted-foreground">
                  One clear job works best. Ask for specific tasks in the chat.
                </p>
              </div>
              <Field
                label="Its job"
                hint="Shown under its name, e.g. “Researches topics and writes short briefs”"
                error={jobError}
              >
                {(id, describedBy) => (
                  <Input
                    id={id}
                    value={draft.job}
                    maxLength={80}
                    aria-invalid={jobError ? true : undefined}
                    aria-describedby={describedBy}
                    onChange={(e) => set({ job: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Standing rules"
                hint="Always true, whatever you ask: tone, sources to prefer, things never to do. Optional."
                error={fieldErrors.description}
              >
                {(id, describedBy) => (
                  <textarea
                    id={id}
                    value={draft.description}
                    maxLength={4000}
                    rows={5}
                    aria-describedby={describedBy}
                    onChange={(e) => set({ description: e.target.value })}
                    className="w-full rounded-md border border-input bg-field px-4 py-3 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
                  />
                )}
              </Field>
              <div className="flex flex-col gap-2">
                <span id="tier-label" className="eyebrow text-xs text-muted-foreground">
                  Model
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="tier-label"
                  className="grid gap-2.5 sm:grid-cols-3"
                >
                  {MODEL_TIERS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={draft.tier === t}
                      onClick={() => set({ tier: t })}
                      className={cn(
                        "flex flex-col items-start gap-1 rounded-md border-2 bg-card px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        draft.tier === t ? "border-primary" : "border-border",
                      )}
                    >
                      <span className="font-semibold">{TIER_INFO[t].label}</span>
                      <span className="text-sm text-muted-foreground">{TIER_INFO[t].hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex flex-col gap-1">
                <h3 className="text-[26px] font-bold tracking-[-0.02em]">
                  What may {displayName} use?
                </h3>
                <p className="text-[15px] text-muted-foreground">
                  It can only use what you switch on here.
                </p>
              </div>
              <ul className="flex flex-col divide-y rounded-md border">
                {BUILTIN_TOOLS.map((tool) => {
                  const on = draft.tools.includes(tool.name);
                  return (
                    <li key={tool.name} className="flex items-center gap-4 px-4 py-3">
                      <div className="flex flex-1 flex-col gap-0.5">
                        <span className="font-semibold">{tool.label}</span>
                        <span className="text-sm text-muted-foreground">{tool.hint}</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={tool.label}
                        onClick={() =>
                          set({
                            tools: on
                              ? draft.tools.filter((t) => t !== tool.name)
                              : [...draft.tools, tool.name],
                          })
                        }
                        className={cn(
                          "eyebrow h-9 w-16 shrink-0 rounded-full text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          on
                            ? "bg-primary text-primary-foreground"
                            : "border text-muted-foreground",
                        )}
                      >
                        {on ? "On" : "Off"}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-col gap-1">
                <h4 className="eyebrow text-xs text-muted-foreground">Apps</h4>
                <p className="text-sm text-muted-foreground">
                  Connected apps it may use. Anything that can't be undone, and anything after it
                  read outside content, still asks you first.
                </p>
              </div>
              <AppGrants
                grants={draft.grants.filter((g) => !BUILTIN_NAMES.has(g.tool))}
                onChange={(apps) =>
                  set({
                    grants: [...draft.grants.filter((g) => BUILTIN_NAMES.has(g.tool)), ...apps],
                  })
                }
                agentName={displayName}
              />
            </>
          )}

          {error && !Object.keys(fieldErrors).length ? (
            <ErrorAlert>{error instanceof Error ? error.message : "Couldn't save"}</ErrorAlert>
          ) : null}

          <div className="mt-auto flex flex-wrap items-center justify-between gap-4 pt-2">
            <span className="font-mono text-xs text-muted-foreground">
              {step === 0
                ? "You can change the look any time."
                : "You can change this later in its settings."}
            </span>
            <div className="flex gap-2.5">
              <Button variant="outline" size="lg" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="lg" onClick={next} disabled={saving}>
                {step === 0
                  ? "Next: give it a job"
                  : step === 1
                    ? "Next: tools"
                    : mode === "hatch"
                      ? `Hatch ${displayName}`
                      : "Save changes"}
                {step < 2 && <ArrowRight aria-hidden />}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Chip(props: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={cn(
        "flex items-center gap-2 rounded-full border font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.large ? "h-11 px-4.5 text-[15px] font-semibold" : "h-9 px-3.5 text-[13px]",
        props.pressed
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function Tile(props: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  tall?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.tall ? "h-36" : "h-24",
        props.pressed ? "border-primary bg-primary/10" : "border-border bg-card hover:border-input",
      )}
    >
      {props.children}
    </button>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const note = props.error ?? props.hint;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{props.label}</Label>
      {props.children(id, note ? `${id}-note` : undefined)}
      {note && (
        <p
          id={`${id}-note`}
          className={props.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {note}
        </p>
      )}
    </div>
  );
}
