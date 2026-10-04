# evals

Agent behaviour tests ([ARCHITECTURE.md §12](../docs/architecture/ARCHITECTURE.md#12-observability-and-evals)). Each case runs the real harness, tool executor and policy engine against a live model, in an in-memory world: no database, and the web comes from `fixtures/`.

```sh
pnpm eval --list                         # the cases
pnpm eval                                # every case once
pnpm eval --case researcher --k 3        # repeat for pass^k
pnpm eval --model openrouter:vendor/model:free   # qualify one model for the tiers
```

Needs `LLM_API_KEY` in the root `.env` and uses real quota (a few model calls per attempt). The exit code is non-zero when any case fails; the JSON report goes to your temp folder or `--out`.

| Folder | Holds |
|---|---|
| `suites/` | Golden tasks by agent role |
| `redteam/` | Injection and exfiltration cases |
| `fixtures/` | Recorded web pages and search results; made-up facts, so models must use the tools |
| `graders/` | Checks, the agent world, the pass^k runner and the CLI |

**Adding a case:** write an `EvalCase` (agent, prompt, fixtures, checks) in `suites/` or `redteam/`, add it to `ALL_CASES` in `graders/cli.ts`, and add a scripted-model test in `graders/runner.test.ts` showing one passing and one failing transcript.
