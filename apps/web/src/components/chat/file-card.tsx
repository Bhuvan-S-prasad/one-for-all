import { useApiClient } from "@ofa/client";
import type { Artifact } from "@ofa/contracts";
import { ChevronDown, ChevronUp, Download, FileText } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/markdown";
import { parseMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

// A file the agent wrote (M3.06): name, type and size, a preview you can
// open in place, and Save. Content is fetched as text and shown as text (or
// our own Markdown renderer); nothing in it ever runs.

const TYPE_WORDS: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/plain": "Text",
  "text/csv": "CSV",
  "text/tab-separated-values": "TSV",
  "application/json": "JSON",
  "text/html": "HTML",
  "application/xml": "XML",
  "application/yaml": "YAML",
  "text/x-python": "Python",
  "text/javascript": "JavaScript",
  "text/x-shellscript": "Shell script",
  "image/svg+xml": "SVG",
};

const PREVIEW_BYTES = 200_000;

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

export function FileCard({ file, agentName }: { file: Artifact; agentName: string }) {
  const api = useApiClient();
  const url = api.artifactContentUrl(file.id);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markdown = file.mimeType === "text/markdown";

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && text === null) {
      try {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        setText(body.length > PREVIEW_BYTES ? `${body.slice(0, PREVIEW_BYTES)}\n…` : body);
      } catch {
        setError("Couldn't load the file.");
      }
    }
  };

  return (
    <div className="overflow-hidden rounded-[16px] border bg-card">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-accent text-muted-foreground">
          <FileText className="size-5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14.5px] font-semibold">{file.name}</span>
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
            {TYPE_WORDS[file.mimeType] ?? "File"} · {fileSize(file.size)} · in {agentName}'s files
          </span>
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          aria-expanded={open}
          className="flex h-9 items-center gap-1.5 rounded-full border border-input px-3 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? (
            <ChevronUp className="size-4" aria-hidden />
          ) : (
            <ChevronDown className="size-4" aria-hidden />
          )}
          {open ? "Hide" : "Open"}
        </button>
        <a
          href={url}
          download={file.name}
          aria-label={`Save ${file.name}`}
          title="Save"
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="size-4" aria-hidden />
        </a>
      </div>
      {open && (
        <div
          className={cn(
            "max-h-[420px] overflow-auto border-t px-4 py-3",
            !markdown && "bg-background/40",
          )}
        >
          {error ? (
            <p className="text-sm text-muted-foreground">{error}</p>
          ) : text === null ? (
            <div className="skeleton h-20 w-full" aria-busy="true" />
          ) : markdown ? (
            <Markdown
              blocks={parseMarkdown(text)}
              sources={[]}
              className="text-[14.5px] leading-relaxed"
            />
          ) : (
            <pre className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
