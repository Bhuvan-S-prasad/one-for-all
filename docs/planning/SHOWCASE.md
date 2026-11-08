# Plan: show the real product (landing page and README)

**Status:** built differently (2026-11-08, SD.08). Grok Bot's page turned out to use an interactive product window, not screenshots, so the landing page got one too: the app rebuilt in `apps/site/src/landing/demo/` with the Kestrel story from this plan, playable on the page. The README uses 2x captures of that demo. The real-app capture pipeline below (demo database, scene runs, sandbox site) was not built: the sandbox's browser rightly opens only public addresses, and the interactive window shows more than stills would.
**Goal:** a visitor sees One-for-All *working* before they read about it: real screenshots of the real app, with the computer agent at the centre, showing chats that make sense. The same pictures go in the README.

## 1. What we have, and what the reference does

**Our landing page (`apps/site`)** is strong on character but never shows the product. The sections are:

1. **Hatchery:** the name, with familiars sitting on its letters.
2. **Manifesto:** what it is, read word by word.
3. **Day:** a pinned, sideways scroll through the day.
4. **Taint.**
5. **Routing:** a demo you can try.
6. **Stack:** cards for what every agent gets.
7. **Marquee.**
8. **Install.**
9. **Finale.**

Every picture in it is drawn: familiars, SVG lines and small mock fragments. Nothing is the actual app, so a visitor has to imagine it.

**Our README** has no pictures, and its status line is out of date ("Agents arrive in Milestone 2").

