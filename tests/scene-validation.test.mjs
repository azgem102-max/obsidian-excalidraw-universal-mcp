import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "validate-scene.mjs");
const fixtures = path.join(root, "tests", "fixtures");

async function run(target) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [validator, "--path", target, "--json"]);
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code ?? 1, report: JSON.parse(error.stdout) };
  }
}

// هذا الاختبار يسدّ الثغرة التي سمحت بنشر أسهم غير مرتبطة: كل اختبارات القبول
// الأخرى تحتاج Obsidian بواجهة رسومية، وهذا يعمل بلا شيء.
test("validator passes a scene whose arrows are properly bound", async () => {
  const { code, report } = await run(path.join(fixtures, "clean.excalidraw.md"));
  assert.equal(code, 0, "a clean scene must exit zero");
  assert.equal(report.ok, true);
  assert.equal(report.issues.filter((issue) => issue.severity === "error").length, 0);
});

test("validator catches legacy start/end arrows that Auto Layout cannot see", async () => {
  const { code, report } = await run(path.join(fixtures, "legacy.excalidraw.md"));
  assert.notEqual(code, 0, "a scene with unbound arrows must exit non-zero");
  assert.equal(report.ok, false);
  const legacy = report.issues.filter((issue) => issue.rule === "arrow-legacy-binding");
  assert.ok(legacy.length > 0, "legacy start/end arrows must be reported");
  assert.match(legacy[0].message, /Auto Layout/);
});

test("validator reports non-schema fields and non-native identifiers", async () => {
  const { report } = await run(path.join(fixtures, "legacy.excalidraw.md"));
  const rules = new Set(report.issues.map((issue) => issue.rule));
  assert.ok(rules.has("non-schema-fields"), "createdAt/updatedAt must be reported");
  assert.ok(rules.has("id-not-native"), "identifiers outside the native 8-character alphabet must be reported");
});
