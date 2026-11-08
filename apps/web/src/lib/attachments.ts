// Files a person attached to a message (EN.09). The server adds a line per
// file, "[Attached: name · type · size · upload://<id>]", which the agent
// reads in its history; the chat shows those lines as files instead.

export interface AttachedFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** As the server wrote it: "52.3 MB". */
  readonly sizeText: string;
}

const LINE =
  /^\[Attached: (.+?) · ([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*) · ([^·\]]+?) · upload:\/\/([0-9a-f-]{36})\]$/gim;

/** The message's own text, and the files attached to it. */
export function splitAttachments(content: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = [];
  const text = content
    .replace(LINE, (_line, name: string, mimeType: string, sizeText: string, id: string) => {
      files.push({ id: id.toLowerCase(), name, mimeType: mimeType.toLowerCase(), sizeText });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, files };
}

/** Pictures and videos the browser can show in place (the server's `?view=1` list). */
export function mediaKind(mimeType: string): "image" | "video" | "audio" | null {
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) return "image";
  if (["video/mp4", "video/webm", "video/quicktime"].includes(mimeType)) return "video";
  if (["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm"].includes(mimeType)) {
    return "audio";
  }
  return null;
}
