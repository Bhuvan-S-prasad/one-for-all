// Circuit breaker per model (ARCHITECTURE.md §11). After repeated failures a
// model is skipped for a cool-down, so a dead free model does not cost every
// run a timeout. Per model rather than per provider: on OpenRouter one free
// model can be down while the rest work, and a provider-wide outage opens
// every model's breaker within a few calls anyway.
//
// closed ──N failures──▶ open ──cool-down──▶ half-open ──success──▶ closed
//                         ▲                      │
//                         └──────failure─────────┘ (cool-down doubles)

export interface CircuitBreaker {
  /** True while the model is cooling down or a trial call is out. Changes nothing. */
  isOpen(key: string): boolean;
  /** Claim a call. False while open; in half-open, lets exactly one trial through. */
  canTry(key: string): boolean;
  success(key: string): void;
  failure(key: string): void;
}

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. Default 3. */
  readonly threshold?: number;
  /** First cool-down; doubles each time a trial fails. Default 30 s. */
  readonly cooldownMs?: number;
  /** Longest cool-down. Default 5 minutes. */
  readonly maxCooldownMs?: number;
  readonly now?: () => number;
}

interface State {
  failures: number;
  openUntil: number;
  cooldown: number;
  trialInFlight: boolean;
}

export function createCircuitBreaker(options: BreakerOptions = {}): CircuitBreaker {
  const threshold = options.threshold ?? 3;
  const baseCooldown = options.cooldownMs ?? 30_000;
  const maxCooldown = options.maxCooldownMs ?? 300_000;
  const now = options.now ?? Date.now;
  const states = new Map<string, State>();

  function get(key: string): State {
    let state = states.get(key);
    if (!state) {
      state = { failures: 0, openUntil: 0, cooldown: baseCooldown, trialInFlight: false };
      states.set(key, state);
    }
    return state;
  }

  return {
    isOpen(key) {
      const state = states.get(key);
      if (!state || state.failures < threshold) return false;
      return now() < state.openUntil || state.trialInFlight;
    },

    canTry(key) {
      const state = get(key);
      if (state.failures < threshold) return true;
      if (now() < state.openUntil || state.trialInFlight) return false;
      state.trialInFlight = true;
      return true;
    },

    success(key) {
      states.delete(key);
    },

    failure(key) {
      const state = get(key);
      const wasTrial = state.trialInFlight;
      state.trialInFlight = false;
      state.failures += 1;
      if (wasTrial) state.cooldown = Math.min(state.cooldown * 2, maxCooldown);
      if (state.failures >= threshold) state.openUntil = now() + state.cooldown;
    },
  };
}
