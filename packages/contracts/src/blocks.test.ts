import { describe, expect, it } from "vitest";
import { parseChartSpec } from "./blocks";

describe("parseChartSpec", () => {
  it("reads a valid chart", () => {
    expect(
      parseChartSpec(
        '{"type":"bar","title":"Runs per day","labels":["Mon","Tue"],"series":[{"name":"Runs","values":[4,7]}]}',
      ),
    ).toEqual({
      type: "bar",
      title: "Runs per day",
      labels: ["Mon", "Tue"],
      series: [{ name: "Runs", values: [4, 7] }],
    });
  });

  it("refuses anything that isn't a complete, consistent spec", () => {
    expect(parseChartSpec("not json")).toBeNull();
    expect(
      parseChartSpec('{"type":"pie","labels":["a"],"series":[{"name":"x","values":[1]}]}'),
    ).toBeNull();
    // One value per label.
    expect(
      parseChartSpec('{"type":"line","labels":["a","b"],"series":[{"name":"x","values":[1]}]}'),
    ).toBeNull();
    expect(
      parseChartSpec(
        `{"type":"bar","labels":["a"],"series":${JSON.stringify(
          Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, values: [i] })),
        )}}`,
      ),
    ).toBeNull();
  });
});
