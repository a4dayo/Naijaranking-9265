/** Small display helpers — no data logic, the server owns every count. */

export function votes(n: number) {
  const rounded = Math.round(n * 100) / 100;
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (rounded >= 10_000) return `${(rounded / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return Number.isInteger(rounded) ? rounded.toLocaleString("en-NG") : rounded.toFixed(2);
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${votes(n)} ${n === 1 ? one : many}`;
}

export function timeAgo(value: string | Date | null | undefined) {
  if (!value) return "never";
  const then = new Date(value).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function shortDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function dateTime(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-NG", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Countdown like "3d 04h" / "06h 12m" / "04m 20s". Null once it has passed. */
export function countdown(to: string | Date | null | undefined) {
  if (!to) return null;
  const ms = new Date(to).getTime() - Date.now();
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export const CATEGORY_ORDER = ["Music", "Film", "People", "Places", "Culture"] as const;
