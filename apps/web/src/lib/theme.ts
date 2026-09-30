export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "ofa-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage blocked: fall back to the system setting.
  }
  return "system";
}

function apply(preference: ThemePreference): void {
  const dark = preference === "dark" || (preference === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
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
