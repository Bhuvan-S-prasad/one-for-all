# ADR-0049: The video engine is a standalone package; One-for-All uses it through a thin adapter

- **Status:** Accepted
- **Date:** 2026-10-19
- **Area:** Platform
- **Related:** ADR-0048 (media from catalog apps), ADR-0047 (object storage), ADR-0042 (files back to the person), ADR-0036 (skills), ADR-0025 (the sandbox image), ARCHITECTURE.md §9.3, §17

## Context

The Enhancements milestone adds our own video edit agent (EN.16–EN.18). Research into today's editing agents (video-use, CutClaw, VideoAgent, Descript's Underlord, the trailer study) found one shape that works:

- **The agent reads footage; it doesn't watch it.** A transcript with word times, a shot list, a music map and a few contact sheets at decision points. Vision models sample video at about one frame a second, so they can't judge sub-second sync.
- **Sync is computed, not seen.** Beats, downbeats, sections and energy are measured; the song is cut into slots of exact length; the model chooses what goes in each slot. Removing the music analysis was what hurt CutClaw's sync score most.
- **The edit is data.** A timeline the agent writes and a predictable renderer turns into video, so one wrong cut is redone alone.
- **Plan, approval, render, check, at most a few retries.**

That engine is a product of its own: it is just as useful to a person running Claude Code on a laptop as to a One-for-All agent. We don't want a second project later.

## Decision

**The video engine is `packages/video` (`@ofa/video`), which imports nothing from One-for-All. One-for-All's agents use it through tools in `packages/tools`. Outside One-for-All it is a CLI and an MCP server.**

- **No way back in.** `packages/video` may import no `@ofa/*` package; a lint rule (the same one as `packages/core`) enforces it. Its only dependency is zod. It knows nothing of tenants, policy, credentials, the database or the sandbox. Moving it to its own repository is moving the folder.
- **Where things run.** The engine is TypeScript that does the arithmetic (slots, frame counts, effects, checks) and builds ffmpeg and Python commands. A `Runner` runs those commands where the media is: in One-for-All, the agent's own computer through `SandboxHandle.exec` and its files (hard rule 8: agent work runs only in the sandbox); standalone, the local machine through `child_process` with no shell. Its Python scripts ship inside the package and are written into the runner's work folder (`~/.ofa-video/`) when first used, so the image needs no copy of the engine.
- **The timeline is the contract.** A versioned zod schema (`version: 1`): the output size and frame rate, the music, clips placed in exact frame counts with a source start, a speed or a ramp, and effects; captions; a grade. Clips render one by one into the work folder and are joined, so a changed clip renders again alone.
- **Analysis.** ffprobe for each file; shots and motion from ffmpeg's scene detection (`scdet`: its frame-difference score is the motion signal, so action can land on a beat); words with times from faster-whisper (base model, int8, baked into the image); beats, downbeats (4/4 assumed), energy per beat and sections by energy from librosa, or from Beat This! when it is installed. Sections are labelled low, mid or high energy, not verse or chorus: that is what can be measured honestly.
- **Styles are data.** Each style (AMV, hype montage, cinematic trailer, talking head, vlog) says how many beats a cut lasts at each energy level, where effects go (a flash and zoom on the drop, shakes on hits, speed ramps into a section), the grade, captions and the editor's rules. The engine turns a style and a music map into slots with suggested effects. In One-for-All the agent template's skills point at the styles; standalone they are the same data behind `styles`.
- **Effects are ffmpeg filters with fixed rules,** checked on the sandbox's ffmpeg: speed and linear speed ramps, flash, shake, zoom punch, blur, RGB split, grades and `.cube` LUTs, burned captions (ASS through libass). Mask transitions, frame interpolation and compositing are out of scope on a CPU; Runway or Higgsfield, on the person's own account, cover in-shot effects (ADR-0048).
- **Checks.** Planned cuts against the beat grid (in frames), the output's size, frame rate and length, cuts found in the output against the plan, audio present and not clipping, and contact sheets of every cut for a model that reads images.
- **The adapter.** `video.*` tools in `packages/tools` (scan, music, transcribe, plan beats, render, verify, contact sheet, styles), through grants, policy, the run log and redaction like any tool, reading and writing only the agent's own computer. Footage arrives with `files.receive` (EN.09); finished videos go back with `files.send`. Rendering writes only new files under the work folder or a path the agent names; it never overwrites a source.
- **The agent.** An agent file (`docs/guides/agents/video-editor.json`, ADR-0039) with the video, files and shell grants and skills for the flow: ask for footage and the goal, scan, analyse, send the plan for approval, cut, check, deliver, never post.

## Alternatives considered

- **Build it inside `packages/tools`.** Faster today; extracting it later means untangling it from the run context, policy and the sandbox port. Rejected.
- **A separate repository now.** Two release trains and versions to keep in step before the engine has a first user. The package boundary gives the same separation for free; extraction stays a folder move.
- **Bake the engine into the sandbox image.** The image is built from `infra/docker/sandbox` alone; copying a built engine in needs a pre-build step in every Compose file and CI job. Writing the Python scripts at first use keeps the image the same everywhere, and updates ship with the app.
- **The model writes ffmpeg commands.** ELLMPEG measured 78% correct commands for the best open model; frame-exact sync needs arithmetic the model shouldn't do.
- **Beat This! by default.** It tracks beats best, but needs PyTorch (hundreds of MB) on an image that must fit about 3 GB on arm64. It is used when present.

## Consequences

- **Positive:** one engine, two front doors; sync accurate to the frame; small models stay within their context, since the agent reads compact summaries; a wrong cut costs one clip's render.
- **Negative:** the sandbox image grows from 1.9 GB to 3.5 GB on x64 (about 760 MB of Python packages, 140 MB of model, the rest ffmpeg's libraries; 910 MB compressed on arm64); librosa's beat tracking is weaker than Beat This! on hard music; downbeats assume 4/4; the engine judges timing, not taste.
- **Measured** on x64 within the sandbox's limits (1.5 CPUs, 1.5 GB), with ffmpeg held to two threads (x264 sizes its buffers by thread count and sees the host's cores, not the limit): peak memory about 1.0 GB including page cache; a 20-clip 1080p render with effects in 46 s; music analysis of 30 s in 16 s (mostly numba warming up); a short transcription in 3 s.
- **Publishing:** releasing the engine on its own needs the project's license (ARCHITECTURE.md §19).
