#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function argumentsMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

const args = argumentsMap(process.argv.slice(2));
if (!args.vault || !args.output) {
  process.stderr.write("Usage: node live-acceptance.mjs --vault <path> --output <folder>\n");
  process.exit(2);
}

const vault = path.resolve(args.vault);
const output = path.resolve(args.output);
await fs.mkdir(output, { recursive: true });
const settings = JSON.parse(await fs.readFile(path.join(vault, ".obsidian", "plugins", "obsidian-excalidraw-mcp-bridge", "data.json"), "utf8"));
const endpoint = `http://127.0.0.1:${settings.port}/rpc`;
const report = {
  startedAt: new Date().toISOString(),
  runId: null,
  bridge: null,
  passed: 0,
  failed: 0,
  optionalFailures: 0,
  skipped: 0,
  tests: [],
};

async function rpc(method, params = {}, timeout = 45_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const error = new Error(`${body?.error?.code || response.status}: ${body?.error?.message || "RPC failed"}`);
    error.details = body?.error?.details;
    throw error;
  }
  return body.result;
}

async function test(name, action, options = {}) {
  const started = Date.now();
  try {
    const evidence = await action();
    const status = evidence?.skipped ? "skipped" : "passed";
    report[status] += 1;
    report.tests.push({ name, status, durationMs: Date.now() - started, evidence });
    return evidence;
  } catch (error) {
    if (options.optional) report.optionalFailures += 1;
    else report.failed += 1;
    report.tests.push({
      name,
      status: options.optional ? "optional-failure" : "failed",
      durationMs: Date.now() - started,
      error: error.message,
      details: error.details,
    });
    if (options.fatal) throw error;
    return null;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function idByText(scene, text) {
  return scene.elements.find((element) => element.type === "text" && (element.rawText === text || element.originalText === text || element.text === text))?.id;
}

const status = await test("status and bridge version", async () => {
  const value = await rpc("status");
  assert(value.bridgeVersion === "0.5.3", `Expected bridge 0.5.3, received ${value.bridgeVersion}`);
  assert(value.excalidrawExtras?.installed, "Excalidraw Extras is not installed");
  assert(value.excalidrawExtras?.enabled, "Excalidraw Extras is not enabled");
  report.bridge = value;
  return value;
}, { fatal: true });

const runId = String(args["run-id"] || `جولة-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "-");
report.runId = runId;
const noteRoot = `مختبر القبول MCP/${runId}`;
const noteA = `${noteRoot}/ملاحظة مرجعية.md`;
const noteB = `${noteRoot}/ملاحظة روابط.md`;
const movedNoteB = `${noteRoot}/منظم/ملاحظة روابط منقولة.md`;

await test("create_note", async () => rpc("create_note", {
  path: noteA,
  frontmatter: { type: "acceptance-test", status: "active", tags: ["اختبار", "mcp"] },
  content: "# ملاحظة مرجعية\n\nهذه ملاحظة أنشأها اختبار القبول.\n\n## قسم الهدف\n\nمحتوى مرجعي. ^acceptance-block\n",
  overwrite: true,
}));
await test("read_note", async () => {
  const value = await rpc("read_note", { path: noteA });
  assert(value.content.includes("قسم الهدف"), "Note content missing");
  assert(value.frontmatter.type === "acceptance-test", "Frontmatter missing");
  return { path: value.path, headingCount: value.headingCount };
});
await test("update_note", async () => {
  await rpc("update_note", { path: noteA, append: "\n## تحديث\n\nتم التحديث.\n", frontmatter: { status: "verified", owner: "Codex" } });
  const value = await rpc("read_note", { path: noteA });
  assert(value.content.includes("تم التحديث"), "Append failed");
  assert(value.frontmatter.status === "verified", "Frontmatter patch failed");
  return { status: value.frontmatter.status };
});
await test("create backlinks note", async () => rpc("create_note", {
  path: noteB,
  content: `# ملاحظة روابط\n\nترتبط بـ [[${noteA.replace(/\.md$/, "")}]].\n`,
  overwrite: true,
}));
await new Promise((resolve) => setTimeout(resolve, 750));
await test("search_notes", async () => {
  const value = await rpc("search_notes", { query: "اختبار القبول", folder: noteRoot, limit: 20 });
  assert(value.count >= 1, "Search returned no results");
  return { count: value.count };
});
await test("get_backlinks", async () => {
  const value = await rpc("get_backlinks", { path: noteA });
  assert(value.backlinks.some((item) => item.sourcePath === noteB), "Backlink missing");
  return { count: value.count };
});
await test("move_note", async () => rpc("move_note", { path: noteB, newPath: movedNoteB }));
await test("list_notes", async () => {
  const value = await rpc("list_notes", { folder: noteRoot });
  assert(value.count >= 2, "List notes incomplete");
  return { count: value.count };
});
await test("get_vault_structure", async () => {
  const value = await rpc("get_vault_structure", { maxDepth: 4 });
  assert(value.folders.some((folder) => folder.path === noteRoot), "Test folder missing");
  return { folderCount: value.folders.length };
});
await test("search_vault_images", async () => {
  const value = await rpc("search_vault_images", { query: "تجربة MCP الاحترافية", limit: 20 });
  assert(value.count >= 1, "Known PNG not found");
  return { count: value.count, first: value.images[0]?.path };
});