**The reference (xAI's Grok Bot page).** The page itself refuses automated fetching, so this is from its launch post, press coverage and the screenshot you shared:

- The hero is a short claim, a download button, and **the product in a desktop window frame**.
- Its best picture is the screenshot you shared:
  - a conversation list on the left;
  - a chat on the right;
  - a **"Computer · Action needed"** card that holds the agent's live screen, with **Take over** and **I'm done**;
  - a cursor labelled "You" about to press Take over.
- "How it's different" has five short claims: a computer of its own, message it like a teammate, many bots at once, show it how it's done, and trust it with more over time.
- **Tabbed use cases** (Sales outbound, Demo readiness, Pipeline ops, Account follow-up), each with the product doing that job.
- It closes with "Try it today".

What makes it work: every claim sits next to the product proving it, and the chats read like real work, not lorem ipsum.

**We can beat it on honesty and depth.** Our screenshots will be the real self-hosted app on a real run, and the page can show what Grok's can't:

- the approval card holding a draft you can edit;
- the step trail;
- the team handing work to each other;
- the phone.

## 2. The idea

**The window is the hero.** One product window carries the page. It appears right after the hatchery, the familiars from the hero fly into its sidebar as the conversation list, and from then on the claims scroll past beside it while the window changes to prove each one.

The story is one morning of real work for one fictional small business. Every screenshot comes from the same day, so the chats connect: the Researcher's findings show up in the Chief's plan, the Operator's sign-in request is the one the Inbox agent mentioned, and so on.

**The company:** *Kestrel Coffee Roasters*, a fictional three-person roastery that sells beans online. It's small enough that "a team of agents" is believable, and its work is concrete and visual: suppliers, orders, a wholesale price list, a newsletter, a café account. All names, emails and figures are invented, and no real company or person appears.

**The owner:** *Maya Ortiz* (fictional), who appears in the account row and in "You:" previews.

## 3. The screenshots (shot list)

Each shot is 1440×900 at 2x, dark theme, cropped where noted. All come from the running app.

| # | Name | What's on screen | Used in |
|---|---|---|---|
| S1 | **Computer, action needed** (hero) | **Sidebar:** Chief of staff, Operator (lime **Needs you**), Researcher, Inbox, Writer, and the group "Kestrel ops".<br>**Operator chat:** Maya asks it to "Reorder 3 sacks of the Huila decaf from Green Field Imports and match last month's price". The Operator answers: "Opening the supplier portal… you're signed out. Sign in and I'll take it from there."<br>**Computer card:** the live browser on the supplier's sign-in page.<br>**Overlay:** a "You" cursor drawn by the site over **Take over**. | Landing hero window, README top |
| S2 | **Computer, working** | **Live computer panel:** the browser on the supplier's order page, with the quantity filled in and the price table visible.<br>**Steps trail:** "Opened greenfield-imports.test/orders", "Read the price table", "Typed 3 into Quantity".<br>**Run panel:** time and steps. | "A computer of its own" |
| S3 | **Approval with a draft** | The Inbox agent's chat with an approval card: "Send this reply to Café Lumen?", the draft text editable, and **Approve / Edit / Deny**. The step trail shows it read 4 emails. | "Nothing leaves without you" |
| S4 | **The team at work** | The group "Kestrel ops": Maya writes "@all what should we change in the wholesale price list for spring?". The Chief's plan with checkboxes, handoffs to Researcher and Writer that show in the chat, and the agreed answer pinned at the top. | "Many agents, one thread" |
| S5 | **Research with sources** | The Researcher's answer comparing three green-coffee price indexes as a table with a chart block and numbered sources. | Use-case tab |
| S6 | **Routines** | The Routines page: "Morning sales digest, 07:30 weekdays", "Check stock levels, every 2 hours (check)", with the last-run results. | "Work on a clock" |
| S7 | **Memory** | The Memory page with facts grouped by agent, one "learned from outside content, keep or forget". | "A memory you can read" |
| S8 | **Phone pair** | 390×844 ×2: the conversation list, and the Operator chat with the same action-needed card. | "Everywhere" band, README |
| S9 | **Desktop app** | The Operator's VNC desktop with `spring-pricing.xlsx` open in the spreadsheet app, with the chat beside it. | "Its own computer" |

Every agent reply in those chats comes from a real run (§4). The user's messages are scripted.

## 4. How we make them: a repeatable capture, not hand-made pictures

Screenshots go stale whenever the UI changes, so they're produced by a script that anyone can rerun.

1. **A separate demo database.** `pnpm --filter @ofa/api db:seed:demo` creates `oneforall_demo`, which never touches your dev data. It holds:
   - the Kestrel workspace, Maya as owner, and the five agents with the site's familiar looks;
   - the "Kestrel ops" group, two routines, and a few older chats from "yesterday" so the list has history.
2. **A fictional supplier site for the computer to use.** `tooling/showcase/sites/green-field/` is a small static site served to the sandbox at `greenfield-imports.test`:
   - sign-in, catalogue, order form and price table, in the Kestrel story's colours;
   - no real brand appears in the computer's browser;
   - the run is the same every time, with no captchas or cookie walls.
   - *Spike first:* route that host through the egress proxy, or put the files in the sandbox and open them with `file://`.
3. **Real runs, scripted prompts.** `tooling/showcase/run.ts` sends each scene's messages through the API and waits for the runs.
   - It runs on the dev stack with the real harness, sandbox and policy, so the steps, approvals and computer screens are genuine.
   - For quality it uses a stronger model just for this session (one `LLM_MODELS_*` override). Free models work too but give rougher answers.
   - Each scene runs up to three times, and we keep the best take.
   - The script stops at the moments we need on screen: S1 is caught while the Operator waits for sign-in, and S3 while the approval is open.
4. **Capture.** `tooling/showcase/capture.ts` drives headless Chrome over the DevTools protocol, building on the script used to check this session's shell work:
   - It signs in as Maya, opens each scene at its size, hides the dev-only health banner, waits for fonts and the live screen, and saves PNGs.
   - It then makes WebP and AVIF versions with `sharp` at 1x and 2x.
5. **Outputs.**
   - `apps/site/public/product/*.{avif,webp}` for the site, with a 1.5 MB budget for the whole page's images.
   - `docs/images/*.png` for the README, which GitHub needs as PNG; 1600 px wide, compressed.
   - `pnpm showcase` runs seed, runs and capture in one go.

## 5. The landing page

The current sections stay; they're the personality. Product sections go between them, so the page alternates "who they are" with "watch them work".

| Order | Section | What changes |
|---|---|---|
| 1 | **Hatchery** (hero) | It stays, with a second line under the name: "A team of AI agents with their own computers. Self-hosted." Two buttons: **Install** and **See it work ↓**. |
| 2 | **The window** *(new)* | A large macOS-style window frame showing **S1**, rising into view as the hero's familiars fly into its sidebar.<br>The site draws the "You" cursor over the screenshot and animates it: it glides to **Take over** and presses, and S1 crossfades to **S2** with the agent working again.<br>Caption: "Your agents ask before they sign in, spend or send. Take over any time." This is the page's one live moment. |
| 3 | Manifesto | Unchanged. |
| 4 | **How it's different** *(new; replaces Stack's drawn cards)* | A **pinned window with claims scrolling beside it**: the window stays and its screenshot changes with each claim.<br>• **Its own computer:** S2, then S9.<br>• **Nothing leaves without you:** S3.<br>• **Many agents, one thread:** S4.<br>• **Work on a clock:** S6.<br>• **A memory you can read:** S7.<br>Each claim gets 2 lines of copy and one zoomed crop highlight, a ring drawn around the part of the screenshot that proves it.<br>On phones the window and text stack per claim. |
| 5 | **Day** | It stays, but each scene's drawn art becomes a cropped real screenshot from the same morning, so the story ties together. |
| 6 | Taint, Routing | Unchanged. Routing is already a live demo. |
| 7 | **Use cases** *(new, tabbed)* | Tabs: **Run the shop** (S1/S2), **Research** (S5), **Inbox** (S3), **The team** (S4). Each tab shows the window, a 3-step "what happened" list, and the exact prompt Maya typed, so visitors can copy the idea. |
| 8 | **Everywhere** *(new band)* | **S8:** two phone frames side by side, with "Approve from your phone. Coming with Telegram and Slack."<br>We say only what's built: the web app on phones works today, and the mobile app and chat apps are M6. |
| 9 | Marquee, Install, Finale | Unchanged, except Install gains a small S1 thumbnail. |

