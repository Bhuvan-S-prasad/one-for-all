import { Fragment, type ReactNode } from "react";

// Just enough formatting for agent replies: paragraphs, bullet lines,
// **bold**, `code` and bare links. Everything else is plain text, so a reply
// can never inject markup.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)<>\]]+)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-accent px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (/^https?:\/\//.test(part)) {
      const url = part.replace(/[.,;:!?]+$/, "");
      return (
        <Fragment key={i}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all underline underline-offset-2"
          >
            {url}
          </a>
          {part.slice(url.length)}
        </Fragment>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function RichText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(block.replace(/^#{1,6}\s+/gm, ""))}
          </p>
        );
      })}
    </div>
  );
}
