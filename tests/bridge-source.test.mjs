import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(directory, "..", "obsidian-plugin", "main.js");
const root = path.resolve(directory, "..");

test("bridge protects new drawings from stale EA workbench elements", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const createDrawing = source.slice(source.indexOf("async createDrawing"), source.indexOf("isRegularMarkdown"));
  const openDrawing = source.slice(source.indexOf("async openDrawing"), source.indexOf("async createDrawing"));
  assert.match(createDrawing, /ea\.clear\(\);[\s\S]*await ea\.create/);
  assert.match(openDrawing, /getGlobalEA\(\)\.clear\(\)[\s\S]*leaf\.openFile[\s\S]*ea\.clear\(\)[\s\S]*ea\.setView\("active"\)/);
});

test("bridge operations have a timeout so one script cannot freeze the queue", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  assert.match(source, /OPERATION_TIMEOUT_MS = 30_000/);
  assert.match(source, /Promise\.race\(\[Promise\.resolve\(\)\.then\(operation\), timeout\]\)/);
});

test("snapshot restore uses the ExcalidrawAutomate scene wrapper", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const replaceScene = source.slice(source.indexOf("async replaceScene"), source.indexOf("async appendScene"));
  assert.match(replaceScene, /ea\.viewUpdateScene/);
  assert.match(replaceScene, /storeAction:/);
});

test("Obsidian note operations remain vault-scoped and recoverable", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  assert.match(source, /async createNote/);
  assert.match(source, /async updateNote/);
  assert.match(source, /async moveNote/);
  assert.match(source, /await this\.app\.vault\.trash\(file, false\)/);
  assert.match(source, /summary\.frontmatter = parseYaml/);
});

test("advanced rendering fails fast until the official Extras companion is enabled", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  assert.match(source, /EXCALIDRAW_EXTRAS_PLUGIN_ID = "excalidraw-extras"/);
  assert.match(source, /EXCALIDRAW_EXTRAS_REQUIRED/);
  assert.match(source, /this\.requireExcalidrawExtras\("Mermaid"\)/);
  assert.match(source, /this\.requireExcalidrawExtras\("LaTeX"\)/);
});

test("special text conversion is deterministic and uses native element identities", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const createElement = source.slice(source.indexOf("async createElement"), source.indexOf("async batchCreateElements"));
  assert.match(createElement, /previousIds/);
  assert.match(createElement, /resolvedId/);
  assert.match(source, /resolveTransclusionText/);
  assert.match(source, /rawText: visibleText, originalText: visibleText/);
  assert.match(source, /mcpTransclusion/);
  assert.match(source, /source: transclusionMarkup/);
  assert.doesNotMatch(source, /TRANSCLUSION_NOT_READY/);
  assert.match(source, /alphabet = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"/);
});

test("client IDs stay aliases and never become raw Text Elements identifiers", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const addElement = source.slice(source.indexOf("async addElementToWorkbench"), source.indexOf("async createElement"));
  const createElement = source.slice(source.indexOf("async createElement"), source.indexOf("async batchCreateElements"));
  const batchCreate = source.slice(source.indexOf("async batchCreateElements"), source.indexOf("async updateElement"));
  assert.match(addElement, /const id = randomId\(\)/);
  assert.doesNotMatch(addElement, /params\.id/);
  assert.match(createElement, /requestedId, resolvedId: id/);
  assert.match(batchCreate, /const aliases = new Map\(\)/);
  assert.match(batchCreate, /delete prepared\.id/);
  assert.match(batchCreate, /resolveAlias\(prepared\.startElementId\)/);
  assert.match(batchCreate, /requestedId: element\.id, resolvedId: ids\[index\]/);

  const liveRunner = await fs.readFile(path.join(root, "tests", "live-acceptance.mjs"), "utf8");
  assert.match(liveRunner, /rememberElementAliases/);
  assert.match(liveRunner, /elementId\("title001"\)/);
  assert.match(liveRunner, /elementIds: elementIds\.map\(elementId\)/);
});

test("update_element verifies the element payload and keeps both sides of bindings consistent", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const update = source.slice(source.indexOf("async updateElement"), source.indexOf("async deleteElement"));
  assert.match(update, /const after = result\.element/);
  assert.match(update, /BINDING_NOT_APPLIED/);
  assert.match(update, /UPDATE_NOT_APPLIED/);
  assert.match(update, /touchedAnchorIds/);
  assert.match(update, /withoutArrow/);
  assert.match(update, /return result/);
});

