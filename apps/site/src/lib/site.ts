// Addresses and facts the whole site repeats, kept in one place.

export const REPO_URL = "https://github.com/Bhuvan-S-prasad/one-for-all";
export const REPO_LABEL = "github.com/Bhuvan-S-prasad/one-for-all";

/** A repository file, on GitHub's main branch. */
export function repoFile(path: string): string {
  return `${REPO_URL}/blob/main/${path.replace(/^\/+/, "")}`;
}

export const reducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
