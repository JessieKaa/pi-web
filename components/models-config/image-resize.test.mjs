import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { withImageResize } = await createJiti(import.meta.url).import("./models-config-types.ts");

const model = { id: "m", inputLimits: { maxRequestBytes: 10, images: { maxPerMessage: 2 } } };

test("image resize fields round-trip without dropping sibling limits", () => {
  const next = withImageResize(model, "maxWidth", "1024");
  assert.equal(next.inputLimits.maxRequestBytes, 10);
  assert.equal(next.inputLimits.images.maxPerMessage, 2);
  assert.deepEqual(next.inputLimits.images.resize, { maxWidth: 1024 });
  assert.equal(model.inputLimits.images.resize, undefined);
});

test("blank and invalid resize input drops only that field", () => {
  const sized = withImageResize(withImageResize(model, "maxWidth", "800"), "jpegQuality", "70");
  assert.equal(withImageResize(sized, "jpegQuality", "1.5"), sized);
  assert.equal(withImageResize(sized, "jpegQuality", "0"), sized);
  assert.equal(withImageResize(sized, "jpegQuality", "101"), sized);
  assert.equal(withImageResize(sized, "maxWidth", "0"), sized);
  assert.equal(withImageResize(sized, "jpegQuality", "100").inputLimits.images.resize.jpegQuality, 100);
  const cleared = withImageResize(sized, "maxWidth", " ");
  assert.deepEqual(cleared.inputLimits.images.resize, { jpegQuality: 70 });
  assert.equal(withImageResize(cleared, "jpegQuality", "").inputLimits.images.resize, undefined);
  assert.equal(withImageResize(cleared, "jpegQuality", "").inputLimits.images.maxPerMessage, 2);
});