**Window frame component** (`ProductWindow`): traffic lights, a title-bar URL `localhost:3000` (it's self-hosted, which matters), a soft inner border, and the screenshot in `<picture>` with AVIF, WebP and a fallback. It has real `width` and `height`, so the layout never shifts, plus `loading="lazy"` except on the hero and alt text that describes the scene.

**Motion:** GSAP is already on the site.

- The window rises in.
- Screenshots crossfade, with a short blur to hide the swap.
- The cursor moves on a spring.
- Highlight rings draw in.
- The pinned "How it's different" section is a scrub.
- Under reduced motion, everything shows its final state with no movement.

**Craft:** the design-taste skill's inspector and look-and-fix loop run on the page at 1440, 768 and 390. A headline fits on two lines or fewer, nothing scrolls sideways on phones, and no section is left empty.

## 6. The README

- **Top:** S1 at full width under the title, with a one-line caption.
- A refreshed intro and status (everything through Shell is built; M6 is next). The stale "Agents arrive in Milestone 2" goes.
- **"What it looks like":** a 2×2 grid of S2, S3, S4 and S6 with a caption under each, then the phone pair S8.
- Images live in `docs/images/` with descriptive alt text. Each image links to the matching section of the landing page.

## 7. Honesty and privacy rules

- Every screenshot is the real app with real runs. The demo workspace and the supplier site are fictional and say so in the README's caption ("demo workspace").
- No real person, company, email or logo appears. The OS chrome in the window frame is drawn by the site, not copied from a real screenshot.
- **Nothing from your own dev data:** the capture uses the separate `oneforall_demo` database. Your email never appears; the capture script fails if it finds it in a page.
- The site claims only what's built. The phone band says what is coming in M6.

## 8. Tasks, in order

| # | Task | Done when |
|---|---|---|
| SH.01 | Spike: serve the supplier site to the sandbox, and do one Operator run on it with the live computer panel | The Operator signs in by takeover, fills in the order, and the panel shows it |
| SH.02 | The demo seed (`db:seed:demo`, a separate database) and the supplier site | `pnpm --filter @ofa/api db:seed:demo` gives the Kestrel workspace with history |
| SH.03 | `tooling/showcase`: scene runner, capture, image export, `pnpm showcase` | One command produces S1–S9 as AVIF, WebP and PNG |
| SH.04 | Take the shots: run the scenes, pick the best takes, check every frame | You approve the nine screenshots |
| SH.05 | `ProductWindow` and the hero window with the cursor moment (S1 → S2) | The hero shows the product, and "Take over" plays once |
| SH.06 | "How it's different" pinned window, use-case tabs, Day scenes as real crops, the phone band | Every claim has its proof on screen |
| SH.07 | README: hero image, refreshed status, grid, phone pair | It renders on GitHub in light and dark |
| SH.08 | Inspector and look-and-fix loop at 1440/768/390, reduced motion, image budget, Lighthouse | No FAILs, images under 1.5 MB, LCP under 2.5 s |

This needs a short ADR (0053) for the `tooling/showcase` folder and the demo database. It touches no runtime architecture.

## 9. Decisions to confirm

1. **Real runs with a stronger model for the capture session** (recommended), or free models only? Free answers are rougher, and the shots are worth a few cents of a better model.
2. **The fictional business:** Kestrel Coffee Roasters. Any business you prefer works; the story only needs to be concrete.
3. **Replace Stack's drawn cards** with the pinned product window (recommended), or keep both? Keeping both makes the page long.
