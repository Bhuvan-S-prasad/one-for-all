# The video editor

The video editor is an agent that cuts footage to music or to speech: AMV and velocity edits, hype montages, trailers, talking-head clips for Reels and Shorts, and vlogs. It is built on the video engine (`packages/video`, ADR-0049), which also runs on its own, outside One-for-All.

## In One-for-All

1. **Start the stack** with `pnpm infra:up`. The sandbox image has ffmpeg, librosa (beats) and faster-whisper (speech) built in. The first build of the image takes a while.
2. **Import the agent.** In Agents, choose to import a file and pick [`agents/video-editor.json`](agents/video-editor.json). It arrives with its skills waiting for your approval (`/edit-video`, `/beat-edit`, `/talking-head`).
3. **Send footage.** Attach clips and a song in its chat (up to 2 GB each) and say what you want, the style, the length and where it will be posted.
4. **Approve the plan.** It analyses everything, sends a plan, and waits for your answer before cutting.
5. **Get the files.** It renders, checks every cut and the sound, and sends you the exports in the formats you asked for.

What it can do: cut on beats to the frame, with fast cuts on high-energy sections and the drop; speed ramps; flash, shake, zoom, blur and RGB-split accents; colour grades and `.cube` LUTs; captions from speech; exports at 9:16, 4:5, 1:1 and 16:9. What it can't do on a CPU: masks, cutting out a character, smooth optical-flow slow motion, compositing. For in-shot effects, connect Runway or Higgsfield on your own account (ADR-0048).

It never posts anywhere, and never changes your originals: every render is a new file.

## On its own

The engine needs Node 24, ffmpeg, and Python 3 with `librosa` (and `faster-whisper` to transcribe). Install the Python packages in a venv and point `OFA_VIDEO_PYTHON` at its `python`. Install [Beat This!](https://github.com/CPJKU/beat_this) too and the engine uses it for beats.

From this repository:

```sh
pnpm --filter @ofa/video cli styles
pnpm --filter @ofa/video cli scan path=/videos/clip.mp4
pnpm --filter @ofa/video cli music path=/music/song.mp3
pnpm --filter @ofa/video cli plan_beats music=/music/song.mp3 style=amv fps=30 from=40 to=70
pnpm --filter @ofa/video cli render timeline_file=edit.json output=/videos/out/edit.mp4 'formats=["9:16"]'
pnpm --filter @ofa/video cli verify timeline_file=edit.json output=/videos/out/edit.mp4 music=/music/song.mp3
```

As an MCP server, for Claude Code, Cursor or any MCP client:

```sh
claude mcp add ofa-video -- pnpm --silent --dir /path/to/one-for-all --filter @ofa/video cli mcp
```

`--silent` matters: without it pnpm prints a banner on stdout, which breaks the MCP stream.

The tools are the same eight as in One-for-All, without the `video.` prefix. Work files (analysis, rendered clips, contact sheets) go in `~/.ofa-video`.

## The timeline

An edit is a JSON timeline (version 1): the output size and frame rate, the music and where in the song it starts, clips in order, each with its source, its start in the source, its length in frames, its speed or ramp, its framing, its sound and its effects, then captions and a grade. Clips render one by one and are reused when unchanged, so changing one clip renders only that clip again. `plan_beats` gives the slots: one clip per slot with exactly its frames keeps every cut on the beat.
