import { z } from "zod";

// Watching and taking over an agent's browser (M3.07, ADR-0025), over the
// WebSocket at /api/agents/:id/screen (`?control=1` to take over). Frames go
// to the viewer only; nothing is recorded. Coordinates are CSS pixels of the
// page, as given by each frame's width and height.

const coordinate = z.number().finite().min(0).max(10_000);
const modifiers = z.number().int().min(0).max(15).optional();

export const screenInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up", "wheel"]),
    x: coordinate,
    y: coordinate,
    button: z.enum(["left", "middle", "right"]).optional(),
    clicks: z.number().int().min(1).max(3).optional(),
    deltaX: z.number().finite().min(-5_000).max(5_000).optional(),
    deltaY: z.number().finite().min(-5_000).max(5_000).optional(),
    modifiers,
  }),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    text: z.string().max(4).optional(),
    modifiers,
  }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("navigate"), url: z.url({ protocol: /^https?$/ }).max(2_000) }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("reload") }),
]);
export type ScreenInputMessage = z.infer<typeof screenInputSchema>;

export const screenMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("frame"),
    /** Base64 JPEG. */
    data: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    url: z.string(),
  }),
  /** Whether this viewer has control, and whether someone else does. */
  z.object({
    type: z.literal("status"),
    control: z.boolean(),
    takenOverByOther: z.boolean(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("end"), reason: z.string() }),
]);
export type ScreenMessage = z.infer<typeof screenMessageSchema>;
