/** Formatting helpers shared by Botbook's UI. */

export function blobColor(hue: number): string {
  return `var(--color-blob-${hue % 6})`;
}

/** Postgres timestamp text ("2026-10-13 19:01:02.12+00") → Date. */
export function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  let stamp = value.trim();
  if (!stamp.includes("T")) stamp = stamp.replace(" ", "T");
  stamp = stamp.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "now", "5m", "3h", "2d", or "Oct 3". */
export function ago(value: string | null | undefined): string {
  const date = parseStamp(value);
  if (!date) return "";
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
