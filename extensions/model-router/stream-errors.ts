const USAGE_LIMIT_ERROR_PATTERN =
  /usage[ _-]?limit|insufficient_quota|out of budget|quota exceeded|available balance|billing/i;

export function isUsageLimitError(value: unknown): boolean {
  if (typeof value === "string") {
    return USAGE_LIMIT_ERROR_PATTERN.test(value);
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : {};
  const code = textOf(record.code) ?? textOf(nested.code) ?? "";
  const message = textOf(record.message) ?? textOf(nested.message) ?? "";
  return (
    USAGE_LIMIT_ERROR_PATTERN.test(code) ||
    USAGE_LIMIT_ERROR_PATTERN.test(message)
  );
}

export function isUsageLimitStreamError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const event = data as Record<string, unknown>;
  return event.type === "error" && isUsageLimitError(data);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
