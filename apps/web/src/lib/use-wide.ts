import { useSyncExternalStore } from "react";

// Whether the screen is wide enough for side panels (Tailwind's `lg`).
// Panels that stream (the computer) render only then, not just hide.

const QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useWide(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}