const drawingFolder = `${noteRoot}/رسومات`;
const drawingPath = `${drawingFolder}/01-اختبار الأدوات.excalidraw.md`;
await test("create_drawing stays empty", async () => {
  const value = await rpc("create_drawing", { filename: "01-اختبار الأدوات", foldername: drawingFolder, open: true, plaintext: "لوحة قبول آلية." });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const scene = await rpc("get_scene");
  assert(value.path === drawingPath, `Unexpected path ${value.path}`);
  assert(scene.elementCount === 0, `New drawing inherited ${scene.elementCount} elements`);
  return { path: value.path, elementCount: scene.elementCount };
});

await test("batch_create all basic element types and styles", async () => {
  const value = await rpc("batch_create_elements", { elements: [
    { id: "rect-a", type: "rectangle", x: 100, y: 180, width: 180, height: 90, backgroundColor: "#dbeafe", strokeColor: "#2563eb", fillStyle: "solid", roughness: 0 },
    { id: "rect-b", type: "rectangle", x: 380, y: 130, width: 150, height: 80, backgroundColor: "#ede9fe", strokeColor: "#7c3aed", fillStyle: "hachure", roughness: 1 },
    { id: "rect-c", type: "rectangle", x: 700, y: 240, width: 210, height: 100, backgroundColor: "#dcfce7", strokeColor: "#15803d", fillStyle: "cross-hatch", roughness: 2 },
    { id: "ellipse-a", type: "ellipse", x: 100, y: 420, width: 180, height: 90, backgroundColor: "#fef3c7", strokeColor: "#b45309", fillStyle: "solid" },
    { id: "diamond-a", type: "diamond", x: 400, y: 400, width: 180, height: 110, backgroundColor: "#fee2e2", strokeColor: "#dc2626", fillStyle: "solid" },
    { id: "blob-a", type: "blob", x: 720, y: 410, width: 190, height: 100, backgroundColor: "#fce7f3", strokeColor: "#be185d", fillStyle: "solid" },
    { id: "line-a", type: "line", x: 100, y: 600, points: [[0,0],[180,0]], strokeColor: "#475569", strokeStyle: "dashed" },
    { id: "arrow-straight", type: "arrow", x: 350, y: 600, points: [[0,0],[180,0]], strokeColor: "#475569", endArrowhead: "arrow" },
    { id: "arrow-curved", type: "arrow", x: 600, y: 600, points: [[0,0],[90,-60],[180,0]], roundness: { type: 2 }, strokeColor: "#7c3aed", endArrowhead: "triangle" },
    { id: "arrow-elbow", type: "arrow", x: 850, y: 600, points: [[0,0],[0,-60],[180,-60],[180,0]], elbowed: true, strokeColor: "#15803d" },
    { id: "free-a", type: "freedraw", x: 100, y: 720, points: [[0,0],[40,-20],[80,15],[130,-10],[180,0]], pressures: [0.5,0.7,0.4,0.8,0.5], simulatePressure: false, strokeColor: "#3e6f8d", strokeWidth: 2 },
    { id: "title001", type: "text", x: 100, y: 60, text: "مختبر القبول البصري", fontSize: 32, fontFamily: 4, strokeColor: "#172554" },
  ] });
  assert(value.count === 12, `Expected 12 elements, received ${value.count}`);
  return { count: value.count };
});

