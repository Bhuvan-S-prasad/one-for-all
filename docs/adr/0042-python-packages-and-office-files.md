# ADR-0042: Python packages in each agent's venv; any file can go back to the person

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Computer
- **Related:** ADR-0025 (the image), ADR-0040 (the desktop), ARCHITECTURE.md §7 (artifacts), §9.3, §10.5

## Context

Agents have Python 3 and a shell, but the image has no pip and no venv support (Debian splits both out), so `pip install` fails. People ask agents for Word reports and Excel sheets; making those needs libraries (python-docx, openpyxl). Getting the file back fails too: only text written with `files.write` becomes a file card, while a `.xlsx` made by a script stays on the agent's computer.

Debian's Python refuses system-wide `pip install` (PEP 668). The sandbox's root file system is read-only; each agent's home is a private volume that survives restarts. Artifacts are stored as bytes (up to 10 MB), so binary files already fit.

Checked on Debian bookworm: `python3-pip`, `python3-venv`, `python3-openpyxl` and `python3-docx` are packaged for x64 and arm64 (about 22 MB together); `python3-pandas` adds about 78 MB; python-pptx is not packaged.

## Decision

**The image carries pip, venv, openpyxl and python-docx. Each agent has its own venv in its home, first on its PATH, so `pip install` works without flags. A new tool, `files.send`, sends any file from the computer back to the person.**

- **Per-agent venv:** `~/.venv`, created on first use with access to the system packages (`--system-site-packages`), and first on the agent's `PATH`. Packages an agent installs live in its home, survive restarts and are invisible to other agents.
- **Downloads go through the egress proxy** like everything else. With an allowlist (`SANDBOX_EGRESS_ALLOW` not `*`), pip needs `pypi.org` and `files.pythonhosted.org`.
- **In the image:** openpyxl (Excel) and python-docx (Word) from Debian. pandas and python-pptx are left to each agent's venv; pandas costs 78 MB for every install whether used or not.
- **`files.send`** (first planned as `files.share`; renamed in DT.07 because the always-human list, ADR-0028, holds any action named "share"): reads a file from the agent's computer (up to 10 MB; larger files once they stream to the object store, ADR-0047, EN.09) and attaches it to the reply as a file card with a download, with its type from the extension. It is not outbound (the file goes to the person who asked, inside the app) and marks the artifact untrusted when the run is tainted, as `files.write` does.
- **Files tab:** the computer panel lists `/workspace` and the agent's home, with sizes and dates, downloads and previews of text and images, through the sandbox's existing list and read calls.

## Alternatives considered

- **Install packages system-wide at build time on request:** every install would grow the image, and agents still could not add what they need.
- **`pip install --break-system-packages` or `--user`:** works, but mixes agent packages with Debian's and teaches agents a flag; a venv first on PATH needs nothing.
- **Pre-install pandas and more:** convenient, but every self-hoster pays the disk for it.
- **Let `files.write` take base64 for binary files:** the model would have to produce the bytes itself; files are made by programs on the computer, so sharing a path is the right shape.

## Consequences

- **Positive:** Word and Excel files, charts and anything a Python library can make; the person gets the file in the chat; agents install what a task needs.
- **Negative:** a package an agent installs runs as that agent and can read that agent's own home, including its browser profile and saved logins. The sandbox boundary still holds (no other agents, no host, egress only through the proxy). Homes have no disk quota yet; the Files tab shows sizes.
- **Follow-up:** DT.03 pip and venv; DT.07 `files.send` and `desktop.open`; DT.08 the Files tab; a per-agent disk quota (backlog).
