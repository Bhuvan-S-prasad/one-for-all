import { describe, expect, it } from "vitest";
import { agentFilePath } from "./agent-files";

describe("agentFilePath", () => {
  it("maps a path under the workspace or the agent's home", () => {
    expect(agentFilePath("workspace", "")).toBe("/workspace");
    expect(agentFilePath("workspace", "reports/ai.docx")).toBe("/workspace/reports/ai.docx");
    expect(agentFilePath("workspace", "/reports//./ai.docx/")).toBe("/workspace/reports/ai.docx");
    expect(agentFilePath("home", "")).toBe("~");
    expect(agentFilePath("home", "notes/today.md")).toBe("~/notes/today.md");
  });

  it("never leaves the root, and never reaches hidden files or the browser profile", () => {
    expect(agentFilePath("workspace", "../etc/passwd")).toBeNull();
    expect(agentFilePath("workspace", "reports/../../etc")).toBeNull();
    expect(agentFilePath("home", ".venv/bin/python")).toBeNull();
    expect(agentFilePath("home", ".run/bus")).toBeNull();
    expect(agentFilePath("home", "notes/.secret")).toBeNull();
    expect(agentFilePath("home", "chromium/Default/Cookies")).toBeNull(); // Its logins.
    expect(agentFilePath("home", "Desktop")).toBeNull();
    // A folder named like that in the shared workspace is just a folder.
    expect(agentFilePath("workspace", "chromium/notes.md")).toBe("/workspace/chromium/notes.md");
  });
});
