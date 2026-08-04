#!/usr/bin/env node

/**
 * Live acceptance runner for the 15 professional Excalidraw scripts.
 *
 * This runner is intentionally conservative:
 * - It only creates files under `MCP Acceptance Lab/<run-id>/Professional Scripts`.
 * - It never deletes files and never calls export_to_excalidraw_url.
 * - Scripts that need an interactive sidepanel, a presentation window, or external
 *   assets are recorded as skipped with an explicit reason. Discovering a script is
 *   not recorded as a successful execution.
 *
 * Usage:
 *   node tests/professional-live-acceptance.mjs --vault "<vault>" --output "<report-folder>" --run-id "final-001"
 *
 * Add --include-persistent-settings only when it is acceptable for the Shadow Clone
 * script to initialize its own saved Script Engine settings.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BRIDGE_ID = "obsidian-excalidraw-mcp-bridge";
const SCRIPT_FOLDER = "Excalidraw/Scripts";
const PROFESSIONAL_DIR = "الحزمة الاحترافية";
const SAFE_SCRIPT_CASES = [
  {
    id: "change-shape",
    name: "Change shape of selected elements",
    script: `${PROFESSIONAL_DIR}/Change shape of selected elements.md`,
    async prepare(rpc) {
      await rpc("batch_create_elements", {
        elements: [{ id: "shape-target", type: "rectangle", x: 80, y: 80, width: 240, height: 120, backgroundColor: "#dbeafe", fillStyle: "hachure", strokeColor: "#2563eb" }],
      });
    },
    elementIds: ["shape-target"],
    responses: ["ellipse", "solid"],
    async verify(rpc) {
      const scene = await rpc("get_scene");
      const target = active(scene).find((element) => element.id === "shape-target");
      assert(target?.type === "ellipse", "The selected rectangle was not converted to an ellipse.");
      assert(target.fillStyle === "solid", "The selected shape did not receive the requested solid fill.");
      return { elementType: target.type, fillStyle: target.fillStyle };
    },
  },
  {
    id: "organic-line",
    name: "Organic Line",
    script: `${PROFESSIONAL_DIR}/Organic Line.md`,
    async prepare(rpc) {
      await rpc("batch_create_elements", {
        elements: [{ id: "organic-target", type: "line", x: 80, y: 120, points: [[0, 0], [80, -30], [180, 20]], strokeColor: "#0f766e", strokeWidth: 3 }],
      });
    },
    elementIds: ["organic-target"],
    responses: ["l1"],
    async verify(rpc) {
      const scene = await rpc("get_scene");
      const target = active(scene).find((element) => element.id === "organic-target");
      assert(target?.type === "freedraw", "The line was not converted to a freedraw element.");
      assert(target.customData?.strokeOptions?.options?.thinning === 1, "Organic pressure settings were not stored on the element.");
      return { elementType: target.type, thinning: target.customData.strokeOptions.options.thinning };
    },
  },
  {
    id: "text-aura",
    name: "Text Aura",
    script: `${PROFESSIONAL_DIR}/Text Aura.md`,
    async prepare(rpc) {
      await rpc("batch_create_elements", {
        elements: [{ id: "aura0001", type: "text", x: 80, y: 120, text: "اختبار الهالة", fontSize: 32, fontFamily: 4, strokeColor: "#1e3a8a" }],
      });
    },
    elementIds: ["aura0001"],
    responses: [],
    async verify(rpc) {
      const scene = await rpc("get_scene");
      const texts = active(scene).filter((element) => element.type === "text");
      assert(texts.length >= 5, `Expected the original text plus four aura clones, received ${texts.length}.`);
      return { textElementCount: texts.length };
    },
  },
];

const OPTIONAL_SETTINGS_CASE = {
  id: "shadow-clone",
  name: "Set background color of unclosed line object by adding a shadow clone",
  script: `${PROFESSIONAL_DIR}/Set background color of unclosed line object by adding a shadow clone.md`,
  async prepare(rpc) {
    await rpc("batch_create_elements", {
      elements: [{ id: "shadow-target", type: "line", x: 80, y: 100, points: [[0, 0], [100, -30], [200, 35]], strokeColor: "#7c2d12", strokeWidth: 3 }],
    });
  },
  elementIds: ["shadow-target"],
  responses: [],
  async verify(rpc) {
    const scene = await rpc("get_scene");
    const fills = active(scene).filter((element) => element.id !== "shadow-target" && element.strokeColor === "transparent");
    assert(fills.length >= 1, "The script did not create a transparent-stroke background clone.");
    return { cloneCount: fills.length, backgroundColor: fills[0].backgroundColor, fillStyle: fills[0].fillStyle };
  },
};

const COVERAGE = [
  ["Add Link to Existing File and Open.md", "requires-ui", "يطلب اختيار ملف ثم يفتح ورقة Obsidian؛ لا يختبر المشغّل تبديل الأوراق تلقائيًا."],
  ["Change shape of selected elements.md", "testable-automated", "تحويل شكل وتعبئة عنصر مع تحقق من المشهد."],
  ["Comicbook Callout Editor.md", "requires-ui", "واجهة جانبية تفاعلية ومعاينة حيّة؛ تحتاج فحصًا بصريًا يدويًا."],
  ["Create new markdown file and embed into active drawing.md", "requires-ui", "ينشئ ملفًا ويفتحه في ورقة أخرى؛ يترك للمستخدم اختبار تدفق الأوراق."],
  ["ExcaliMath.md", "external-dependency", "يتطلب Excalidraw Extras/MathJax وواجهة جانبية؛ التحقق من إدخال الصيغ بصريًا."],
  ["Icon Library.md", "requires-ui", "واجهة جانبية تعتمد على محتوى أيقونات المستخدم والبحث التفاعلي."],
  ["Image Occlusion.md", "requires-ui", "يتطلب صورة وأقنعة وحوارًا؛ يتضمن خيار حذف مادي لذلك لا يشغّله القبول الآلي."],
  ["Mindmap Builder.js.md", "requires-ui", "واجهة جانبية واختصارات لوحة مفاتيح وتخطيط تفاعلي."],
  ["Organic Line.md", "testable-automated", "تحويل خط إلى freedraw مع تحقق من بيانات الضغط."],
  ["Palette loader.md", "external-dependency", "يعتمد على مجلد لوحات المستخدم ويعدّل إعدادات اللوحات المحفوظة."],
  ["Printable Layout Wizard.md", "requires-ui", "معالج نافذة وطباعة/تصدير PDF يحتاج قرار المستخدم ومراجعة الناتج."],
  ["Set background color of unclosed line object by adding a shadow clone.md", "testable-automated", "اختبار اختياري فقط لأنه قد يهيئ إعدادات السكربت المحفوظة لأول مرة."],
  ["Shade Master.md", "requires-ui", "واجهة جانبية وتعيين ألوان تفاعلي، وقد يتعامل مع رسومات مضمّنة."],
  ["Slideshow.md", "requires-ui", "يفتح وضع عرض ويتعامل مع دورة حياة النافذة/لوحة المفاتيح."],
  ["Text Aura.md", "testable-automated", "ينشئ أربع نسخ هالة لنص محدد؛ القراءة من الحافظة فقط."],
].map(([file, category, reason]) => ({ file, script: `${PROFESSIONAL_DIR}/${file}`, category, reason, status: "not-run" }));

function argumentsMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function active(scene) {
  return (scene.elements || []).filter((element) => !element.isDeleted);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRunId(value) {
  const normalized = String(value || "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") throw new Error("--run-id must contain a safe, non-empty name.");
  return normalized.slice(0, 96);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const args = argumentsMap(process.argv.slice(2));
if (!args.vault || !args.output || !args["run-id"]) {
  process.stderr.write("Usage: node tests/professional-live-acceptance.mjs --vault <path> --output <folder> --run-id <safe-name> [--include-persistent-settings]\n");
  process.exit(2);
}

const vault = path.resolve(args.vault);
const output = path.resolve(args.output);
const runId = safeRunId(args["run-id"]);
const sandboxRoot = `MCP Acceptance Lab/${runId}/Professional Scripts`;
const sandboxOnDisk = path.join(vault, ...sandboxRoot.split("/"));
const report = {
  startedAt: new Date().toISOString(),
  runId,
  vault,
  sandboxRoot,
  bridge: null,
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
  scriptCoverage: COVERAGE,
  safety: {
    deletesFiles: false,
    callsExcalidrawUrlExport: false,
    persistentSettingsScriptsIncluded: args["include-persistent-settings"] === true,
  },
};

await fs.mkdir(output, { recursive: true });

try {
  await fs.access(sandboxOnDisk);
  throw new Error(`The isolated run folder already exists: ${sandboxRoot}. Choose a new --run-id; this runner never overwrites a previous run.`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

let settings;
try {
  settings = JSON.parse(await fs.readFile(path.join(vault, ".obsidian", "plugins", BRIDGE_ID, "data.json"), "utf8"));
} catch (error) {
  report.failed += 1;
  report.tests.push({ name: "read bridge settings", status: "failed", durationMs: 0, error: error.message });
}

const endpoint = settings ? `http://127.0.0.1:${settings.port}/rpc` : null;

async function rpc(method, params = {}, timeout = 45_000) {
  if (!endpoint) throw new Error("Bridge settings are unavailable.");
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

async function test(name, action) {
  const started = Date.now();
  try {
    const evidence = await action();
    const status = evidence?.skipped ? "skipped" : "passed";
    report[status] += 1;
    report.tests.push({ name, status, durationMs: Date.now() - started, evidence });
    return evidence;
  } catch (error) {
    report.failed += 1;
    report.tests.push({ name, status: "failed", durationMs: Date.now() - started, error: error.message, details: error.details });
    return null;
  }
}

function coverageFor(script) {
  const entry = report.scriptCoverage.find((item) => item.script === script);
  if (!entry) throw new Error(`Coverage entry missing for ${script}`);
  return entry;
}

async function captureScreenshot(name) {
  const shot = await rpc("get_canvas_screenshot", { background: true, scale: 1 });
  assert(shot?.data, "The bridge did not return screenshot data.");
  const filename = `${name}.png`;
  await fs.writeFile(path.join(output, filename), Buffer.from(shot.data, "base64"));
  return { file: filename, elementCount: shot.elementCount };
}

async function prepareDrawing(id, prepare) {
  const filename = `professional-${id}`;
  await rpc("create_drawing", { filename, foldername: sandboxRoot, open: true, plaintext: `Professional script acceptance run: ${runId}` });
  await sleep(500);
  const scene = await rpc("get_scene");
  assert(scene.path === `${sandboxRoot}/${filename}.excalidraw.md`, `The active drawing is not the isolated ${id} drawing.`);
  await prepare(rpc);
  return scene.path;
}

async function runAutomatedCase(scriptCase) {
  const coverage = coverageFor(scriptCase.script);
  const preparedPath = await prepareDrawing(scriptCase.id, scriptCase.prepare);
  const execution = await rpc("run_script", {
    script: scriptCase.script,
    elementIds: scriptCase.elementIds,
    responses: scriptCase.responses,
  }, 60_000);
  assert(execution.remainingResponses?.length === 0, `Unused automated responses: ${JSON.stringify(execution.remainingResponses)}`);
  const verification = await scriptCase.verify(rpc);
  const screenshot = await captureScreenshot(scriptCase.id);
  coverage.status = "executed-and-verified";
  coverage.evidence = { preparedPath, consumedResponses: execution.consumedResponses, verification, screenshot };
  return coverage.evidence;
}

const bridgeStatus = await test("bridge status for professional scripts", async () => {
  const value = await rpc("status");
  assert(value.bridgeVersion === "0.6.0", `Expected bridge 0.6.0, received ${value.bridgeVersion || "unknown"}.`);
  assert(value.excalidrawExtras?.installed && value.excalidrawExtras?.enabled, "Excalidraw Extras must be installed and enabled for the professional package.");
  report.bridge = value;
  return { bridgeVersion: value.bridgeVersion, extras: value.excalidrawExtras };
});

if (bridgeStatus) {
  await test("professional script inventory", async () => {
    const inventory = await rpc("list_scripts");
    const present = new Set(inventory.scripts.map((script) => script.relativePath));
    const missing = report.scriptCoverage.filter((item) => !present.has(item.script)).map((item) => item.script);
    assert(missing.length === 0, `Professional scripts missing: ${missing.join(", ")}`);
    return { expected: report.scriptCoverage.length, listed: inventory.count, missing };
  });

  for (const scriptCase of SAFE_SCRIPT_CASES) {
    const evidence = await test(`script execution: ${scriptCase.name}`, () => runAutomatedCase(scriptCase));
    if (!evidence && coverageFor(scriptCase.script).status === "not-run") {
      coverageFor(scriptCase.script).status = "failed-automated";
    }
  }

  if (args["include-persistent-settings"] === true) {
    const evidence = await test(`script execution: ${OPTIONAL_SETTINGS_CASE.name}`, () => runAutomatedCase(OPTIONAL_SETTINGS_CASE));
    if (!evidence && coverageFor(OPTIONAL_SETTINGS_CASE.script).status === "not-run") {
      coverageFor(OPTIONAL_SETTINGS_CASE.script).status = "failed-automated";
    }
  } else {
    const entry = coverageFor(OPTIONAL_SETTINGS_CASE.script);
    entry.status = "skipped-persistent-settings";
    await test(`script execution: ${OPTIONAL_SETTINGS_CASE.name}`, async () => ({
      skipped: true,
      reason: "Run again with --include-persistent-settings to permit initialization of this script's saved settings.",
    }));
  }

  for (const entry of report.scriptCoverage.filter((item) => item.status === "not-run")) {
    entry.status = `skipped-${entry.category}`;
    await test(`script not run: ${entry.file}`, async () => ({ skipped: true, category: entry.category, reason: entry.reason }));
  }
} else {
  for (const entry of report.scriptCoverage) entry.status = "not-run-bridge-unavailable";
}

report.finishedAt = new Date().toISOString();
report.total = report.tests.length;
report.coverageSummary = report.scriptCoverage.reduce((summary, entry) => {
  summary[entry.status] = (summary[entry.status] || 0) + 1;
  return summary;
}, {});
await fs.writeFile(path.join(output, "professional-live-acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.passed, failed: report.failed, skipped: report.skipped, total: report.total, output, sandboxRoot, coverageSummary: report.coverageSummary }, null, 2)}\n`);
process.exitCode = report.failed ? 1 : 0;
