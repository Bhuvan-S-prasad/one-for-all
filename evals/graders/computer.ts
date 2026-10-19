import type { RunContext, SandboxProvider } from "@ofa/core";

// A real computer for desktop cases (DT.12): the dev sandbox from
// `pnpm infra:up`, one eval agent with its own Linux user. Before each attempt
// its home is emptied (its venv stays) and the case's files are put in place;
// afterwards its desktop is closed, the files the run made or changed are read
// back with their text (Word and Excel through python-docx and openpyxl), and
// what it added to the shared workspace is removed again.

/** A file the run made or changed, as the checks see it. */
export interface SavedFile {
  /** `/workspace/...`, or `~/...` in the agent's home. */
  readonly path: string;
  readonly kind: "docx" | "xlsx" | "text" | "video" | "other";
  readonly size: number;
  /** The words in it: paragraphs and tables, or a sheet's rows as tab-separated lines. */
  readonly text: string | null;
  /** Why it couldn't be read as its kind (not really a Word file, say). */
  readonly error?: string;
  /** A video's picture and length, from ffprobe (EN.18). */
  readonly video?: { readonly width: number; readonly height: number; readonly duration: number };
}

export interface EvalComputer {
  readonly sandbox: SandboxProvider;
  /** Nothing running, an empty home, then the case's files and its setup command. */
  prepare(ctx: RunContext, files: Readonly<Record<string, string>>, setup?: string): Promise<void>;
  /** Close the desktop, read back what the run made or changed, and tidy the shared workspace. */
  collect(ctx: RunContext): Promise<SavedFile[]>;
}

/** The sandbox's agent IDs are letters, digits and dashes. */
export const EVAL_COMPUTER_AGENT = "eval-desk";

const MARK = "~/.eval-start";

// Runs as the agent, so it reads and removes only what that agent may. Files
// changed during the attempt are read whoever made them (an agent writing
// over a file keeps its owner); in the workspace, only the ones the agent
// owns, so made, are removed.
const COLLECT = String.raw`
import json, os
home = os.path.expanduser("~")
start = os.stat(os.path.join(home, ".eval-start")).st_mtime_ns
uid = os.getuid()
VIDEO = {".mp4", ".mov", ".webm", ".mkv"}
TEXT = {".txt", ".md", ".csv", ".tsv", ".json", ".py", ".html", ".htm", ".xml", ".log"}

def read(path, ext):
    if ext == ".docx":
        import docx
        d = docx.Document(path)
        lines = [p.text for p in d.paragraphs]
        for t in d.tables:
            for row in t.rows:
                lines.append("\t".join(c.text for c in row.cells))
        return "docx", "\n".join(lines)
    if ext == ".xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(path)
        lines = []
        for ws in wb.worksheets:
            lines.append("# " + ws.title)
            for row in ws.iter_rows(values_only=True):
                if any(v is not None for v in row):
                    lines.append("\t".join("" if v is None else str(v) for v in row))
        return "xlsx", "\n".join(lines)
    if ext in VIDEO:
        import subprocess
        info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], capture_output=True, check=True, text=True).stdout)
        v = next(s for s in info["streams"] if s.get("codec_type") == "video")
        return "video", json.dumps({"width": v["width"], "height": v["height"], "duration": float(info["format"]["duration"])})
    if ext in TEXT:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "text", f.read(50000)
    return "other", None

out, made = [], []
for root in ("/workspace", home):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and not (d == home and x in ("chromium", "Desktop"))]
        for name in files:
            p = os.path.join(d, name)
            if name.startswith("."):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_mtime_ns <= start or len(out) >= 200:
                continue
            shown = "~" + p[len(home):] if p.startswith(home + "/") else p
            ext = os.path.splitext(name)[1].lower()
            entry = {"path": shown, "size": st.st_size}
            try:
                entry["kind"], entry["text"] = read(p, ext)
                if entry["kind"] == "video":
                    entry["video"] = json.loads(entry["text"])
                    entry["text"] = None
            except Exception as e:
                kind = ext[1:] if ext in (".docx", ".xlsx") else "other"
                entry.update(kind=kind, text=None, error=f"{type(e).__name__}: {e}"[:300])
            out.append(entry)
            if root == "/workspace" and st.st_uid == uid:
                made.append(p)

for p in made:
    try:
        os.remove(p)
    except OSError:
        pass
for d, dirs, files in os.walk("/workspace", topdown=False):
    if d != "/workspace":
        try:
            st = os.stat(d)
            if st.st_uid == uid and st.st_mtime_ns > start:
                os.rmdir(d)
        except OSError:
            pass
print(json.dumps(out))
`;

export function dockerComputer(sandbox: SandboxProvider): EvalComputer {
  return {
    sandbox,
    async prepare(ctx, files, setup) {
      const handle = await sandbox.acquire(ctx);
      await handle.restart(ctx.agentId);
      // Its venv stays: the sandbox checks it once per start and would not remake it.
      const emptied = await handle.exec(
        ctx.agentId,
        "find ~ -mindepth 1 -maxdepth 1 ! -name .venv -exec rm -rf -- {} +",
      );
      if (emptied.exitCode !== 0) {
        throw new Error(`Couldn't empty the eval agent's home: ${emptied.stderr.trim()}`);
      }
      for (const [path, content] of Object.entries(files)) {
        await handle.writeFile(ctx.agentId, path, content);
      }
      if (setup) {
        const made = await handle.exec(ctx.agentId, setup, { timeoutMs: 5 * 60_000 });
        if (made.exitCode !== 0) {
          throw new Error(`The case's setup failed: ${made.stderr.trim().slice(-300)}`);
        }
      }
      // The case's own files are older than the mark: only what the run changes counts.
      await handle.exec(ctx.agentId, `touch ${MARK}`);
    },
    async collect(ctx) {
      const handle = await sandbox.acquire(ctx);
      // Closing the desktop first: the reading runs unseen, and apps let go of their files.
      await handle.restart(ctx.agentId);
      const result = await handle.exec(ctx.agentId, `/usr/bin/python3 - <<'PY'\n${COLLECT}\nPY`, {
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Couldn't read the computer's files: ${result.stderr.trim().slice(-300)}`);
      }
      return JSON.parse(result.stdout) as SavedFile[];
    },
  };
}
