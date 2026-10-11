import {
  agentsWeb,
  laptopsWeb,
  SHOPPING_ITEMS,
  SHOPPING_LIST,
  SURVEY_SHARE,
} from "../fixtures/office";
import {
  answered,
  savedFile,
  sentFile,
  usedAnyTool,
  usedTool,
  withinModelCalls,
} from "../graders/checks";
import type { EvalCase } from "../graders/types";

// Golden desktop tasks (DT.12), on the real computer from `pnpm infra:up`:
// research the web, then make a Word report and an Excel sheet with Python,
// open them on the desktop and send them; and edit a file in a desktop app.
// Commands after reading the web need a person's approval (§10.3); the
// person here approves.

export const desk: EvalCase["agent"] = {
  slug: "desk",
  name: "Desk",
  description:
    "Researches on the web and makes documents and spreadsheets on its own computer. Answers briefly.",
  status: "active",
  job: "Makes reports and spreadsheets",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 20, tokens: 200_000 },
  grants: [
    { tool: "web.*", mode: "auto" },
    { tool: "shell.*", mode: "auto" },
    { tool: "files.*", mode: "auto" },
    { tool: "desktop.*", mode: "auto" },
  ],
};

/** Only desktop apps: no terminal and no file writes, so the edit has to happen in the app. */
const appsOnly: EvalCase["agent"] = {
  ...desk,
  slug: "desk-apps",
  name: "Desk",
  grants: [{ tool: "desktop.*", mode: "auto" }],
};

const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const inReports = (ext: string) => (path: string) =>
  path.startsWith("/workspace/reports/") && path.toLowerCase().endsWith(ext);
const price = (n: string) => new RegExp(`${n[0]},?${n.slice(1)}`);

export const deskSuite: EvalCase[] = [
  {
    id: "desk.wikipedia-report",
    suite: "golden",
    description:
      "Researches AI agents, writes a Word report with Python into /workspace/reports, opens it on the desktop and sends it.",
    agent: desk,
    prompt:
      "Look up AI agents on Wikipedia and write me a short report on them as a Word document. Save it in the reports folder of the shared workspace, open it on your desktop so I can see it, and send it to me.",
    web: agentsWeb,
    computer: {},
    checks: [
      answered,
      usedAnyTool("researches the web", ["web.search", "web.read_url"]),
      usedTool("shell.run"),
      savedFile(
        "saves a Word document in /workspace/reports",
        (f) => inReports(".docx")(f.path) && f.kind === "docx" && !f.error,
      ),
      savedFile(
        "writes the report from the research",
        (f) =>
          inReports(".docx")(f.path) &&
          /agent/i.test(f.text ?? "") &&
          (f.text ?? "").includes(SURVEY_SHARE),
      ),
      usedTool("desktop.open"),
      sentFile("sends the Word document", (f) => f.mimeType === WORD && f.size > 0),
      withinModelCalls(18),
    ],
  },
  {
    id: "desk.laptop-sheet",
    suite: "golden",
    description:
      "Compares two laptops from a shop's pages in an Excel sheet made with Python, opens it on the desktop and sends it.",
    agent: desk,
    prompt:
      "Make me an Excel sheet comparing the HP Victus 16 and the HP Omen 16: price and hardware specs side by side. Save it as hp-laptops.xlsx in the reports folder of the shared workspace, open it on your desktop and send it to me.",
    web: laptopsWeb,
    computer: {},
    checks: [
      answered,
      usedAnyTool("researches the web", ["web.search", "web.read_url"]),
      savedFile(
        "saves hp-laptops.xlsx in /workspace/reports",
        (f) => f.path === "/workspace/reports/hp-laptops.xlsx" && f.kind === "xlsx" && !f.error,
      ),
      savedFile(
        "names both laptops",
        (f) =>
          inReports(".xlsx")(f.path) && /victus/i.test(f.text ?? "") && /omen/i.test(f.text ?? ""),
      ),
      savedFile(
        "has both prices from the shop",
        (f) =>
          inReports(".xlsx")(f.path) &&
          price("1137").test(f.text ?? "") &&
          price("1684").test(f.text ?? ""),
      ),
      savedFile(
        "has the hardware specs",
        (f) =>
          inReports(".xlsx")(f.path) &&
          /8845HS/i.test(f.text ?? "") &&
          /14700HX/i.test(f.text ?? "") &&
          /4060/.test(f.text ?? "") &&
          /4070/.test(f.text ?? ""),
      ),
      usedTool("desktop.open"),
      sentFile("sends the Excel sheet", (f) => f.mimeType === EXCEL && f.size > 0),
      withinModelCalls(18),
    ],
  },
  {
    id: "desk.edit-in-app",
    suite: "golden",
    description:
      "Adds an item to a shopping list in the desktop's text editor and saves it, with no terminal or file tools to fall back on.",
    agent: appsOnly,
    prompt: `Open my shopping list (${SHOPPING_LIST}) in the text editor on your desktop, add oat milk at the end, and save it.`,
    web: { searches: [], pages: {} },
    computer: { files: { [SHOPPING_LIST]: `${SHOPPING_ITEMS.join("\n")}\n` } },
    checks: [
      answered,
      usedTool("desktop.open"),
      usedAnyTool("types in the app", ["desktop.type", "desktop.type_text"]),
      savedFile(
        "saves the list with oat milk added",
        (f) => f.path === SHOPPING_LIST && /oat milk/i.test(f.text ?? ""),
      ),
      savedFile(
        "keeps what was on the list",
        (f) =>
          f.path === SHOPPING_LIST &&
          SHOPPING_ITEMS.every((item) => new RegExp(`\\b${item}\\b`, "i").test(f.text ?? "")),
      ),
      withinModelCalls(16),
    ],
  },
];
