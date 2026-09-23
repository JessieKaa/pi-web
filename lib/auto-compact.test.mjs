import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { nextAutoCompactionEnabled } = await createJiti(import.meta.url).import("./auto-compact.ts");

test("auto-compact toggles when no argument is given", () => {
  assert.equal(nextAutoCompactionEnabled(true, ""), false);
  assert.equal(nextAutoCompactionEnabled(false, "  "), true);
});

test("auto-compact accepts on and off", () => {
  assert.equal(nextAutoCompactionEnabled(false, "ON"), true);
  assert.equal(nextAutoCompactionEnabled(true, "off"), false);
  assert.equal(nextAutoCompactionEnabled(true, "later"), null);
});
