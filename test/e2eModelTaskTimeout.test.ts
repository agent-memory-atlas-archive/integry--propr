import { readFileSync } from "node:fs";
import { MODEL_MATRIX_PLAN_BUDGET_MS, PLAN_SUITE_CLEANUP_MS } from "./e2e/planGeneration.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_TASK_TIMEOUT_MS,
  parseModelTaskTimeoutMs,
} from "./e2e/modelTaskTimeout.js";

describe("E2E model-task timeout configuration", () => {
  test("defaults to a bounded 30-minute polling budget", () => {
    assert.equal(DEFAULT_MODEL_TASK_TIMEOUT_MS, 1_800_000);
    assert.equal(parseModelTaskTimeoutMs(undefined), DEFAULT_MODEL_TASK_TIMEOUT_MS);
    assert.equal(parseModelTaskTimeoutMs("   "), DEFAULT_MODEL_TASK_TIMEOUT_MS);
  });

  test("accepts a positive integer override", () => {
    assert.equal(parseModelTaskTimeoutMs("1500000"), 1_500_000);
  });

  test("falls back safely for invalid, zero, and negative overrides", () => {
    const fallback = 1_800_000;
    for (const value of ["invalid", "0", "-1", "1.5", "Infinity", "9007199254740992"]) {
      assert.equal(parseModelTaskTimeoutMs(value, fallback), fallback, value);
    }
  });
});

// Read the live suite declaration without importing or executing live tests.
test("model suite accommodates plan creation, both polling phases and cleanup within the live work budget", () => {
  const source = readFileSync(new URL("./e2e.test.ts", import.meta.url), "utf8");
  const expression = source.match(/describe\("11\. Model matrix", \{ timeout: ([^,]+),/)?.[1];
  assert.ok(expression);
  for (const taskBudget of [1_500_000, DEFAULT_MODEL_TASK_TIMEOUT_MS]) {
    const suiteBudget = Function("MODEL_MATRIX_PLAN_BUDGET_MS", "MODEL_TASK_TIMEOUT_MS", `return ${expression}`)(MODEL_MATRIX_PLAN_BUDGET_MS, taskBudget);
    assert.ok(suiteBudget >= MODEL_MATRIX_PLAN_BUDGET_MS + 2 * taskBudget + PLAN_SUITE_CLEANUP_MS);
    assert.ok(suiteBudget < 110 * 60_000);
  }
});
