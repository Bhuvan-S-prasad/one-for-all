import { z } from "zod";

// Fenced blocks a reply may contain besides Markdown (UX.16). The model writes
// a spec; the app checks it here and draws it. Anything invalid is shown as
// plain text, so nothing the model writes ever runs.

export const CHART_TYPES = ["bar", "line"] as const;
export const MAX_CHART_POINTS = 60;
export const MAX_CHART_SERIES = 4;

const label = z.string().trim().min(1).max(40);

/**
 * A chart in a ```chart block, as JSON:
 * `{"type":"bar","title":"Runs per day","labels":["Mon","Tue"],"series":[{"name":"Runs","values":[4,7]}]}`
 */
export const chartSpecSchema = z
  .object({
    type: z.enum(CHART_TYPES),
    title: z.string().trim().min(1).max(120).optional(),
    labels: z.array(label).min(1).max(MAX_CHART_POINTS),
    series: z
      .array(
        z.object({
          name: label,
          values: z.array(z.number().finite()).min(1).max(MAX_CHART_POINTS),
        }),
      )
      .min(1)
      .max(MAX_CHART_SERIES),
    /** Unit for the values, e.g. "%", "ms", "USD". */
    unit: z.string().trim().max(12).optional(),
  })
  .refine((spec) => spec.series.every((s) => s.values.length === spec.labels.length), {
    message: "Every series needs one value per label",
    path: ["series"],
  });
export type ChartSpec = z.infer<typeof chartSpecSchema>;

/** The chart in a block's text, or null when it is not a valid spec. */
export function parseChartSpec(text: string): ChartSpec | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = chartSpecSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