await test("get/query/update/style tools", async () => {
  const before = await rpc("get_element", { id: "rect-a" });
  assert(before.element.backgroundColor === "#dbeafe", "get_element mismatch");
  await rpc("update_element", { id: "rect-a", width: 200, opacity: 90, angle: 0.05 });
  await rpc("apply_style_to_elements", { elementIds: ["rect-a", "rect-b", "rect-c"], style: { strokeWidth: 2, roundness: { type: 3 } } });
  const query = await rpc("query_elements", { type: "rectangle" });
  assert(query.count === 3, `Expected 3 rectangles, received ${query.count}`);
  return { rectangles: query.count };
});

await test("align/distribute/group/lock/duplicate/ungroup", async () => {
  await rpc("align_elements", { elementIds: ["rect-a", "rect-b", "rect-c"], alignment: "top" });
  await rpc("distribute_elements", { elementIds: ["rect-a", "rect-b", "rect-c"], direction: "horizontal" });
  const group = await rpc("group_elements", { elementIds: ["rect-a", "rect-b", "rect-c"] });
  await rpc("lock_elements", { elementIds: ["rect-a", "rect-b", "rect-c"] });
  await rpc("unlock_elements", { elementIds: ["rect-a", "rect-b", "rect-c"] });
  const copies = await rpc("duplicate_elements", { elementIds: ["rect-a", "rect-b", "rect-c"], offsetX: 0, offsetY: 160 });
  await rpc("ungroup_elements", { groupId: group.groupId });
  assert(copies.ids.length === 3, "Duplicate count mismatch");
  return { groupId: group.groupId, copies: copies.ids.length };
});

await test("z-order and drop shadow", async () => {
  await rpc("set_z_order", { elementIds: ["rect-a"], position: "front" });
  const value = await rpc("create_drop_shadow", { elementIds: ["rect-a", "ellipse-a"], offsetX: 12, offsetY: 12, opacity: 18, locked: true, group: true });
  assert(value.count === 2, "Shadow count mismatch");
  return value;
});

await test("snapshot restore preserves text", async () => {
  const before = await rpc("get_scene");
  const expectedText = before.elements.find((element) => element.id === "title001")?.rawText;
  await rpc("snapshot_scene", { name: "قبول-قبل-التعديل" });
  await rpc("update_element", { id: "title001", text: "نص مؤقت" });
  await rpc("restore_snapshot", { name: "قبول-قبل-التعديل" });
  const after = await rpc("get_scene");
  const restoredText = after.elements.find((element) => element.id === "title001")?.rawText;
  assert(restoredText === expectedText, `Snapshot text changed: ${restoredText}`);
  return { expectedText, restoredText };
});

await test("resources scene/elements/theme/library", async () => {
  const results = {};
  for (const resource of ["scene", "elements", "theme", "library"]) results[resource] = await rpc("get_resource", { resource });
  assert(Array.isArray(results.elements.elements), "Elements resource invalid");
  assert(typeof results.theme.theme === "string", "Theme resource invalid");
  return { libraryCount: results.library.count, theme: results.theme.theme };
});

await test("set pen", async () => rpc("set_pen", { preset: "highlighter", strokeColor: "#facc15", strokeWidth: 4, constantPressure: true }));
const advancedElementIds = new Set();
let transclusionExpectation = null;
const mermaidTextExpectations = [];
await test("create Obsidian link and transclusion", async () => {
  await rpc("create_obsidian_link", { elementId: "rect-a", filePath: noteA, heading: "قسم الهدف", alias: "المرجع" });
  const transclusion = await rpc("create_transclusion", { filePath: noteA, blockId: "acceptance-block", wrapAt: 40, x: 1000, y: 180, fontSize: 18, fontFamily: 4 });
  advancedElementIds.add(transclusion.element.id);
  assert(transclusion.element.text === "محتوى مرجعي.", `Unexpected transclusion text: ${transclusion.element.text}`);
  assert(!/\^[A-Za-z0-9_-]{6,}/.test(transclusion.element.text), "Transclusion exposes a Markdown block ID");
  transclusionExpectation = {
    id: transclusion.element.id,
    text: transclusion.element.text,
    source: transclusion.transclusion,
  };
  return { transclusionId: transclusion.element.id };
});
await test("set drawing frontmatter", async () => rpc("set_drawing_frontmatter", { properties: {
  "excalidraw-export-transparent": false,
  "excalidraw-export-padding": 20,
  "excalidraw-export-pngscale": 2,
  "excalidraw-default-mode": "view",
  tags: ["اختبار", "excalidraw"],
} }));

