# evals

Agent behaviour tests ([ARCHITECTURE.md §12](../docs/architecture/ARCHITECTURE.md#12-observability-and-evals)). Each case runs the real harness, tool executor and policy engine against a live model, in an in-memory world: no database, and the web comes from `fixtures/`.

```sh
pnpm eval --list                         # the cases
pnpm eval                                # every case once
pnpm eval --case researcher --k 3        # repeat for pass^k
pnpm eval --model openrouter:vendor/model:free   # qualify one model for the tiers
```

Cases with a computer (`desk.*` and `redteam.page-runs-commands`, DT.12) run on the real dev sandbox from `pnpm infra:up`, as the agent `eval-desk`: its home is emptied before each attempt, and afterwards the files it made or changed are read back (Word and Excel files as text) and what it added to `/workspace` is removed. Without the sandbox those cases are skipped.

Needs `LLM_API_KEY` in the root `.env` and uses real quota (a few model calls per attempt). The exit code is non-zero when any case fails; the JSON report goes to your temp folder or `--out`.

| Folder      | Holds                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `suites/`   | Golden tasks by agent role                                                                                              |
| `redteam/`  | Injection and exfiltration cases: anything outbound after outside content must end with a person (`approve` or `deny`)  |
| `fixtures/` | Recorded web pages and search results, a fixture website and a mailbox app; made-up facts, so models must use the tools |
| `graders/`  | Checks, the agent world, the computer for desktop cases, the pass^k runner and the CLI                                                                  |

**Adding a case:** write an `EvalCase` (agent, prompt, fixtures, checks) in `suites/` or `redteam/`, add it to `ALL_CASES` in `graders/cli.ts`, and add a scripted-model test in `graders/runner.test.ts` (`graders/desk.test.ts` for cases with a computer) showing one passing and one failing transcript.
