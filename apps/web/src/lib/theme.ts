import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "ofa-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

export function getThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage blocked: fall back to the system setting.
  }
  return "system";
}

function isDark(preference: ThemePreference): boolean {
  return preference === "dark" || (preference === "system" && media.matches);
}

function apply(preference: ThemePreference): void {
  document.documentElement.classList.toggle("dark", isDark(preference));
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not persisted; still applied for this page.
  }
  apply(preference);
}

/** Apply the saved theme now and follow system changes. Call once at startup. */
export function initTheme(): void {
  apply(getThemePreference());
  media.addEventListener("change", () => apply(getThemePreference()));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved preference and whether dark mode is in effect; re-renders on change. */
export function useTheme(): { preference: ThemePreference; dark: boolean } {
  const preference = useSyncExternalStore(subscribe, getThemePreference);
  const dark = useSyncExternalStore(subscribe, () => isDark(getThemePreference()));
  return { preference, dark };
}
