# ADR-0016: Channels that need no public URL

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Clients
- **Related:** ADR-0002, ADR-0017, ARCHITECTURE.md §13

## Context

Self-hosted installs usually sit behind a home router and cannot receive webhooks. Exposing a port invites the attacks OpenClaw suffered. Users still want to reach agents from their phone and from chat apps.

## Decision

- **Telegram:** Bot API long polling.
- **Slack:** Socket Mode.
- **Mobile app:** reaches the server over Tailscale, pairs by scanning a QR code with a one-time code, and receives notifications through the Expo Push Service.
- **Email:** deferred until a relay design exists.

## Alternatives considered

- **Webhooks through an exposed port or a public tunnel by default:** more attack surface and more setup.

## Consequences

- **Positive:** works behind NAT with no open ports.
- **Negative:** users install Tailscale on their phone for the mobile app; push notifications depend on Expo's service; inbound email waits.
- **Follow-up:** `docs/guides/tailscale.md`; the pairing flow in `apps/api` and `apps/mobile`.
