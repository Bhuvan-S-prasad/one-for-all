# ADR-0041: Desktop apps through the accessibility tree first, screenshots as a fallback

- **Status:** Accepted; opening a file superseded by ADR-0043 (not outbound)
- **Date:** 2026-10-10
- **Area:** Computer
- **Related:** ADR-0013 (taint escalation), ADR-0022 (replaceable providers), ADR-0038 (read-only checks), ADR-0040 (the desktop), ARCHITECTURE.md §7, §9.3, §10.5

## Context

With a desktop on screen (ADR-0040), agents can use desktop apps: the file manager, the editor, AbiWord, Gnumeric. The usual way ("computer use") sends the model a screenshot and asks where to click. That needs a model that reads images, costs one model call per click, and each screenshot takes a large share of a free model's small context. On OpenRouter's free models (20 requests a minute, 1,000 a day) a 30-step task would take minutes and about 3% of a day's quota.

The browser already avoids this: agents read a page through its accessibility tree, as an outline with numbered controls (M3.04). Linux desktop apps expose the same kind of tree through AT-SPI; GTK apps (PCManFM, Mousepad, AbiWord, Gnumeric) publish it when a session bus and the accessibility bridge are present. Hosted desktop sandboxes offer the same split (an AT-SPI tree beside screenshots).

## Decision

**Agents use desktop apps through the accessibility tree, like web pages; screenshots, clicks at a point and raw typing are a fallback offered only when the run's model can read images.**

- **Tree tools:**
  - `desktop.snapshot`: the open windows as an outline with numbered controls, `[12] push button "Save"`, like `browser.snapshot`.
  - `desktop.click`, `desktop.type`, `desktop.press`: act on a numbered control or press keys, and return the new outline.
  - `desktop.open`: open a file or folder in its app.
- **Fallback tools:** `desktop.screenshot` (a JPEG of the screen, scaled to at most 1280×800), `desktop.click_at` (x, y) and `desktop.type_text`.
  - They are listed only when the run's model can read images (`ModelInfo.vision`).
  - The model gateway gains image parts in messages, mapped by each provider file; tier config gains a vision chain, so no model is named elsewhere (ADR-0022).
  - Only the latest screenshot stays in context; each one is kept as a run artifact, like a page snapshot.
- **Input at full speed** through xdotool on the agent's own display; no animation (ADR-0040).
- **Policy, as for the browser:**
  - `desktop.snapshot` and `desktop.screenshot` are read-only.
  - Clicking, typing, pressing and opening are outbound, so they need a person's approval after a run reads outside content (§10.3).
  - All of them are refused in proactive checks (ADR-0038) and while a person has control.
- **The browser stays on CDP:** web pages are still read and driven through `browser.*`, which is faster and exact; the desktop tools are for everything else.

## Alternatives considered

- **Screenshots only:** works on any app, but needs a vision model, one call per step and a lot of context; impractical on the free tiers.
- **Tree only:** cheap, but some apps publish little or nothing (xterm, custom-drawn canvases), so there would be no way through them.
- **Drive Chromium through the desktop too:** one way of working, but slower and less exact than CDP, and the page's tree is already richer through CDP.

## Consequences

- **Positive:** desktop tasks run on free text models within the quota; screenshots remain for the apps that need them; one policy model covers browser and desktop.
- **Negative:** AT-SPI adds a session bus and the accessibility bridge to each desktop; apps vary in how well they describe themselves; the vision fallback depends on a free model that reads images and calls tools well, or a paid one the owner picks.
- **Follow-up:** DT.09 the tree tools; DT.10 images in the gateway and a spike over free vision models; DT.11 the screenshot fallback.
