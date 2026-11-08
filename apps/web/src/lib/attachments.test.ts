import { describe, expect, it } from "vitest";
import { mediaKind, splitAttachments } from "./attachments";

describe("attached files", () => {
  it("takes the server's lines out of the text and lists the files", () => {
    const id = "0b8f6f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const message = `Cut this into a 30 s reel\n\n[Attached: beach day.mp4 · video/mp4 · 52.3 MB · upload://${id}]`;
    expect(splitAttachments(message)).toEqual({
      text: "Cut this into a 30 s reel",
      files: [{ id, name: "beach day.mp4", mimeType: "video/mp4", sizeText: "52.3 MB" }],
    });
  });

  it("leaves text that only looks similar alone", () => {
    const text = "See [Attached: x · not a type · 1 MB · upload://nope]";
    expect(splitAttachments(text)).toEqual({ text, files: [] });
  });

  it("knows which types show in place", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("audio/mpeg")).toBe("audio");
    expect(mediaKind("image/svg+xml")).toBeNull();
    expect(mediaKind("application/pdf")).toBeNull();
  });
});