test("element styles reset before each creation and containment is informational", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const style = source.slice(source.indexOf("applyStyle(ea, params)"), source.indexOf("copyBindingTargetsToWorkbench"));
  const inspector = source.slice(source.indexOf("inspectVisualQuality"), source.indexOf("async getCanvasScreenshot"));
  assert.match(style, /fontSize: 20/);
  assert.match(style, /strokeStyle: "solid"/);
  assert.match(inspector, /type: "containment", severity: "info"/);
  assert.match(inspector, /warnings = issues\.filter/);
});

test("library persistence uses the Obsidian Excalidraw stencil store", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  assert.match(source, /getStencilLibrary/);
  assert.match(source, /setStencilLibrary/);
  assert.match(source, /library\.libraryItems/);
});

test("append-only drawing tools preserve the current scene in the EA workbench", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const helper = source.slice(source.indexOf("prepareWorkbenchForAppend"), source.indexOf("getFile("));
  assert.match(helper, /element\.type !== "text"/);
  assert.match(helper, /ea\.copyViewElementsToEAforEditing\(persistentElements, true\)/);
  assert.match(helper, /re-entering them corrupts text/);

  const boundaries = [
    ["async insertLibraryItem", "getScene()"],
    ["async createElement", "async batchCreateElements"],
    ["async batchCreateElements", "async updateElement"],
    ["async duplicateElements", "async alignElements"],
    ["async createFromMermaid", "async addImage"],
    ["async addImage", "async addLatex"],
    ["async addLatex", "async addEmbeddable"],
    ["async addEmbeddable", "async addFrame"],
  ];
  for (const [start, end] of boundaries) {
    const method = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    assert.match(method, /this\.prepareWorkbenchForAppend\(ea\)/, `${start} must preserve existing elements`);
    assert.doesNotMatch(method, /ea\.clear\(\)/, `${start} must not discard the append workbench`);
  }
});

test("visual quality does not mistake connector labels for shape text overflow", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const inspector = source.slice(source.indexOf("inspectVisualQuality"), source.indexOf("async getCanvasScreenshot"));
  assert.match(inspector, /!\["arrow", "line", "freedraw"\]\.includes\(container\.type\)/);
  assert.match(inspector, /isShapeContainer && \(element\.width > container\.width/);
});

test("simulated shadows are semantic and excluded from accidental-overlap findings", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  assert.match(source, /mcpRole: "drop-shadow"/);
  assert.match(source, /mcpShadowOf: original\.id/);
  assert.match(source, /element\.customData\?\.mcpRole !== "drop-shadow"/);
});

test("complete script packs and Arabic guides ship with the installer", async () => {
  const baseScripts = await fs.readdir(path.join(root, "base-scripts"));
  const professionalScripts = await fs.readdir(path.join(root, "professional-scripts"));
  assert.equal(baseScripts.filter((name) => name.endsWith(".md")).length, 17);
  assert.equal(professionalScripts.filter((name) => name.endsWith(".md")).length, 15);
  const installer = await fs.readFile(path.join(root, "install.mjs"), "utf8");
  assert.match(installer, /async function installContent/);
  assert.match(installer, /"base-scripts"/);
  assert.match(installer, /"professional-scripts"/);
  assert.match(installer, /الحزمة الاحترافية/);
  await fs.access(path.join(root, "START-HERE-AR.md"));
  await fs.access(path.join(root, "PROFESSIONAL-GUIDE-AR.md"));
  await fs.access(path.join(root, "SCRIPT-CATALOG-AR.md"));
  await fs.access(path.join(root, "ACCEPTANCE-TEST-MATRIX.md"));
});

test("script runner extracts JavaScript from Script Engine markdown wrappers", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  assert.match(source, /extractScriptSource\(source\)/);
  assert.match(source, /```\(\?:javascript\|js\)/);
  assert.match(source, /this\.extractScriptSource\(await this\.app\.vault\.read\(file\)\)/);
});

test("clear_canvas deletes live view elements before saving", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const start = source.indexOf("async clearCanvas");
  const clearCanvas = source.slice(start, source.indexOf("  snapshotScene(", start));
  assert.match(clearCanvas, /ea\.deleteViewElements\(elements\)/);
  assert.match(clearCanvas, /await this\.saveDrawing\(\)/);
});
