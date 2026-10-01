import { z } from "zod";

// An agent's familiar: the creature that stands for it in every client.
// "Agent" stays the domain term; "familiar" only ever means this avatar.
// The look is chosen by the user; the mood follows the agent's current run.

export const FAMILIAR_FORMS = ["bloom", "blob", "drop", "totem", "ghost", "cookie"] as const;
export const FAMILIAR_EYES = ["googly", "beans", "cyclops", "lids", "rings", "visor"] as const;
export const FAMILIAR_SKINS = ["solid", "stripes", "dots", "checker", "waves"] as const;
export const FAMILIAR_MARKS = ["none", "sprout", "spark", "halo", "cap", "horns"] as const;

/** Body colours, tuned to read on both the dark ground and paper. */
export const FAMILIAR_COLORS = {
  acid: "#d4ff3a",
  mint: "#6ef0c2",
  cobalt: "#3d5bff",
  lilac: "#b7a6ff",
  gum: "#ff9ed2",
  tomato: "#ff5b3a",
  sun: "#ffc93a",
  sand: "#e8dcc6",
  chrome: "#c9cdd3",
  ink: "#2c2c31",
} as const;
export type FamiliarColor = keyof typeof FAMILIAR_COLORS;

export const FAMILIAR_MOODS = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "asleep",
  "error",
] as const;

export const familiarFormSchema = z.enum(FAMILIAR_FORMS);
export const familiarEyesSchema = z.enum(FAMILIAR_EYES);
export const familiarSkinSchema = z.enum(FAMILIAR_SKINS);
export const familiarMarkSchema = z.enum(FAMILIAR_MARKS);
export const familiarColorSchema = z.enum(
  Object.keys(FAMILIAR_COLORS) as [FamiliarColor, ...FamiliarColor[]],
);
export const familiarMoodSchema = z.enum(FAMILIAR_MOODS);

/** What the user picks when hatching an agent. Stored as `agent.avatar`. */
export const familiarLookSchema = z.object({
  form: familiarFormSchema,
  eyes: familiarEyesSchema,
  skin: familiarSkinSchema,
  color: familiarColorSchema,
  mark: familiarMarkSchema,
});

export type FamiliarForm = z.infer<typeof familiarFormSchema>;
export type FamiliarEyes = z.infer<typeof familiarEyesSchema>;
export type FamiliarSkin = z.infer<typeof familiarSkinSchema>;
export type FamiliarMark = z.infer<typeof familiarMarkSchema>;
export type FamiliarMood = z.infer<typeof familiarMoodSchema>;
export type FamiliarLook = z.infer<typeof familiarLookSchema>;
