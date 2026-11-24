import assert from "node:assert/strict";
import test from "node:test";
import { creditWindows } from "./zai.ts";

test("creditWindows: empty array -> n/a", () => {
  assert.equal(creditWindows([]), "n/a");
});

test("creditWindows: two windows -> join ', '", () => {
  assert.equal(
    creditWindows([
      { type: "CREDIT_LIMIT", usage: 28000, currentValue: 2970 },
      { type: "CREDIT_LIMIT", usage: 140000, currentValue: 2970 },
    ]),
    "2970/28000, 2970/140000",
  );
});

test("creditWindows: non-numeric usage/currentValue -> n/a", () => {
  assert.equal(
    creditWindows([
      { type: "CREDIT_LIMIT", usage: "28000", currentValue: 2970 },
    ]),
    "n/a",
  );
  assert.equal(
    creditWindows([{ type: "CREDIT_LIMIT", usage: 28000, currentValue: null }]),
    "n/a",
  );
});

test("creditWindows: non-array -> n/a", () => {
  assert.equal(creditWindows(undefined), "n/a");
  assert.equal(creditWindows({ limits: [] }), "n/a");
});
