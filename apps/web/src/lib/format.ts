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
