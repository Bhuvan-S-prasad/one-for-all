import {
  FAMILIAR_COLORS,
  FAMILIAR_EYES,
  FAMILIAR_FORMS,
  FAMILIAR_MARKS,
  FAMILIAR_MOODS,
  FAMILIAR_SKINS,
  type FamiliarColor,
  type FamiliarLook,
} from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { familiarParts } from "./familiar";

const COLORS = Object.keys(FAMILIAR_COLORS) as FamiliarColor[];

function* allLooks(): Generator<FamiliarLook> {
  for (const form of FAMILIAR_FORMS)
    for (const eyes of FAMILIAR_EYES)
      for (const skin of FAMILIAR_SKINS)
        for (const color of COLORS)
          for (const mark of FAMILIAR_MARKS) yield { form, eyes, skin, color, mark };
}

describe("familiarParts", () => {
  it("draws every look in every mood without broken path data", () => {
    const broken: string[] = [];
    let count = 0;
    for (const look of allLooks()) {
      for (const mood of FAMILIAR_MOODS) {
        const parts = familiarParts(look, { mood });
        // Path data is all strings; a bad number shows up as "NaN" or "undefined" in it.
        if (!parts.body || /NaN|undefined|Infinity/.test(JSON.stringify(parts))) {
          broken.push(`${JSON.stringify(look)} ${mood}`);
        }
        count++;
      }
    }
    expect(broken).toEqual([]);
    expect(count).toBe(10_800 * FAMILIAR_MOODS.length);
  });

  it("uses dark ink on light bodies and light ink on dark ones", () => {
    const base = { form: "blob", eyes: "beans", skin: "solid", mark: "none" } as const;
    expect(familiarParts({ ...base, color: "acid" }).faceInk).toBe("#0f0f10");
    expect(familiarParts({ ...base, color: "ink" }).faceInk).toBe("#f4f4f0");
  });

  it("shows a badge only for moods that want attention", () => {
    const look: FamiliarLook = {
      form: "ghost",
      eyes: "googly",
      skin: "stripes",
      color: "tomato",
      mark: "cap",
    };
    expect(familiarParts(look, { mood: "idle" }).badge).toBeNull();
    expect(familiarParts(look, { mood: "waiting" }).badge).not.toBeNull();
    expect(familiarParts(look, { mood: "asleep" }).sleep).not.toBeNull();
  });

  it("an explicit gaze overrides the mood's eye position", () => {
    const look: FamiliarLook = {
      form: "bloom",
      eyes: "googly",
      skin: "dots",
      color: "lilac",
      mark: "spark",
    };
    const left = familiarParts(look, { gaze: "left" }).pupils;
    const right = familiarParts(look, { gaze: "right" }).pupils;
    expect(left).not.toBe(right);
  });
});
