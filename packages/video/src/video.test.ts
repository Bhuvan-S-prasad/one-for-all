import { describe, expect, it } from "vitest";
import { speechCaptions } from "./captions";
import { handleMcpMessage } from "./mcp";
import { beatOffsets, planSlots, type MusicMap } from "./music";
import { parseProbe, parseSceneMetadata, parseVolume, shotsFrom } from "./parse";
import { captionsAss, clipCommand, clipFilters, safeFilterPath } from "./render";
import { quoteCommand } from "./runner";
import { STYLES, styleById } from "./styles";
import { cutFrames, inFormat, sourceSeconds, timelineSchema, totalFrames } from "./timeline";
import { videoTools } from "./tools";
import type { VideoEngine } from "./engine";

// The engine's arithmetic and command building, without ffmpeg (ADR-0049).
// video.integration.test.ts renders for real on the sandbox image.

/** 120 BPM for 16 s: a bar every 2 s, quiet for 8 s, then loud. */
function song(): MusicMap {
  const beats = Array.from({ length: 32 }, (_, i) => i * 0.5);
  return {
    duration: 16,
    tempo: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    energy: beats.map((b) => (b < 8 ? 0.3 : b === 12 ? 1 : 0.9)),
    sections: [
      { start: 0, end: 8, level: "low" },
      { start: 8, end: 16, level: "high" },
    ],
    tracker: "test",
  };
}

const output = { width: 1280, height: 720, fps: 30 };

describe("planning cuts on the beat", () => {
  it("cuts by section energy, on bars, every slot an exact number of frames", () => {
    const slots = planSlots(song(), styleById("amv")!, { fps: 30 });
    // Low: every 4 beats (2 s = 60 frames); high: every beat (0.5 s = 15 frames).
    expect(slots.slice(0, 4).map((s) => s.frames)).toEqual([60, 60, 60, 60]);
    expect(slots.slice(4).every((s) => s.frames === 15)).toBe(true);
    expect(slots.reduce((n, s) => n + s.frames, 0)).toBe(480);
    // The drop gets the style's drop effects, and the shot before it a ramp.
    const drop = slots.find((s) => s.drop)!;
    expect(drop).toMatchObject({ start: 240, level: "high", downbeat: true });
    expect(drop.effects.map((e) => e.type)).toEqual(["flash", "zoom"]);
    expect(slots[drop.index - 1]!.ramp).toEqual([1, 2.5]);
    // The loudest beat (12 s) is a hit.
    expect(slots.find((s) => s.time === 12)).toMatchObject({ hit: true });
    // Every cut sits on a beat.
    expect(
      beatOffsets(
        slots.map((s) => s.start),
        song(),
        { fps: 30 },
      ),
    ).toEqual(slots.map(() => 0));
  });

  it("counts frames from where the edit starts in the song, at any frame rate", () => {
    const slots = planSlots(song(), styleById("cinematic_trailer")!, { fps: 24, from: 4, to: 12 });
    expect(slots[0]).toMatchObject({ start: 0, time: 4 });
    expect(slots.reduce((n, s) => n + s.frames, 0)).toBe(8 * 24);
    expect(
      beatOffsets(
        slots.map((s) => s.start),
        song(),
        { fps: 24, from: 4 },
      ).every((o) => o === 0),
    ).toBe(true);
  });

  it("never makes a shot shorter than the style allows", () => {
    const fast = {
      ...styleById("amv")!,
      beatsPerCut: { low: 1, mid: 1, high: 1 },
      minShotSeconds: 0.9,
    };
    const slots = planSlots(song(), fast, { fps: 30 });
    expect(slots.every((s) => s.frames >= 27)).toBe(true);
  });

  it("every style has rules and a known grade", () => {
    for (const style of STYLES) {
      expect(style.rules.length).toBeGreaterThan(0);
      expect(timelineSchema.shape.grade.parse({ preset: style.grade })).toBeTruthy();
    }
  });
});

