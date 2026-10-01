import type { FamiliarLook } from "@ofa/contracts";

/**
 * The sample household from the design, used as decoration until real agents
 * exist (M2). Never shown as if these were the user's agents.
 */
export const HOUSEHOLD = {
  scout: { form: "bloom", eyes: "googly", skin: "dots", color: "lilac", mark: "spark" },
  inbox: { form: "ghost", eyes: "beans", skin: "stripes", color: "tomato", mark: "cap" },
  ledger: { form: "totem", eyes: "visor", skin: "checker", color: "mint", mark: "none" },
  sentinel: { form: "drop", eyes: "cyclops", skin: "solid", color: "cobalt", mark: "horns" },
  chef: { form: "blob", eyes: "lids", skin: "waves", color: "sun", mark: "sprout" },
  courier: { form: "cookie", eyes: "rings", skin: "solid", color: "gum", mark: "halo" },
  tinker: { form: "blob", eyes: "lids", skin: "waves", color: "cobalt", mark: "sprout" },
} as const satisfies Record<string, FamiliarLook>;
