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

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "14:05:09" in local time. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** "42 s", "3 min 05 s". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** "1 model call", "3 model calls". */
export function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** "14:05" in local time, for message times. */
export function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "Today", "Yesterday", or "Mon 29 Sep", for grouping by day. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return shortDate(day);
}

/** "0:42" until a time, for countdowns; "0:00" once it has passed. */
export function countdown(untilIso: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(untilIso) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