await test("add frame", async () => {
  const value = await rpc("add_frame", { x: 40, y: 30, width: 1300, height: 850, name: "اختبار الأدوات" });
  advancedElementIds.add(value.element.id);
  return value;
});
await test("add image", async () => {
  const value = await rpc("add_image", { x: 1000, y: 420, filePath: "اختبارات MCP/تجربة MCP الاحترافية.png" });
  advancedElementIds.add(value.element.id);
  return value;
});
await test("add embeddable", async () => {
  const value = await rpc("add_embeddable", { x: 1550, y: 100, width: 420, height: 360, filePath: noteA });
  advancedElementIds.add(value.element.id);
  return value;
});
await test("add LaTeX", async () => {
  const value = await rpc("add_latex", { x: 1050, y: 700, latex: "E = mc^2", scaleX: 1.2, scaleY: 1.2 }, 45_000);
  advancedElementIds.add(value.element.id);
  return value;
});
await test("Mermaid conversion", async () => {
  const value = await rpc("create_from_mermaid", { mermaidDiagram: "flowchart LR\n A[بداية] --> B{قرار}\n B -->|نعم| C[نتيجة]", groupElements: true }, 45_000);
  const scene = await rpc("get_scene");
  const mermaidElements = scene.elements.filter((element) => value.ids.includes(element.id));
  mermaidTextExpectations.push(
    ...mermaidElements
      .filter((element) => element.type === "text")
      .map((element) => ({
        id: element.id,
        text: element.text,
        rawText: element.rawText,
        originalText: element.originalText,
      })),
  );
  await rpc("patch_elements", { patches: mermaidElements.map((element) => ({ id: element.id, set: { x: element.x + 1550, y: element.y + 700 } })) });
  value.ids.forEach((id) => advancedElementIds.add(id));
  return value;
});

await test("library save, search, and insert", async () => {
  const name = `عينة القبول ${runId}`;
  const saved = await rpc("save_elements_to_library", {
    elementIds: ["rect-a", "rect-b", "arrow-straight"],
    name,
    status: "published",
  });
  assert(saved.item.elementCount === 3, `Expected a three-element library item, received ${saved.item.elementCount}`);
  const library = await rpc("search_library", { query: name });
  assert(library.count >= 1, "Saved library item was not found by name");
  const inserted = await rpc("insert_library_item", { itemId: saved.item.id, x: 2100, y: 100, scale: 0.7 });
  assert(inserted.count === 3, `Expected three inserted library elements, received ${inserted.count}`);
  inserted.ids.forEach((id) => advancedElementIds.add(id));
  return { saved: saved.item, matches: library.count, inserted: inserted.count };
});

await test("advanced elements persist after save and reopen", async () => {
  await rpc("save_drawing");
  await rpc("open_drawing", { path: drawingPath });
  const scene = await rpc("get_scene");
  const present = new Set(scene.elements.map((element) => element.id));
  const missing = [...advancedElementIds].filter((id) => !present.has(id));
  assert(missing.length === 0, `Advanced elements were not persisted: ${missing.join(", ")}`);
  const transclusion = scene.elements.find((element) => element.id === transclusionExpectation?.id);
  assert(transclusion, "Persisted transclusion is missing");
  assert(transclusion.text === transclusionExpectation.text, `Persisted transclusion text changed: ${transclusion.text}`);
  assert(!/\^[A-Za-z0-9_-]{6,}/.test(transclusion.text), "Persisted transclusion exposes a Markdown block ID");
  assert(
    transclusion.customData?.mcpTransclusion?.source === transclusionExpectation.source,
    "Persisted transclusion source metadata changed",
  );
  for (const expected of mermaidTextExpectations) {
    const label = scene.elements.find((element) => element.id === expected.id);
    assert(label, `Persisted Mermaid label is missing: ${expected.id}`);
    assert(label.text === expected.text, `Persisted Mermaid label changed: ${expected.id}`);
    assert(label.rawText === expected.rawText, `Persisted Mermaid rawText changed: ${expected.id}`);
    assert(label.originalText === expected.originalText, `Persisted Mermaid originalText changed: ${expected.id}`);
    assert(!/\^[A-Za-z0-9_-]{6,}/.test(label.rawText || ""), `Persisted Mermaid label exposes a block ID: ${expected.id}`);
  }
  assert(scene.elements.length >= 31, `Expected a rich persisted scene, received ${scene.elements.length} elements`);
  return { expectedAdvanced: advancedElementIds.size, elementCount: scene.elements.length };
});

