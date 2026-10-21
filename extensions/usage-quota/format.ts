const ERROR_FROM: Record<string, number> = { "5h": 90 };
const WARN_FROM: Record<string, number> = { "5h": 80 };
const DEFAULT_ERROR_FROM = 80;
const DEFAULT_WARN_FROM = 60;

export function severity(
  label: string,
  usedPercent: number,
): "dim" | "warning" | "error" {
  const errorFrom = ERROR_FROM[label] ?? DEFAULT_ERROR_FROM;
  const warnFrom = WARN_FROM[label] ?? DEFAULT_WARN_FROM;
  if (usedPercent >= errorFrom) return "error";
  if (usedPercent >= warnFrom) return "warning";
  return "dim";
}

export function formatResetDateTime(ms: number, now = Date.now()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(ms);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const nowD = new Date(now);
  const sameDay =
    d.getFullYear() === nowD.getFullYear() &&
    d.getMonth() === nowD.getMonth() &&
    d.getDate() === nowD.getDate();
  return sameDay
    ? clock
    : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${clock}`;
}
