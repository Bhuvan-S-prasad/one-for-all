# ADR-0012: Credentials never reach the model or the sandbox

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Security
- **Related:** ADR-0011, ADR-0013, ARCHITECTURE.md §10.4; clarified by ADR-0022 (model API keys are decrypted in the model gateway)

## Context

Agents act with the user's OAuth tokens, API keys and saved passwords. Any value that appears in a prompt, log, trace, tool result or the sandbox can be exfiltrated through prompt injection or leaked through telemetry. Grok Bot takes the same stance: tools are invoked without the Bot receiving tokens, and secret values are replaced with `[REDACTED]` in output.

## Decision

- An envelope-encrypted vault in `packages/vault`: AES-256-GCM with a key from the OS keychain or environment in self-host mode; KMS in cloud mode.
- Secrets are decrypted only inside the tool executor, at call time.
- Known secret values are redacted from all tool output, logs and traces. Secret values must be at least 8 characters so redaction is reliable.
- Saved passwords are typed into the browser by a tool and never shown to the model. Passwords, 2FA, CAPTCHAs and payments use computer takeover.
- Tokens never enter the sandbox. The only credentials there are browser sessions the user created on purpose.

## Alternatives considered

- **Passing tokens to tools running in the sandbox:** one injected command could read them.

## Consequences

- **Positive:** an injected agent cannot leak what it never saw.
- **Negative:** some tools must be proxied through the executor instead of running in the sandbox; redaction has a minimum secret length.
- **Follow-up:** a secure secret-input component in web and mobile that never enters the transcript.
