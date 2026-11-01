import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResetDateTime, severity } from "./format.ts";

describe("formatResetDateTime", () => {
  const now = new Date(2026, 10, 8, 18, 30).getTime();

  it("сегодня → HH:MM", () => {
    const ms = new Date(2026, 10, 8, 9, 5).getTime();
    assert.equal(formatResetDateTime(ms, now), "09:05");
  });

  it("другой день → dd.mm без времени", () => {
    const ms = new Date(2026, 10, 2, 9, 5).getTime();
    assert.equal(formatResetDateTime(ms, now), "02.11");
  });

  it("граница суток: 23:59 сегодня → HH:MM, 00:00 завтра → dd.mm", () => {
    const todayEnd = new Date(2026, 10, 8, 23, 59).getTime();
    const nextStart = new Date(2026, 10, 9, 0, 0).getTime();
    assert.equal(formatResetDateTime(todayEnd, now), "23:59");
    assert.equal(formatResetDateTime(nextStart, now), "09.11");
  });
});

describe("severity", () => {
  it("5h: dim до 80, warning от 80, error от 90", () => {
    assert.equal(severity("5h", 79.9), "dim");
    assert.equal(severity("5h", 80), "warning");
    assert.equal(severity("5h", 89.9), "warning");
    assert.equal(severity("5h", 90), "error");
  });

  it("дефолт: dim до 60, warning от 60, error от 80", () => {
    assert.equal(severity("wk", 59.9), "dim");
    assert.equal(severity("wk", 60), "warning");
    assert.equal(severity("wk", 79.9), "warning");
    assert.equal(severity("wk", 80), "error");
  });
});
