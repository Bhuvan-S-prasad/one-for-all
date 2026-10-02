import type { ModelDetails, ModelProvider } from "./provider";

// Model metadata per provider: context windows for context budgets (§7),
// prices for metering, tool support for tier checks. Fetched lazily and kept
// for an hour; a failed refresh keeps the last good list.

export interface ModelCatalog {
  get(provider: ModelProvider, modelId: string): Promise<ModelDetails | undefined>;
}

export interface CatalogOptions {
  readonly ttlMs?: number;
  /** After a failed fetch with nothing cached, wait this long before trying again. */
  readonly retryMs?: number;
  readonly now?: () => number;
}

interface Entry {
  models: Map<string, ModelDetails>;
  expires: number;
  pending?: Promise<void>;
}

export function createModelCatalog(options: CatalogOptions = {}): ModelCatalog {
  const ttl = options.ttlMs ?? 3_600_000;
  const retry = options.retryMs ?? 60_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function refresh(provider: ModelProvider, entry: Entry): Promise<void> {
    entry.pending ??= provider
      .listModels()
      .then((models) => {
        entry.models = new Map(models.map((model) => [model.id, model]));
        entry.expires = now() + ttl;
      })
      .catch(() => {
        // Keep what we have; try again later. Calls still work without
        // metadata, with a conservative context window.
        entry.expires = now() + (entry.models.size > 0 ? ttl : retry);
      })
      .finally(() => {
        entry.pending = undefined;
      });
    return entry.pending;
  }

  return {
    async get(provider, modelId) {
      let entry = entries.get(provider.id);
      if (!entry) {
        entry = { models: new Map(), expires: 0 };
        entries.set(provider.id, entry);
      }
      if (now() >= entry.expires) {
        const refreshing = refresh(provider, entry);
        // Wait only for the first load; later refreshes happen in the background.
        if (entry.models.size === 0) await refreshing;
      }
      return entry.models.get(modelId);
    },
  };
}
