import type { SkillLibrary } from "@ofa/core";
import { z } from "zod";
import { defineTool } from "../define";

// Skills (ARCHITECTURE.md §8 procedural memory, M5.08): steps for a task the
// agent does again and again. Instructions only (ADR-0018): following a
// skill's steps still means calling tools, each through policy.

export const RUN_SKILL = "run_skill";
export const SAVE_SKILL = "save_skill";

const RUN_DESCRIPTION =
  "Get the steps of one of your saved skills, then follow them. Use it when the request matches a skill's purpose.";

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function runSkillTool(skills: SkillLibrary | null) {
  return defineTool({
    name: RUN_SKILL,
    description: RUN_DESCRIPTION,
    input: z.object({
      skill: z.string().trim().min(2).max(80).describe("The skill's handle, e.g. morning-brief"),
    }),
    annotations: { readOnly: true, idempotent: true },
    async listed(ctx) {
      const list = skills ? await skills.list(ctx) : [];
      if (list.length === 0) return null;
      const roster = list.map((s) => `- ${s.slug}: ${s.name}. ${s.description}`).join("\n");
      return { description: `${RUN_DESCRIPTION}\nYour skills:\n${roster}` };
    },
    async run({ skill }, ctx) {
      const found = skills ? await skills.find(ctx, skill) : null;
      if (!found) {
        const list = skills ? await skills.list(ctx) : [];
        throw coded(
          "unknown_skill",
          list.length
            ? `There is no skill called ${skill}. Your skills: ${list.map((s) => s.slug).join(", ")}.`
            : "You have no skills yet.",
        );
      }
      return {
        content: [
          `Skill "${found.name}" (/${found.slug}): ${found.description}`,
          "Follow these steps in order; if one can't be done, say so and carry on:",
          ...found.steps.map((step, i) => `${i + 1}. ${step}`),
        ].join("\n"),
        // Written or approved by a person, or saved from a run that read no outside content.
        untrusted: false,
      };
    },
  });
}

const SAVE_DESCRIPTION =
  "Save how you just did a task as a skill, so it can be done the same way again (the person can then ask for it with /its-name). Only for a multi-step procedure worth repeating, and only when the person asks for it or the procedure plainly recurs. Not for facts or preferences: those are remembered by themselves. Write steps that work without this conversation.";

export function saveSkillTool(skills: SkillLibrary | null) {
  return defineTool({
    name: SAVE_SKILL,
    description: SAVE_DESCRIPTION,
    input: z.object({
      name: z.string().trim().min(2).max(80).describe("A short name, e.g. Morning brief"),
      description: z.string().trim().min(5).max(500).describe("When to use it"),
      steps: z
        .array(z.string().trim().min(3).max(500))
        .min(2)
        .max(20)
        .describe("The steps, in order, each one an instruction"),
    }),
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    async listed() {
      return skills ? { description: SAVE_DESCRIPTION } : null;
    },
    async describe({ name, steps }) {
      return `Save a skill "${name}" with ${steps.length} steps`;
    },
    async run(input, ctx) {
      if (!skills) throw coded("not_configured", "Skills can't be saved on this server.");
      const saved = await skills.save(ctx, { ...input, tainted: ctx.tainted });
      return {
        content:
          saved.status === "active"
            ? `Saved as your skill /${saved.slug}. The person can ask for it with /${saved.slug}.`
            : `Saved /${saved.slug} as a proposal: this task read outside content, so a person must approve it before it is used.`,
        untrusted: false,
      };
    },
  });
}
