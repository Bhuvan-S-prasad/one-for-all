// Shared ESLint flat configs for One-for-All.
//
// Usage in a package's eslint.config.js:
//   import { node, boundaries } from "@ofa/eslint-config";
//   export default [...node, ...boundaries.serverPackage];

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const ignores = {
  ignores: ["**/dist/**", "**/build/**", "**/coverage/**", "**/.turbo/**", "**/*.gen.ts"],
};

/** TypeScript rules shared by every package. */
export const base = [
  ignores,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "smart"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
];

/** Server packages and apps running on Node. */
export const node = [...base, { languageOptions: { globals: { ...globals.node } } }];

/** Browser apps using React. */
export const react = [
  ...base,
  reactHooks.configs.flat.recommended,
  { languageOptions: { globals: { ...globals.browser } } },
];

// ── Import boundaries (ARCHITECTURE.md §17, rules R1–R5) ─────────────────────
// Deep imports are also blocked at resolution time by each package's
// `exports` field; these rules give a clear message instead.

const SCOPE = "@ofa";

/** Dev tooling (lint, tsconfig, tailwind) may be imported from config files anywhere. */
const TOOLING = ["eslint-config", "tsconfig", "tailwind-config"];

const DEEP_IMPORT = {
  regex: `^${SCOPE}/[^/]+/.+`,
  message: "Import from the package root only (R5). Deep imports are not allowed.",
};

/**
 * Model SDKs stay inside packages/llm so providers remain replaceable
 * (ADR-0022). Everything else calls `LLMGateway`.
 */
const MODEL_SDKS = {
  regex: "^(?:ai|@ai-sdk/[^/]+|@openrouter/[^/]+)(?:/.*)?$",
  message: "Model SDKs are used only in packages/llm (ADR-0022). Call LLMGateway instead.",
};

/**
 * Restrict which workspace packages may be imported.
 * @param {string[]} allowed package names without the scope, e.g. ["core", "contracts"]
 * @param {string} reason shown in the lint error
 */
function onlyWorkspaceImports(allowed, reason) {
  const allowedGroup = `(?!(?:${[...allowed, ...TOOLING].join("|")})$)`;
  return [
    {
      files: ["**/*.{ts,tsx,js,jsx,mts,cts}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              DEEP_IMPORT,
              MODEL_SDKS,
              {
                regex: `^${SCOPE}/${allowedGroup}[^/]+$`,
                message: reason,
              },
            ],
          },
        ],
      },
    },
  ];
}

export const boundaries = {
  /** packages/core imports nothing internal (R2). */
  core: onlyWorkspaceImports([], "packages/core must not import other workspace packages (R2)."),

  /** Browser-safe packages (contracts, client) may import only core and contracts. */
  browserPackage: onlyWorkspaceImports(
    ["core", "contracts"],
    "Browser-safe packages may import only @ofa/core and @ofa/contracts (R3).",
  ),

  /** Web and mobile apps import only browser-safe packages (R3). */
  clientApp: onlyWorkspaceImports(
    ["core", "contracts", "client"],
    "Web and mobile may import only @ofa/core, @ofa/contracts and @ofa/client (R3).",
  ),

  /** Server packages and apps: any package, still no deep imports (R5) and no model SDKs. */
  serverPackage: [
    {
      files: ["**/*.{ts,tsx,js,jsx,mts,cts}"],
      rules: { "no-restricted-imports": ["error", { patterns: [DEEP_IMPORT, MODEL_SDKS] }] },
    },
  ],

  /**
   * packages/llm: the gateway may use the AI SDK, but a provider's own SDK
   * appears only in that provider's file under src/providers/ (ADR-0022).
   */
  llmPackage: [
    {
      files: ["**/*.{ts,tsx,js,jsx,mts,cts}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              DEEP_IMPORT,
              {
                regex: "^(?:@ai-sdk/(?!provider$)[^/]+|@openrouter/[^/]+)(?:/.*)?$",
                message: "A provider's SDK belongs in src/providers/<name>.ts only (ADR-0022).",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["src/providers/**"],
      rules: { "no-restricted-imports": ["error", { patterns: [DEEP_IMPORT] }] },
    },
  ],
};