describe("the timeline", () => {
  const timeline = timelineSchema.parse({
    version: 1,
    output,
    clips: [
      { src: "a.mp4", from: 2, frames: 30 },
      { src: "b.mp4", from: 0, frames: 15, ramp: [1, 3] },
      { src: "a.mp4", from: 9, frames: 45, speed: 0.5 },
    ],
  });

  it("knows its length, its cuts and how much source each clip uses", () => {
    expect(totalFrames(timeline)).toBe(90);
    expect(cutFrames(timeline)).toEqual([0, 30, 45]);
    expect(sourceSeconds(timeline.clips[1]!, 30)).toBeCloseTo(1, 5);
    expect(sourceSeconds(timeline.clips[2]!, 30)).toBeCloseTo(0.75, 5);
    expect(inFormat(timeline, "9:16").output).toMatchObject({ width: 1080, height: 1920, fps: 30 });
  });

  it("refuses what can't render: odd sizes, sound on a ramp, an unknown version", () => {
    expect(
      timelineSchema.safeParse({ ...timeline, output: { ...output, width: 1279 } }).success,
    ).toBe(false);
    expect(
      timelineSchema.safeParse({
        ...timeline,
        clips: [{ src: "a", from: 0, frames: 5, ramp: [1, 2], audio: 0 }],
      }).success,
    ).toBe(false);
    expect(timelineSchema.safeParse({ ...timeline, version: 2 }).success).toBe(false);
  });
});