await test("visual quality inspector", async () => {
  const value = await rpc("inspect_visual_quality", { minFontSize: 16 });
  assert(typeof value.score === "number", "Quality score missing");
  assert(value.summary.passed, `Visual quality issues: ${JSON.stringify(value.issues)}`);
  return { score: value.score, summary: value.summary, issues: value.issues };
});

await test("save and exports", async () => {
  await rpc("save_drawing");
  const scene = await rpc("export_scene", { filePath: `${drawingFolder}/01-اختبار الأدوات.excalidraw` });
  const png = await rpc("export_to_image", { format: "png", filePath: `${drawingFolder}/01-اختبار الأدوات.png`, scale: 2 });
  const svg = await rpc("export_to_image", { format: "svg", filePath: `${drawingFolder}/01-اختبار الأدوات.svg`, scale: 1 });
  const screenshot = await rpc("get_canvas_screenshot", { background: true, scale: 1 });
  await fs.writeFile(path.join(output, "01-اختبار الأدوات.png"), Buffer.from(screenshot.data, "base64"));
  return { sceneBytes: scene.bytes, pngBytes: png.bytes, svgBytes: svg.bytes, screenshotElements: screenshot.elementCount };
});

await test("import merge rejects duplicates safely", async () => {
  try {
    await rpc("import_scene", { mode: "merge", filePath: `${drawingFolder}/01-اختبار الأدوات.excalidraw` });
  } catch (error) {
    assert(error.message.includes("DUPLICATE_ELEMENT_ID"), `Unexpected import error ${error.message}`);
    return { duplicateProtected: true };
  }
  throw new Error("Duplicate merge unexpectedly succeeded");
});

const scriptsDrawingPath = `${drawingFolder}/02-اختبار السكربتات.excalidraw.md`;
await test("prepare scripts drawing", async () => {
  await rpc("create_drawing", { filename: "02-اختبار السكربتات", foldername: drawingFolder, open: true, plaintext: "اختبار سكربتات معزول." });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const scene = await rpc("get_scene");
  assert(scene.path === scriptsDrawingPath && scene.elementCount === 0, "Scripts drawing is not clean");
  await rpc("batch_create_elements", { elements: [
    { id: "s-a", type: "rectangle", x: 100, y: 180, width: 180, height: 90, backgroundColor: "#dbeafe", strokeColor: "#2563eb", fillStyle: "solid" },
    { id: "s-b", type: "rectangle", x: 420, y: 260, width: 220, height: 110, backgroundColor: "#ede9fe", strokeColor: "#7c3aed", fillStyle: "solid" },
    { id: "s-c", type: "rectangle", x: 780, y: 150, width: 150, height: 70, backgroundColor: "#dcfce7", strokeColor: "#15803d", fillStyle: "solid" },
    { id: "s-arrow", type: "arrow", x: 280, y: 225, points: [[0,0],[70,-40],[140,0]], strokeColor: "#475569", endArrowhead: "arrow" },
    { id: "sText001", type: "text", x: 100, y: 80, text: "سطر أول\nسطر ثان", fontSize: 22, fontFamily: 1, strokeColor: "#172554" },
  ] });
  return { path: scene.path };
});

