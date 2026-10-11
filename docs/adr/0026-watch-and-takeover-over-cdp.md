# ADR-0026: Watch and take over the browser over CDP, not VNC

- **Status:** Superseded by ADR-0040
- **Date:** 2026-10-04
- **Area:** Computer
- **Related:** Supersedes the VNC part of ADR-0009 and ADR-0025; ADR-0012 (takeover for passwords), ADR-0017 (perimeter), ARCHITECTURE.md §3, §4, §10.5

## Context

People must be able to watch an agent's browser and take it over, for a login, a 2FA prompt or a payment (ADR-0012). The plan was VNC: a VNC server on each agent's virtual screen, proxied through the app, and a VNC client in the web app. That means another server in the sandbox, a WebSocket-to-TCP bridge, and either a new npm dependency (noVNC) or a hand-written RFB client.

Since ADR-0025 the agent's computer has nothing on screen but Chromium: each agent has its own browser on its own virtual display, and no other windows. Chromium can already stream its page (`Page.startScreencast`) and accept input (`Input.dispatch*`) over the DevTools protocol we use to drive it.

## Decision

Stream the page over CDP. The app opens `/api/agents/:id/screen`, a WebSocket behind the same login and Origin checks as `/api/ws`. The app connects to the agent's browser through the sandbox service, sends JPEG frames on as they come, and, with `?control=1`, passes the person's mouse, keyboard and pastes back as CDP input. The web app draws our own address bar, back and reload.

- **Takeover:** one person at a time. While they have control, the sandbox refuses the agent's own requests for its browser, and the agent's browser tools say a person has it. Control ends when the socket closes. Start and end are audited.
- **Nothing is recorded:** frames go to the viewer and are dropped when a viewer falls behind. What the person types goes to the page only.
- **The interface:** `SandboxHandle.screen(agentId)` and `takeover(agentId, on)` replace `vncUrl()`, so an E2B adapter can implement the same thing.

## Alternatives considered

- **VNC with noVNC:** a full-desktop view, including native browser dialogs. It costs an extra server in the sandbox, a bridge, and a client dependency or a hand-written RFB client, for a desktop that holds nothing but the browser.
- **Screenshots on demand:** simple, but not live, and no real takeover.

## Consequences

- **Positive:** no new packages in the image or the web app; the same tab the agent uses is the one you see; watching costs a CDP connection, not a VNC server per agent.
- **Negative:** you see the page, not the browser's own interface. A native dialog (file picker, basic-auth prompt, print) is not visible or controllable this way. Frames are JPEG at up to 1280×800, so fine detail is slightly soft.
- **Follow-up:** if native dialogs turn out to matter, handle them through CDP (`Page.javascriptDialogOpening`, `Page.fileChooserOpened`) rather than adding VNC.
