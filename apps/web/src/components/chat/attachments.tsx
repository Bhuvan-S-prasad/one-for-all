import { useApiClient } from "@ofa/client";
import { MAX_UPLOADS_PER_MESSAGE } from "@ofa/contracts";
import { File as FileIcon, Paperclip, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { fileSize } from "@/components/chat/file-card";
import { isMedia, MediaGrid } from "@/components/chat/media";
import { mediaKind, type AttachedFile } from "@/lib/attachments";
import { cn } from "@/lib/utils";

// Files a person attaches to a message (EN.09): each uploads at once, with
// progress, into the chat; the message then sends with their IDs. Footage
// goes to the object store (ADR-0047), so a large video is fine.

interface Pending {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly progress: number;
  readonly id?: string;
  readonly error?: string;
}

let next = 0;

export function useAttachments(threadId: string | undefined) {
  const api = useApiClient();
  const [items, setItems] = useState<Pending[]>([]);
  const update = (key: string, patch: Partial<Pending>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const add = useCallback(
    (files: Iterable<File>) => {
      if (!threadId) return;
      for (const file of files) {
        const key = `f${(next += 1)}`;
        setItems((list) =>
          list.length >= MAX_UPLOADS_PER_MESSAGE
            ? list
            : [...list, { key, name: file.name, size: file.size, progress: 0 }],
        );
        api
          .uploadFile(threadId, file, file.name, (progress) => update(key, { progress }))
          .then((upload) => update(key, { id: upload.id, progress: 1 }))
          .catch((error: unknown) =>
            update(key, { error: error instanceof Error ? error.message : "Couldn't upload" }),
          );
      }
    },
    [api, threadId],
  );

  return {
    items,
    add,
    remove: (key: string) => setItems((list) => list.filter((item) => item.key !== key)),
    clear: () => setItems([]),
    /** IDs of the files that finished uploading. */
    ready: items.flatMap((item) => (item.id ? [item.id] : [])),
    uploading: items.some((item) => !item.id && !item.error),
  };
}

/** The paperclip: pick files from the device. */
export function AttachButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label="Attach files"
        title="Attach files"
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Paperclip className="size-5" aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** What is attached to the message being written, each with its progress. */
export function PendingAttachments({
  items,
  onRemove,
}: {
  items: readonly Pending[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 px-2 pb-1" aria-label="Attached files">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "relative flex h-9 max-w-[240px] items-center gap-2 overflow-hidden rounded-full border bg-background pr-1 pl-3 text-[12.5px]",
            item.error && "border-destructive/60 text-destructive",
          )}
          title={item.error ?? item.name}
        >
          {!item.id && !item.error && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-primary/15 transition-[width]"
              style={{ width: `${Math.round(item.progress * 100)}%` }}
            />
          )}
          <span className="relative min-w-0 truncate font-medium">{item.name}</span>
          <span className="relative shrink-0 font-mono text-[11px] text-muted-foreground">
            {item.error
              ? "failed"
              : item.id
                ? fileSize(item.size)
                : `${Math.round(item.progress * 100)}%`}
          </span>
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            aria-label={`Remove ${item.name}`}
            className="relative flex size-7 shrink-0 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Files attached to a sent message: pictures and videos in place, others to save. */
export function SentAttachments({ files }: { files: readonly AttachedFile[] }) {
  const api = useApiClient();
  if (files.length === 0) return null;
  const media = files.filter((f) => isMedia(f.mimeType));
  const others = files.filter((f) => !isMedia(f.mimeType));
  return (
    <div className="flex w-full flex-col items-end gap-1.5">
      {media.length > 0 && (
        <MediaGrid
          className={cn(
            "w-full",
            media.every((m) => mediaKind(m.mimeType) === "image") && "max-w-[360px]",
          )}
          items={media.map((f) => ({
            key: f.id,
            name: f.name,
            mimeType: f.mimeType,
            viewUrl: api.uploadContentUrl(f.id, true),
            downloadUrl: api.uploadContentUrl(f.id),
          }))}
        />
      )}
      {others.map((f) => (
        <a
          key={f.id}
          href={api.uploadContentUrl(f.id)}
          download={f.name}
          className="flex max-w-full items-center gap-2 rounded-[14px] border bg-card px-3 py-2 text-[13.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate font-medium">{f.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{f.sizeText}</span>
        </a>
      ))}
    </div>
  );
}