const scriptCases = [
  ["تطبيق خط ثمانية", "أدوات التخطيط/تطبيق خط ثمانية.md", ["sText001"], []],
  ["Set Text Alignment", "أدوات التخطيط/Set Text Alignment.md", ["sText001"], ["right"]],
  ["Set Dimensions", "أدوات التخطيط/Set Dimensions.md", ["s-a"], ["120,180,200,100"]],
  ["Darken background", "أدوات التخطيط/Darken background color.md", ["s-a"], []],
  ["Lighten background", "أدوات التخطيط/Lighten background color.md", ["s-b"], []],
  ["Reverse arrows", "أدوات التخطيط/Reverse arrows.md", ["s-arrow"], []],
  ["Elbow connectors", "أدوات التخطيط/Elbow connectors.md", ["s-arrow"], [false]],
  ["Fixed spacing", "أدوات التخطيط/Fixed spacing.md", ["s-a", "s-b", "s-c"], [60]],
  ["Fixed vertical distance", "أدوات التخطيط/Fixed vertical distance.md", ["s-a", "s-b", "s-c"], [60]],
  ["Uniform size", "أدوات التخطيط/Uniform size.md", ["s-a", "s-b", "s-c"], ["rectangle"]],
  ["Zoom selection", "أدوات التخطيط/Zoom to Fit Selected Elements.md", ["s-a", "s-b"], []],
  ["Box selection", "أدوات التخطيط/Box Selected Elements.md", ["s-a", "s-b", "s-c"], [30]],
  ["Connect elements", "أدوات التخطيط/Connect elements.md", ["s-a", "s-c"], []],
  ["Add next step", "أدوات التخطيط/Add Next Step in Process.md", ["s-b"], ["الخطوة التالية"]],
  ["Split text", "أدوات التخطيط/Split text by lines.md", ["sText001"], []],
  ["Set grid", "أدوات التخطيط/Set Grid.md", [], [20]],
];

for (const [label, script, elementIds, responses] of scriptCases) {
  await test(`script: ${label}`, async () => {
    const value = await rpc("run_script", { script, elementIds, responses }, 40_000);
    assert(value.remainingResponses?.length === 0, `Unused responses: ${JSON.stringify(value.remainingResponses)}`);
    return { script: value.script, consumedResponses: value.consumedResponses, elementCount: value.elementCount };
  });
}

await test("script: Auto Layout", async () => {
  const scene = await rpc("get_scene");
  const ids = scene.elements.filter((element) => ["rectangle", "arrow"].includes(element.type)).map((element) => element.id);
  const value = await rpc("run_script", {
    script: "أدوات التخطيط/Auto Layout.md",
    elementIds: ids,
    responses: ["org.eclipse.elk.layered", "BRANDES_KOEPF", "RIGHT", "10, 100, 100"],
  }, 40_000);
  return { elementCount: value.elementCount, consumedResponses: value.consumedResponses };
});

await test("polish script test output", async () => {
  const scene = await rpc("get_scene");
  const first = scene.elements.find((element) => element.type === "text" && element.text === "سطر أول");
  const second = scene.elements.find((element) => element.type === "text" && element.text === "سطر ثان");
  assert(first && second, "Split-text results are missing");
  await rpc("patch_elements", { patches: [
    { id: first.id, set: { x: 360, y: 30 } },
    { id: second.id, set: { x: 360, y: 70 } },
  ] });
  return { positioned: [first.id, second.id] };
});

await test("list_scripts includes base and professional pack", async () => {
  const value = await rpc("list_scripts", {});
  assert(value.count >= 32, `Expected at least 32 scripts, received ${value.count}`);
  return { count: value.count };
});

await test("final scripts screenshot", async () => {
  await rpc("set_viewport", { scrollToContent: true });
  const shot = await rpc("get_canvas_screenshot", { background: true, scale: 1 });
  await fs.writeFile(path.join(output, "02-اختبار السكربتات.png"), Buffer.from(shot.data, "base64"));
  return { elementCount: shot.elementCount };
});

await test("trash temporary backlinks note", async () => rpc("trash_note", { path: movedNoteB }));

report.finishedAt = new Date().toISOString();
report.total = report.tests.length;
await fs.writeFile(path.join(output, "live-acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.passed, failed: report.failed, skipped: report.skipped, total: report.total, output }, null, 2)}\n`);
process.exitCode = report.failed ? 1 : 0;