describe("ffmpeg commands", () => {
  const clip = timelineSchema.parse({
    version: 1,
    output,
    clips: [
      {
        src: "in/a b.mp4",
        from: 1.5,
        frames: 20,
        effects: [
          { type: "flash", at: 0, frames: 3 },
          { type: "shake", at: 5, frames: 4, strength: 0.5 },
          { type: "zoom", at: 10, frames: 6 },
        ],
      },
    ],
  }).clips[0]!;

  it("renders a clip to exactly its frames, padded if the source runs out", () => {
    const filters = clipFilters(clip, output);
    expect(filters.slice(0, 5)).toEqual([
      "setpts=(PTS-STARTPTS)/1",
      "fps=30",
      "tpad=stop_mode=clone:stop=20",
      "trim=end_frame=20",
      "setpts=PTS-STARTPTS",
    ]);
    expect(filters.join(",")).toContain("between(n,5,8)");
    expect(filters.join(",")).toMatch(/zoompan=z='if\(between\(on,10,15\)/);
    const args = clipCommand(clip, output, "/w/c.mp4");
    expect(args).toEqual(
      expect.arrayContaining(["-ss", "1.5", "-i", "in/a b.mp4", "-frames:v", "20"]),
    );
    // Silent unless the clip keeps its sound.
    expect(args[args.indexOf("-map", args.indexOf("[v]")) + 1]).toBe("1:a");
  });

  it("maps a speed ramp so it ends where the source runs out", () => {
    const ramp = timelineSchema.parse({
      version: 1,
      output,
      clips: [{ src: "a", from: 0, frames: 30, ramp: [1, 3] }],
    }).clips[0]!;
    const expr = clipFilters(ramp, output)[0]!;
    // T = s0·t + k·t²/2 with s0 = 1, k = 2 per second over 1 s: at T = 2 s, t = 1 s.
    const k = 2;
    const t = (-1 + Math.sqrt(1 + 2 * k * 2)) / k;
    expect(t).toBeCloseTo(1, 6);
    expect(expr).toBe("setpts='(-1+sqrt(1+4*(PTS-STARTPTS)*TB))/2/TB'");
  });

  it("keeps filter paths plain", () => {
    expect(safeFilterPath("/home/a/look.cube")).toBe("/home/a/look.cube");
    expect(() => safeFilterPath("/x/a'b.cube")).toThrow(/Rename/);
    expect(() => safeFilterPath("/x/a:b.cube")).toThrow(/Rename/);
  });

  it("writes captions that read on a phone and can't inject styling", () => {
    const ass = captionsAss([{ text: "hi {\\b1}there", start: 1, end: 2.5 }], "karaoke", {
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,HI B1THERE");
  });

  it("quotes commands for a shell", () => {
    expect(quoteCommand(["ffmpeg", "-i", "my clip.mp4", "-vf", "eq=brightness='0.1'"])).toBe(
      "ffmpeg -i 'my clip.mp4' -vf 'eq=brightness='\\''0.1'\\'''",
    );
  });
});

describe("captions from speech", () => {
  it("moves each clip's words to where it sits in the edit, at its speed", () => {
    const timeline = timelineSchema.parse({
      version: 1,
      output,
      clips: [
        { src: "talk.mp4", from: 10, frames: 60, audio: 0 },
        { src: "broll.mp4", from: 0, frames: 30 },
        { src: "talk.mp4", from: 20, frames: 30, audio: 0, speed: 2 },
      ],
    });
    const words = [
      { text: "hello", start: 10.2, end: 10.6 },
      { text: "there", start: 10.7, end: 11.0 },
      { text: "friend", start: 11.1, end: 11.5 },
      { text: "cut", start: 13, end: 13.4 },
      { text: "fast", start: 20.2, end: 20.6 },
    ];
    const lines = speechCaptions(timeline, () => words, 2);
    expect(lines.map((l) => l.text)).toEqual(["hello there", "friend", "fast"]);
    expect(lines[0]!.start).toBeCloseTo(0.2, 5);
    // The third clip starts at 3 s and plays twice as fast.
    expect(lines[2]!.start).toBeCloseTo(3.1, 5);
    expect(lines[2]!.end).toBeCloseTo(3.3, 5);
  });
});

describe("reading ffmpeg's output", () => {
  it("reads ffprobe, ignoring cover art", () => {
    const info = parseProbe(
      JSON.stringify({
        format: { duration: "12.5" },
        streams: [
          { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30000/1001",
            nb_frames: "375",
          },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }),
    );
    expect(info).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 29.97,
      frames: 375,
      duration: 12.5,
      hasAudio: true,
      videoCodec: "h264",
    });
  });

  it("finds shots and how much they move", () => {
    const text = [
      "frame:0    pts:0       pts_time:0",
      "lavfi.scd.mafd=0.000",
      "lavfi.scd.score=0.000",
      "frame:1    pts:1       pts_time:0.2",
      "lavfi.scd.mafd=4.000",
      "lavfi.scd.score=1.000",
      "frame:2    pts:2       pts_time:0.4",
      "lavfi.scd.mafd=40.000",
      "lavfi.scd.score=35.000",
      "frame:3    pts:3       pts_time:0.6",
      "lavfi.scd.mafd=9.000",
      "lavfi.scd.score=2.000",
    ].join("\n");
    const samples = parseSceneMetadata(text);
    expect(samples).toHaveLength(4);
    expect(shotsFrom(samples, 1)).toEqual([
      { start: 0, end: 0.4, motion: 2, peak: 0.2 },
      { start: 0.4, end: 1, motion: 9, peak: 0.6 },
    ]);
    expect(
      parseVolume("[Parsed_volumedetect_0] mean_volume: -21.5 dB\n[x] max_volume: -0.4 dB"),
    ).toEqual({ mean: -21.5, max: -0.4 });
  });
});

describe("the MCP front door", () => {
  const options = {
    engine: {} as VideoEngine,
    tools: videoTools(async () => ""),
    runner: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: async () => {},
      readFile: async () => new Uint8Array(),
      env: async () => undefined,
    },
  };

  it("lists the tools with JSON schemas and runs one", async () => {
    const init = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      options,
    );
    expect(init).toMatchObject({
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });
    expect(
      await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, options),
    ).toBeNull();
    const list = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      options,
    )) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "scan",
      "music",
      "transcribe",
      "plan_beats",
      "cut_to_music",
      "render",
      "verify",
      "contact_sheet",
      "styles",
    ]);
    expect(list.result.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    // Anthropic accepts only JSON Schema 2020-12: no draft-7 tuples (`items: [..]`).
    expect(JSON.stringify(list.result.tools)).not.toMatch(/"items":\[/);
    expect(JSON.stringify(list.result.tools)).toContain("prefixItems");
    const styles = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "styles", arguments: { id: "amv" } },
      },
      options,
    );
    expect(JSON.stringify(styles)).toContain("Save the strongest shot for the drop");
    const bad = await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "render", arguments: {} } },
      options,
    );
    expect(bad).toMatchObject({ result: { isError: true } });
    expect(
      await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "nope" }, options),
    ).toMatchObject({ error: { code: -32601 } });
  });
});
