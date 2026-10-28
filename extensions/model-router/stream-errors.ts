const USAGE_LIMIT_ERROR_PATTERN =
  /usage[ _-]?limit|insufficient_quota|out of budget|quota exceeded|available balance|billing/i;

export function isUsageLimitStreamError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const event = data as Record<string, unknown>;
  if (event.type !== "error") return false;
  const nested =
    event.error && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : {};
  const code = textOf(event.code) ?? textOf(nested.code) ?? "";
  const message = textOf(event.message) ?? textOf(nested.message) ?? "";
  return (
    USAGE_LIMIT_ERROR_PATTERN.test(code) ||
    USAGE_LIMIT_ERROR_PATTERN.test(message)
  );
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
