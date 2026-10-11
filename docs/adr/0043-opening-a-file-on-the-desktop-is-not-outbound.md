# ADR-0043: Opening a file on the desktop is not outbound

- **Status:** Accepted
- **Date:** 2026-10-11
- **Area:** Security
- **Related:** Supersedes ADR-0041 only where it lists "opening" among outbound desktop actions; ADR-0013 (taint escalation), ADR-0038 (read-only checks), ADR-0040, ADR-0042, ARCHITECTURE.md §10.3, §10.5

## Context

ADR-0041 counted opening a file among the desktop actions that are outbound, so after a run reads outside content each one needs a person's approval (§10.3). Building `desktop.open` (DT.07) showed what that means: the common task "research on the web, make a report, show it" reads web pages first, so every file the agent opened to show its work would wait for an approval card. Outbound means something could carry data out of the computer or act on the world. Opening a report in a word processor does neither, as long as the app makes no network requests.

## Decision

**`desktop.open` is not outbound. It opens files only in apps that send nothing anywhere, and never in the browser.**

- **The apps:** AbiWord (Word and OpenDocument text), Gnumeric (spreadsheets and CSV), feh (images), Mousepad (other text), PCManFM (folders). The sandbox picks the app from the file type, as the agent's own user.
- **Never the browser:** an HTML file, a PDF or anything else only a browser would show is not opened. The browser could fetch what a file points at, which is a way out. Text formats open in the editor as text; other files are refused with a hint to send them with `files.send`.
- **Not read-only either:** it changes what is on the screen, so proactive checks (ADR-0038) can't use it. Checks have nobody watching anyway.
- **Clicking and typing in desktop apps** (`desktop.click`, `desktop.type`, `desktop.press` and the screenshot fallback's `desktop.click_at`, `desktop.type_text`) stay outbound as ADR-0041 says: they act inside apps whose effects the policy can't see.

## Alternatives considered

- **Keep opening outbound (ADR-0041 as written):** an approval card each time a researched report is shown, for an action that can't send anything.
- **Open everything with the system's default handler (`xdg-open`):** would route HTML and PDF files to the browser.
- **Allow the browser for local files only (`file://`):** a local page can still load remote images and scripts.

## Consequences

- **Positive:** the agent shows its results on the desktop without approval cards; nothing it opens can reach the network.
- **Negative:** PDFs and HTML can't be shown on the desktop; the person downloads them from the chat instead.
- **Follow-up:** a PDF viewer without network access, if people ask for it (backlog).
