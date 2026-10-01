/** Up to two initials for an avatar: "Sam Taylor" → "ST". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const picked = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return (
    picked
      .map((part) => part?.[0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

/** "owner" → "Owner". */
export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** The first word of a name, for greetings. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "Morning", "Afternoon" or "Evening" for the given time. */
export function partOfDay(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

/** Short date for eyebrows: "Wed 01 Oct". */
export function shortDate(date: Date): string {
  const weekday = date.toLocaleDateString("en-GB", { weekday: "short" });
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleDateString("en-GB", { month: "short" });
  return `${weekday} ${day} ${month}`;
}
