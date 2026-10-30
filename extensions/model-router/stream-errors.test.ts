import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUsageLimitError, isUsageLimitStreamError } from "./stream-errors.ts";

describe("isUsageLimitError", () => {
  it("распознаёт текст ошибки компакции", () => {
    assert.equal(
      isUsageLimitError("Compaction failed: usage limit has been reached"),
      true,
    );
    assert.equal(
      isUsageLimitError("Compaction failed: rate limit exceeded"),
      false,
    );
  });
});

describe("isUsageLimitStreamError", () => {
  it("код usage_limit_reached", () => {
    assert.equal(
      isUsageLimitStreamError({ type: "error", code: "usage_limit_reached" }),
      true,
    );
  });

  it("сообщение инцидента codex", () => {
    assert.equal(
      isUsageLimitStreamError({
        type: "error",
        message: "The usage limit has been reached",
      }),
      true,
    );
  });

  it("вложенный error-объект", () => {
    assert.equal(
      isUsageLimitStreamError({
        type: "error",
        error: { code: "insufficient_quota" },
      }),
      true,
    );
    assert.equal(
      isUsageLimitStreamError({
        type: "error",
        error: { message: "out of budget" },
      }),
      true,
    );
  });

  it("квота-подписи провайдеров", () => {
    for (const message of [
      "quota exceeded",
      "available balance is too low",
      "billing hard limit",
    ]) {
      assert.equal(isUsageLimitStreamError({ type: "error", message }), true);
    }
  });

  it("rate limit не матчится", () => {
    assert.equal(
      isUsageLimitStreamError({
        type: "error",
        message: "rate limit exceeded",
      }),
      false,
    );
    assert.equal(
      isUsageLimitStreamError({ type: "error", code: "rate_limit_exceeded" }),
      false,
    );
  });

  it("чужие события и мусор", () => {
    assert.equal(
      isUsageLimitStreamError({
        type: "response.failed",
        error: { message: "usage limit" },
      }),
      false,
    );
    assert.equal(
      isUsageLimitStreamError({ type: "error", message: "server error" }),
      false,
    );
    assert.equal(isUsageLimitStreamError(null), false);
    assert.equal(isUsageLimitStreamError("error"), false);
  });
});
