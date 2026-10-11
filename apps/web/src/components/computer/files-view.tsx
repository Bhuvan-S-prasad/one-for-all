import { useAgentFiles, useApiClient } from "@ofa/client";
import type { Agent, AgentFileEntry, AgentFileRoot } from "@ofa/contracts";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
} from "lucide-react";
import { useEffect, useState } from "react";
import { fileSize } from "@/components/chat/file-card";
import { Markdown } from "@/components/markdown";
import { timeAgo } from "@/lib/format";
import { parseMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

// The Files tab of the computer panel (DT.08): the agent's files, in the
// workspace it shares with the other agents or in its own home. Folders open
// in place; text and images preview here; anything downloads. Files are
// fetched as data and shown as text or as an image; nothing in them runs.

const TEXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|py|js|ts|sh|log|ini|toml|sql)$/i;
const IMAGE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const PREVIEW_CHARS = 200_000;

const extension = (name: string) => name.toLowerCase().split(".").pop() ?? "";

function FileIcon({ entry }: { entry: AgentFileEntry }) {
  if (entry.type === "directory")
    return <Folder className="size-4 shrink-0 text-primary" aria-hidden />;
  const ext = extension(entry.name);
  const className = "size-4 shrink-0 text-muted-foreground";
  if (IMAGE[ext]) return <FileImage className={className} aria-hidden />;
  if (["xlsx", "xls", "ods", "csv", "tsv"].includes(ext)) {
    return <FileSpreadsheet className={className} aria-hidden />;
  }
  if (TEXT.test(entry.name) || ["docx", "odt", "pdf"].includes(ext)) {
    return <FileText className={className} aria-hidden />;
  }
  return <File className={className} aria-hidden />;
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export function FilesView({ agent, className }: { agent: Agent; className?: string }) {
  const api = useApiClient();
  const [root, setRoot] = useState<AgentFileRoot>("workspace");
  const [folder, setFolder] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const files = useAgentFiles(agent.id, root, folder);
  const roots: [AgentFileRoot, string][] = [
    ["workspace", "Shared workspace"],
    ["home", `${agent.name}'s own`],
  ];
  const crumbs = folder ? folder.split("/") : [];
  const go = (next: string) => {
    setOpen(null);
    setFolder(next);
  };

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <div role="tablist" aria-label="Whose files" className="flex gap-1 rounded-full border p-1">
        {roots.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={root === value}
            onClick={() => {
              setRoot(value);
              go("");
            }}
            className={cn(
              "h-7 flex-1 truncate rounded-full px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              root === value
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <nav
        aria-label="Folder"
        className="flex min-w-0 flex-wrap items-center gap-0.5 text-[12.5px]"
      >
        <button
          type="button"
          onClick={() => go("")}
          className="rounded px-1 font-mono text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {root === "workspace" ? "/workspace" : "~"}
        </button>
        {crumbs.map((name, i) => (
          <span key={`${i}-${name}`} className="flex items-center gap-0.5">
            <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
            <button
              type="button"
              onClick={() => go(crumbs.slice(0, i + 1).join("/"))}
              className="max-w-40 truncate rounded px-1 font-mono text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {name}
            </button>
          </span>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] border">
        {open ? (
          <FilePreview
            key={`${root}:${open}`}
            agentId={agent.id}
            root={root}
            path={open}
            url={api.agentFileUrl(agent.id, root, open)}
            onBack={() => setOpen(null)}
          />
        ) : files.isPending ? (
          <div className="flex flex-col gap-2 p-3" aria-busy="true">
            <div className="skeleton h-7 w-full" />
            <div className="skeleton h-7 w-2/3" />
          </div>
        ) : files.isError ? (
          <div className="flex flex-col items-start gap-2 p-4 text-[13px] text-muted-foreground">
            {folder ? "This folder isn't there any more." : "Couldn't open the files."}
            {folder && (
              <button
                type="button"
                onClick={() => go("")}
                className="rounded-full border px-3 py-1 text-[12.5px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                Back to the top
              </button>
            )}
          </div>
        ) : files.data.entries.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">Nothing here yet.</p>
        ) : (
          <ul className="divide-y">
            {files.data.entries.map((entry) => {
              const path = join(folder, entry.name);
              const folderLike = entry.type === "directory";
              const previewable = TEXT.test(entry.name) || Boolean(IMAGE[extension(entry.name)]);
              return (
                <li key={entry.name} className="flex items-center gap-2 px-2.5 py-1.5">
                  <button
                    type="button"
                    disabled={!folderLike && !previewable}
                    onClick={() => (folderLike ? go(path) : setOpen(path))}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] px-1 py-1 text-left outline-none enabled:hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                  >
                    <FileIcon entry={entry} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {folderLike ? "" : `${fileSize(entry.size)} · `}
                      {timeAgo(entry.modifiedAt)}
                    </span>
                  </button>
                  {!folderLike && (
                    <a
                      href={api.agentFileUrl(agent.id, root, path)}
                      download={entry.name}
                      aria-label={`Download ${entry.name}`}
                      title="Download"
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Download className="size-3.5" aria-hidden />
                    </a>
                  )}
                </li>
              );
            })}
            {files.data.truncated && (
              <li className="px-3 py-2 text-[12px] text-muted-foreground">
                Only the first 1,000 are listed.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A text file as text (Markdown rendered), or an image from its bytes. */
function FilePreview({
  agentId,
  root,
  path,
  url,
  onBack,
}: {
  agentId: string;
  root: AgentFileRoot;
  path: string;
  url: string;
  onBack: () => void;
}) {
  const name = path.split("/").pop() ?? path;
  const imageType = IMAGE[extension(name)];
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (imageType) {
          // Served as a download; the bytes get their type here.
          objectUrl = URL.createObjectURL(
            new Blob([await response.arrayBuffer()], { type: imageType }),
          );
          if (!cancelled) setImage(objectUrl);
        } else {
          const body = await response.text();
          if (!cancelled) {
            setText(body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}\n…` : body);
          }
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, root, path, url, imageType]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 flex items-center gap-2 border-b bg-card px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the folder"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{name}</span>
        <a
          href={url}
          download={name}
          aria-label={`Download ${name}`}
          title="Download"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="size-3.5" aria-hidden />
        </a>
      </div>
      <div className="px-3 py-2.5">
        {error ? (
          <p className="text-[13px] text-muted-foreground">Couldn't load the file.</p>
        ) : image ? (
          <img src={image} alt={name} className="mx-auto max-h-95 rounded-[8px]" />
        ) : text === null ? (
          <div className="skeleton h-20 w-full" aria-busy="true" />
        ) : /\.(md|markdown)$/i.test(name) ? (
          <Markdown blocks={parseMarkdown(text)} sources={[]} className="text-[13.5px]" />
        ) : (
          <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{text}</pre>
        )}
      </div>
    </div>
  );
}
