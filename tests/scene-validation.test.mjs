import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSceneFromMarkdown, replaceSceneInMarkdown } from "../lib/lz-string.mjs";

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

test("validator accepts official Mermaid ids for shapes but keeps text ids strict", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-mermaid-ids-"));
  const basePath = path.join(fixtures, "clean.excalidraw.md");
  const markdown = await fs.readFile(basePath, "utf8");
  const { scene } = parseSceneFromMarkdown(markdown);
  const rectangle = structuredClone(scene.elements.find((element) => element.type === "rectangle"));
  const text = structuredClone(scene.elements.find((element) => element.type === "text"));
  try {
    rectangle.id = "Ab_cd-EfghijKLMNOPQ12";
    rectangle.boundElements = [];
    const mermaidPath = path.join(temporary, "mermaid.excalidraw.md");
    await fs.writeFile(mermaidPath, replaceSceneInMarkdown(markdown, { ...scene, elements: [rectangle] }));
    const mermaid = await run(mermaidPath);
    assert.equal(mermaid.code, 0, "معرّف Mermaid الرسمي لغير النص يجب أن يمر");
    assert.equal(mermaid.report.issues.some((issue) => issue.rule === "id-not-native"), false);

    text.id = "Ab_cd-EfghijKLMNOPQ12";
    text.containerId = null;
    const unsafeTextPath = path.join(temporary, "unsafe-text.excalidraw.md");
    await fs.writeFile(unsafeTextPath, replaceSceneInMarkdown(markdown, { ...scene, elements: [text] }));
    const unsafeText = await run(unsafeTextPath);
    assert.notEqual(unsafeText.code, 0, "معرّف النص يبقى مقيدًا بثمانية محارف");
    assert.ok(unsafeText.report.issues.some((issue) => issue.rule === "id-not-native" && issue.severity === "error"));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
