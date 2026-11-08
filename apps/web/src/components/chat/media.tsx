import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { mediaKind } from "@/lib/attachments";
import { cn } from "@/lib/utils";

// Pictures, videos and sounds in the chat (EN.14): kept files (ADR-0047)
// shown in place from `?view=1`, which the server allows only for these
// types. A picture opens full size; a video plays and seeks by range.

export interface MediaItem {
  readonly key: string;
  readonly name: string;
  readonly mimeType: string;
  /** Shows it in place. */
  readonly viewUrl: string;
  /** Saves it. */
  readonly downloadUrl: string;
}

export function isMedia(mimeType: string): boolean {
  return mediaKind(mimeType) !== null;
}

export function MediaGrid({
  items,
  className,
}: {
  items: readonly MediaItem[];
  className?: string;
}) {
  const [open, setOpen] = useState<MediaItem | null>(null);
  const images = items.filter((i) => mediaKind(i.mimeType) === "image");
  const players = items.filter((i) => mediaKind(i.mimeType) !== "image");
  if (items.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {images.length > 0 && (
        <div
          className={cn(
            "grid gap-1.5",
            images.length === 1
              ? "grid-cols-1"
              : images.length === 2
                ? "grid-cols-2"
                : "grid-cols-3",
          )}
        >
          {images.map((image) => (
            <button
              key={image.key}
              type="button"
              onClick={() => setOpen(image)}
              aria-label={`Open ${image.name}`}
              className="group/image overflow-hidden rounded-[14px] border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={image.viewUrl}
                alt={image.name}
                loading="lazy"
                className={cn(
                  "w-full object-cover transition-transform group-hover/image:scale-[1.02]",
                  images.length === 1 ? "max-h-[420px] object-contain" : "aspect-square",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {players.map((item) => (
        <figure key={item.key} className="overflow-hidden rounded-[14px] border bg-card">
          {mediaKind(item.mimeType) === "video" ? (
            <video
              src={item.viewUrl}
              controls
              preload="metadata"
              className="max-h-[480px] w-full bg-black"
            />
          ) : (
            <audio src={item.viewUrl} controls preload="metadata" className="w-full px-3 pt-3" />
          )}
          <figcaption className="flex items-center gap-2 px-3.5 py-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
            <a
              href={item.downloadUrl}
              download={item.name}
              aria-label={`Save ${item.name}`}
              title="Save"
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Download className="size-4" aria-hidden />
            </a>
          </figcaption>
        </figure>
      ))}
      <Lightbox item={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** A picture at full size, over everything; Esc or a click outside closes it. */
function Lightbox({ item, onClose }: { item: MediaItem | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (item && !dialog.open) dialog.showModal();
    if (!item && dialog.open) dialog.close();
  }, [item]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={item?.name}
      className="m-auto max-h-[94vh] max-w-[94vw] overflow-visible bg-transparent p-0 backdrop:bg-black/80"
    >
      {item && (
        <div className="relative flex flex-col items-center gap-2">
          <img
            src={item.viewUrl}
            alt={item.name}
            className="max-h-[86vh] max-w-[94vw] rounded-[10px]"
          />
          <div className="flex items-center gap-2 text-[13px] text-white">
            <span className="max-w-[60vw] truncate">{item.name}</span>
            <a
              href={item.downloadUrl}
              download={item.name}
              className="flex h-8 items-center gap-1.5 rounded-full bg-white/15 px-3 font-semibold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
            >
              <Download className="size-4" aria-hidden /> Save
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-full bg-white/15 outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
