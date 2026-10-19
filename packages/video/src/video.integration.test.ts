import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVideoEngine, type VideoEngine } from "./engine";
import type { Runner, RunResult } from "./runner";
import type { TimelineInput } from "./timeline";
import { videoTools } from "./tools";

// The engine end to end on the sandbox image (its ffmpeg, librosa and
// faster-whisper), in a throwaway container. Fixtures are made there with
// ffmpeg: two test patterns, a 120 BPM click track that gets louder at 8 s,
// and synthetic speech. Needs Docker and the image (`pnpm infra:up` builds
// it); OFA_VIDEO_TEST_IMAGE picks another.

const IMAGE = process.env.OFA_VIDEO_TEST_IMAGE ?? "one-for-all-sandbox:local";

function docker(args: string[], input?: Uint8Array | string): Promise<RunResult & { raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = Buffer.concat(out);
      resolve({
        code: code ?? 1,
        stdout: raw.toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        raw,
      });
    });
    child.stdin.end(input ?? "");
  });
}

/** Commands in the container, as the agent's computer would run them. */
function containerRunner(id: string): Runner {
  return {
    run: (argv) => docker(["exec", id, ...argv]),
    async writeFile(path, content) {
      const r = await docker(
        ["exec", "-i", id, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
        content,
      );
      if (r.code !== 0) throw new Error(r.stderr);
    },
    async readFile(path) {
      const r = await docker(["exec", id, "cat", path]);
      if (r.code !== 0) throw new Error(r.stderr);
      return new Uint8Array(r.raw);
    },
    async env(name) {
      const r = await docker(["exec", id, "printenv", name]);
      return r.code === 0 ? r.stdout.trim() : undefined;
    },
  };
}

let id = "";
let runner: Runner;
let engine: VideoEngine;
const sh = async (script: string) => {
  const r = await runner.run(["sh", "-c", script]);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
};

beforeAll(async () => {
  const started = await docker(["run", "-d", "--rm", "--entrypoint", "sleep", IMAGE, "infinity"]);
  if (started.code !== 0) throw new Error(`Couldn't start ${IMAGE}: ${started.stderr}`);
  id = started.stdout.trim();
  runner = containerRunner(id);
  engine = createVideoEngine({ runner, workDir: "/work/.ofa-video" });
  await sh(
    [
      "mkdir -p /work/in /work/out",
      "cd /work/in",
      "ffmpeg -v error -f lavfi -i testsrc2=s=1280x720:r=30:d=12 -f lavfi -i sine=f=300:d=12 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac a.mp4",
      "ffmpeg -v error -f lavfi -i mandelbrot=s=1280x720:r=30 -t 12 -c:v libx264 -pix_fmt yuv420p b.mp4",
      // 120 BPM: a click every 0.5 s, a stronger one on each bar, louder from 8 s, over a low hum.
      'ffmpeg -v error -f lavfi -i "aevalsrc=(0.25+0.6*gte(t\\,8))*(0.6+0.4*lt(mod(t\\,2)\\,0.25))*sin(2*PI*1000*t)*exp(-30*mod(t\\,0.5))+0.03*sin(2*PI*110*t):s=44100:d=16" -c:a libmp3lame song.mp3',
      "ffmpeg -v error -f lavfi -i \"flite=text='the quick brown fox jumps over the lazy dog':voice=slt\" -f lavfi -i color=c=navy:s=1280x720:r=30 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac talk.mp4",
    ].join(" && "),
  );
}, 240_000);

afterAll(async () => {
  if (id) await docker(["rm", "-f", id]);
});

describe("the video engine on the sandbox image", () => {
  it("reads footage: size, length, sound and shots", async () => {
    const scan = await engine.scan("/work/in/a.mp4");
    expect(scan.info).toMatchObject({ width: 1280, height: 720, fps: 30, hasAudio: true });
    expect(scan.info.duration).toBeCloseTo(12, 0);
    expect(scan.shots.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("measures the song, plans slots on its beats, renders them exactly and checks it", async () => {
    const map = await engine.music("/work/in/song.mp3");
    const gaps = map.beats.slice(1).map((b, i) => b - map.beats[i]!);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    // 120 BPM, or the tracker's half or double of it.
    expect([0.25, 0.5, 1].some((g) => Math.abs(median - g) < 0.04)).toBe(true);
    expect(map.sections.at(-1)?.level).toBe("high");

    const slots = engine.plan(map, "amv", { fps: 30, from: 0, to: 14 });
    expect(slots.length).toBeGreaterThan(5);
    expect(slots.some((s) => s.drop)).toBe(true);
    expect(slots.reduce((n, s) => n + s.frames, 0)).toBe(14 * 30);

    // One clip per slot, alternating sources so every cut is visible.
    let fromA = 0;
    let fromB = 0;
    const timeline: TimelineInput = {
      version: 1,
      output: { width: 640, height: 360, fps: 30 },
      music: { src: "/work/in/song.mp3", from: 0 },
      clips: slots.map((slot, i) => {
        const src = i % 2 ? "/work/in/b.mp4" : "/work/in/a.mp4";
        const from = i % 2 ? fromB : fromA;
        const speed = slot.ramp ? undefined : 1;
        const used = (slot.frames / 30) * (slot.ramp ? (slot.ramp[0] + slot.ramp[1]) / 2 : 1);
        if (i % 2) fromB = (fromB + used) % 10;
        else fromA = (fromA + used) % 10;
        return {
          src,
          from,
          frames: slot.frames,
          ...(speed ? { speed } : {}),
          ...(slot.ramp ? { ramp: [slot.ramp[0], slot.ramp[1]] as [number, number] } : {}),
          effects: slot.effects.map((e) => ({ ...e, at: 0 })),
        };
      }),
      captions: { style: "bold_center", lines: [{ text: "One for all", start: 0.5, end: 2 }] },
      grade: { preset: "punchy" },
    };

    const first = await engine.render(timeline, { output: "/work/out/edit.mp4" });
    expect(first).toMatchObject({ frames: 420, clips: slots.length, rendered: slots.length });
    const report = await engine.verify(timeline, "/work/out/edit.mp4", { music: map });
    expect(report.problems).toEqual([]);
    expect(report.output).toMatchObject({ width: 640, height: 360, frames: 420 });
    expect(report.cuts.found).toBeGreaterThanOrEqual(report.cuts.planned - 1);
    expect(report.cuts.beatOffsets!.every((o) => Math.abs(o) <= 1)).toBe(true);

    // Nothing changed: every clip is reused.
    const again = await engine.render(timeline, { output: "/work/out/edit-again.mp4" });
    expect(again.rendered).toBe(0);

    // The tools: another shape, a contact sheet of the cuts.
    const tools = videoTools(async (p) => new TextDecoder().decode(await runner.readFile(p)));
    const render = tools.find((t) => t.name === "render")!;
    const out = await render.run(
      engine,
      render.input.parse({ timeline, output: "/work/out/edit.mp4", formats: ["9:16"] }),
    );
    expect(out.files).toEqual(["/work/out/edit.mp4", "/work/out/edit-9x16.mp4"]);
    expect(await engine.probe("/work/out/edit-9x16.mp4")).toMatchObject({
      width: 1080,
      height: 1920,
    });
    const sheet = tools.find((t) => t.name === "contact_sheet")!;
    const made = await sheet.run(
      engine,
      sheet.input.parse({ path: "/work/out/edit.mp4", timeline, output: "/work/out/cuts.jpg" }),
    );
    expect(made.image).toBe("/work/out/cuts.jpg");
    expect((await runner.readFile("/work/out/cuts.jpg")).length).toBeGreaterThan(1_000);
  }, 900_000);

  it("cuts to music in one call: a saved timeline that renders on the beat", async () => {
    const tools = videoTools(async (p) => new TextDecoder().decode(await runner.readFile(p)));
    const cut = tools.find((t) => t.name === "cut_to_music")!;
    const made = await cut.run(
      engine,
      cut.input.parse({
        music: "/work/in/song.mp3",
        sources: ["/work/in/a.mp4", "/work/in/b.mp4"],
        style: "amv",
        from: 2,
        to: 14,
        format: "9:16",
        credit: "Test credit",
        timeline_out: "/work/out/auto.timeline.json",
      }),
    );
    expect(made.text).toMatch(
      /Timeline saved to \/work\/out\/auto\.timeline\.json: \d+ clips, 360 frames/,
    );
    expect(made.text).toContain("1080×1920");

    const render = tools.find((t) => t.name === "render")!;
    const done = await render.run(
      engine,
      render.input.parse({
        timeline_file: "/work/out/auto.timeline.json",
        output: "/work/out/auto.mp4",
      }),
    );
    expect(done.text).toMatch(/Rendered \/work\/out\/auto\.mp4: 1080×1920, 30 fps, 360 frames/);

    const verify = tools.find((t) => t.name === "verify")!;
    const checked = await verify.run(
      engine,
      verify.input.parse({
        timeline_file: "/work/out/auto.timeline.json",
        output: "/work/out/auto.mp4",
        music: "/work/in/song.mp3",
      }),
    );
    expect(checked.text).toMatch(/^OK: no problems\./);
    expect(checked.text).toMatch(/furthest from a beat: [01] frames/);
  }, 900_000);

  it("transcribes speech and captions it where the clip sits in the edit", async () => {
    const words = await engine.transcribe("/work/in/talk.mp4", { language: "en" });
    const said = words.words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ""));
    expect(said).toEqual(expect.arrayContaining(["quick", "brown", "fox", "lazy", "dog"]));
    const timeline: TimelineInput = {
      version: 1,
      output: { width: 1080, height: 1920, fps: 30 },
      clips: [
        { src: "/work/in/talk.mp4", from: 0, frames: 60, audio: 0 },
        { src: "/work/in/talk.mp4", from: 2, frames: 45, audio: 0 },
      ],
      captions: { style: "karaoke", fromSpeech: true },
    };
    await engine.render(timeline, { output: "/work/out/talk.mp4" });
    const report = await engine.verify(timeline, "/work/out/talk.mp4");
    expect(report.problems).toEqual([]);
    expect(report.output).toMatchObject({ width: 1080, height: 1920, frames: 105 });
    // Never over a source.
    await expect(engine.render(timeline, { output: "/work/in/talk.mp4" })).rejects.toMatchObject({
      code: "bad_input",
    });
  }, 900_000);
});
