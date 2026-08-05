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

test("a timed-out response does not release the operation queue early", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const declarations = `
    const OPERATION_TIMEOUT_MS = 30_000;
    class BridgeError extends Error {
      constructor(message, code) { super(message); this.code = code; }
    }
  `;
  const { build } = extractMethod(source, "enqueue", "  readBody(request)", { declarations });
  let releaseFirst;
  let secondStarted = false;
  const bridge = build({ operationQueue: Promise.resolve(), operationTimeoutMs: 10 });

  const first = bridge.enqueue(() => new Promise((resolve) => { releaseFirst = resolve; }));
  await assert.rejects(first, (error) => error.code === "OPERATION_TIMEOUT");

  const second = bridge.enqueue(async () => {
    secondStarted = true;
    return "second";
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(secondStarted, false, "العملية التالية يجب أن تنتظر العمل الحقيقي لا رد المهلة");

  releaseFirst("first");
  assert.equal(await second, "second");
});

test("identical Mermaid retries reuse the first result unless duplication is explicit", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const declarations = `
    const MERMAID_REPLAY_WINDOW_MS = 10 * 60_000;
    class BridgeError extends Error {
      constructor(message, code) { super(message); this.code = code; }
    }
  `;
  const { build } = extractMethod(source, "createFromMermaid", "  async addImage", { declarations });
  let conversions = 0;
  const ea = {
    addMermaid: async () => {
      conversions += 1;
      return [`shape-${conversions}`];
    },
    addElementsToView: async () => {},
  };
  const bridge = build({
    getActiveContext: () => ({ ea, view: { file: { path: "test.excalidraw.md" } } }),
    requireExcalidrawExtras: () => {},
    prepareWorkbenchForAppend: () => {},
    mermaidRequestKey: () => "same-request",
    mermaidRequests: new Map(),
  });

  const first = await bridge.createFromMermaid({ mermaidDiagram: "flowchart TD\nA-->B" });
  const retry = await bridge.createFromMermaid({ mermaidDiagram: "flowchart TD\nA-->B" });
  assert.equal(conversions, 1, "إعادة الطلب المطابق لا تنشئ نسخة ثانية");
  assert.equal(first.reused, false);
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.ids, first.ids);

  const duplicate = await bridge.createFromMermaid({
    mermaidDiagram: "flowchart TD\nA-->B",
    forceDuplicate: true,
  });
  assert.equal(conversions, 2, "التكرار المقصود يبقى متاحًا بخيار صريح");
  assert.equal(duplicate.reused, false);
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
  assert.match(style, /strokeStyle: "solid"/);
  assert.match(style, /opacity: 100/);
  assert.match(inspector, /type: "containment", severity: "info"/);
  assert.match(inspector, /warnings = issues\.filter/);
});

/**
 * الجسر إضافة Obsidian: `require("obsidian")` لا يوجد في الاختبار، فلا يمكن
 * استيراده. لكن الفحص النصي وحده لا يكفي — يمرّ على تحويلات تكسر السلوك. فتُستخرج
 * الدالة وتُنفَّذ فعلًا مقابل بيئة Obsidian مُقلَّدة. سلوك حقيقي، بلا استيراد.
 */
function extractMethod(source, name, endMarker, { declarations = "", fixtures = "{}" } = {}) {
  const plain = source.indexOf(`  ${name}(`);
  const asAsync = source.indexOf(`  async ${name}(`);
  const start = asAsync !== -1 && (plain === -1 || asAsync < plain) ? asAsync : plain;
  assert.notEqual(start, -1, `تعذّر تحديد بداية ${name}`);
  const body = source.slice(start, source.indexOf(endMarker));
  assert.ok(body.includes(`${name}(`), `تعذّر استخراج ${name}`);
  // السقالة والدالة في نطاق واحد، وإلا فشل `instanceof` على أصناف مختلفة بلا معنى.
  return new Function(`
    ${declarations}
    return { fixtures: ${fixtures}, build: (deps) => ({ ...deps, ${body.trim()} }) };
  `)();
}

// الخط يملكه المستخدم لا المستودع، وكل رقم ثابت يخسر حالة. و`ea.style` تُنشأ في
// Excalidraw بـ`fontFamily: 1` مثبَّتًا في الكود — تحقّقنا من ذلك في مصدر 2.25.3 —
// فالهدف يُحسب من أوثق مصدر متاح لا من أول قيمة نراها.
test("font family resolves from the authoritative source while size never leaks", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const { build } = extractMethod(source, "defaultFontFamily", "  applyStyle(ea, params)");
  const applyStyleBody = source.slice(source.indexOf("  applyStyle(ea, params)"), source.indexOf("  copyBindingTargetsToWorkbench"));

  const makeBridge = (deps) => {
    const bridge = build(deps);
    // ‏applyStyle تُستدعى على نفس الكائن حتى تعمل this.defaultFontFamily.
    bridge.applyStyle = new Function("return function " + applyStyleBody.trim().replace(/^applyStyle/, "applyStyle"))();
    return bridge;
  };
  const freshStyle = (fontFamily) => ({
    style: {
      strokeColor: "#000", backgroundColor: "transparent", fillStyle: "solid",
      strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
      fontSize: 20, fontFamily, textAlign: "left", verticalAlign: "top",
      roundness: null, startArrowHead: null, endArrowHead: "arrow",
    },
  });
  const withFont = { arabicFontFamily: 4, families: [] };
  const withoutFont = { arabicFontFamily: null, families: [] };

  // قبل الطبقات كلها: العائلات 1-3 لا تحمل محارف عربية، فنصٌّ عربي بها غير مقروء.
  // قيس هذا حيًّا: `currentItemFontFamily` في خزنة حقيقية كان 1 لأن صاحبها يطبّق خطه
  // بسكربت بعد الكتابة، فاتباع الواجهة وحدها كان يُخرج كل نص عربي مفكّكًا.
  const arabicAware = makeBridge({ baselineFontFamily: undefined, getFontStatus: () => withFont });
  const eaArabic = freshStyle(1);
  eaArabic.targetView = { excalidrawAPI: { getAppState: () => ({ currentItemFontFamily: 1 }) } };
  arabicAware.applyStyle(eaArabic, { text: "نص عربي" });
  assert.equal(eaArabic.style.fontFamily, 4, "نص عربي بلا تمرير يأخذ العائلة العربية");
  arabicAware.applyStyle(eaArabic, { text: "Latin only" });
  assert.equal(eaArabic.style.fontFamily, 1, "اللاتيني لا تُفرض عليه العائلة العربية");
  arabicAware.applyStyle(eaArabic, { text: "نص عربي", fontFamily: 2 });
  assert.equal(eaArabic.style.fontFamily, 2, "التمرير الصريح يفوز على العربية أيضًا");
  // وخزنة بلا خط عربي: لا يُفرض 4 على نص عربي لأن العائلة غير موجودة.
  const noArabicFont = makeBridge({ baselineFontFamily: undefined, getFontStatus: () => withoutFont });
  const eaBare = freshStyle(1);
  noArabicFont.applyStyle(eaBare, { text: "نص عربي" });
  assert.equal(eaBare.style.fontFamily, 1, "بلا خط عربي مثبَّت لا يُفرض 4");

  // الطبقة 1: اختيار المستخدم في الواجهة يفوز على كل ما بعده.
  const uiPicked = makeBridge({
    baselineFontFamily: undefined,
    getFontStatus: () => withFont,
  });
  const ea1 = freshStyle(1);
  ea1.targetView = { excalidrawAPI: { getAppState: () => ({ currentItemFontFamily: 2 }) } };
  uiPicked.applyStyle(ea1, { fontSize: 72, fontFamily: 3, strokeStyle: "dashed" });
  assert.equal(ea1.style.fontFamily, 3, "التمرير الصريح يعمل");
  assert.equal(ea1.style.fontSize, 72);
  uiPicked.applyStyle(ea1, {});
  assert.equal(ea1.style.fontFamily, 2, "يعود إلى اختيار الواجهة لا إلى 3 ولا إلى 1");
  assert.equal(ea1.style.fontSize, 20, "مقاس عنصر لا يسري على ما بعده");
  assert.equal(ea1.style.strokeStyle, "solid");

  // الطبقة 2: بلا واجهة، خزنة خطها مفعَّل ⇒ 4 وليس 1 المثبَّت في ea.style.
  const settingsOnly = makeBridge({ baselineFontFamily: undefined, getFontStatus: () => withFont });
  const ea2 = freshStyle(1);
  settingsOnly.applyStyle(ea2, { fontFamily: 3 });
  settingsOnly.applyStyle(ea2, {});
  assert.equal(ea2.style.fontFamily, 4, "خط الخزنة المفعَّل هو الافتراضي، لا 1");

  // خزنة بلا خط: تبقى على 1 ولا تُدفع إلى 4 — الخطأ المقابل.
  const bare = makeBridge({ baselineFontFamily: undefined, getFontStatus: () => withoutFont });
  const ea3 = freshStyle(1);
  bare.applyStyle(ea3, { fontFamily: 3 });
  bare.applyStyle(ea3, {});
  assert.equal(ea3.style.fontFamily, 1, "بلا خط تبقى 1، ولا تُفرض 4");

  // الطبقة 3: كل المصادر تفشل ⇒ أول قيمة رأيناها، ولا رمي.
  const blind = makeBridge({
    baselineFontFamily: undefined,
    getFontStatus: () => { throw new Error("EXCALIDRAW_NOT_LOADED"); },
  });
  const ea4 = freshStyle(4);
  blind.applyStyle(ea4, { fontFamily: 3 });
  blind.applyStyle(ea4, {});
  assert.equal(ea4.style.fontFamily, 4, "تعود إلى القيمة الأساسية الملتقطة");
});

// «استخدم fontFamily: 4 عندما يكون الخط مفعّلًا» كان شرطًا لا يستطيع الوكيل
// التحقّق منه: لا أداة تُبلّغ عنه. فيخمّن — وأي تخمين يخسر إحدى الحالتين.
test("status reports the real Arabic font state so agents never guess", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const status = source.slice(source.indexOf("  status() {"), source.indexOf("  getFontStatus() {"));
  assert.match(status, /fonts: this\.getFontStatus\(\)/, "status يجب أن يُصدر حالة الخط");

  const FONT = "Excalidraw/Custom Fonts/user-owned.woff2";
  // TFile مُقلَّد: `getAbstractFileByPath` يعيد المجلدات أيضًا، والمجلد ليس خطًا.
  const { fixtures, build } = extractMethod(source, "getFontStatus", "  listDrawings(params) {", {
    declarations: "class TFile {}\nclass TFolder {}",
    fixtures: "{ file: new TFile(), folder: new TFolder() }",
  });
  const read = (settings, tree = {}) =>
    build({
      getExcalidrawPlugin: () => {
        if (!settings) throw new Error("EXCALIDRAW_NOT_LOADED");
        return { settings };
      },
      app: { vault: { getAbstractFileByPath: (p) => tree[p] ?? null } },
    }).getFontStatus();

  // 1) خط مثبَّت ومفعَّل → 4، وهي الحالة الوحيدة التي تُرجع رقمًا.
  const ready = read(
    { experimentalEnableFourthFont: true, experimantalFourthFont: FONT },
    { [FONT]: fixtures.file },
  );
  assert.equal(ready.arabicFontFamily, 4);
  assert.equal(ready.families.length, 4);

  // 2) مفعَّل والملف مفقود → null. هذه أخطر رجعة ممكنة: 4 على خزنة لا تعرضه.
  assert.equal(read({ experimentalEnableFourthFont: true, experimantalFourthFont: FONT }).arabicFontFamily, null);

  // 3) الملف موجود والخيار مطفأ → null، مع التمييز عن «غير مثبَّت».
  const off = read({ experimentalEnableFourthFont: false, experimantalFourthFont: FONT }, { [FONT]: fixtures.file });
  assert.equal(off.arabicFontFamily, null);
  assert.equal(off.families.at(-1).fileFound, true, "يجب أن يميّز «مطفأ» من «غير مثبَّت»");
  assert.equal(off.families.at(-1).enabled, false);
  assert.match(off.guidance, /مطفأ/, "الإرشاد يجب أن يفرّق «مطفأ» من «غير مثبَّت»");

  // 4) لا إعدادات إطلاقًا → null بلا رمي.
  assert.equal(read({}).arabicFontFamily, null);

  // 5) مجلد بمسار الخط ليس خطًا.
  assert.equal(
    read(
      { experimentalEnableFourthFont: true, experimantalFourthFont: "Excalidraw/Scripts" },
      { "Excalidraw/Scripts": fixtures.folder },
    ).arabicFontFamily,
    null,
    "مجلد لا يجوز أن يُعدّ خطًا مثبَّتًا",
  );

  // 6) القيمة الافتراضية في Excalidraw هي الاسم المجرّد "Virgil" لا مسار ملف.
  // قراءتها «مسجَّل وملفه مفقود» إنذار كاذب يصيب كل خزنة لم يُضف إليها خط.
  const fallbackName = read(
    { experimentalEnableFourthFont: true, experimantalFourthFont: "Virgil" },
    { Virgil: fixtures.file },
  );
  assert.equal(fallbackName.arabicFontFamily, null);
  assert.equal(fallbackName.families.at(-1).vaultPath, null, "الاسم المجرّد يُعدّ «غير مسجَّل»");
  assert.doesNotMatch(fallbackName.guidance, /مفقود/, "لا إنذار «ملف مفقود» على الحالة الافتراضية");
  assert.match(fallbackName.guidance, /لا خط عربي مثبَّت/);

  // 7) مسارات خارج الخزنة لا تُعدّ جاهزة.
  for (const bad of ["../../../etc/passwd", "/abs/f.ttf", "C:\\fonts\\f.ttf", "fonts\\f.ttf"]) {
    const result = read({ experimentalEnableFourthFont: true, experimantalFourthFont: bad }, { [bad]: fixtures.file });
    assert.equal(result.arabicFontFamily, null, `مسار خارج الخزنة يجب ألا يكون جاهزًا: ${bad}`);
  }

  // 8) إعدادات معطوبة: لا يسقط `status`، ولا يكذب بأن «لا خط مثبَّت».
  const broken = build({
    getExcalidrawPlugin: () => ({ get settings() { throw new Error("corrupt"); } }),
    app: { vault: { getAbstractFileByPath: () => null } },
  }).getFontStatus();
  assert.equal(broken.arabicFontFamily, null);
  assert.equal(broken.families.at(-1).unreadable, true);
  assert.match(broken.guidance, /مجهولة/, "الحالة المجهولة لا تُعرَض كأنها «لا خط»");

  // 9) إملاء المفتاح upstream فيه خطأ مطبعي أصلي؛ أي «تصحيح» يكسر القراءة صامتًا.
  const fonts = source.slice(source.indexOf("  getFontStatus() {"), source.indexOf("  listDrawings(params) {"));
  assert.match(fonts, /experimantalFourthFont/);

  const serverSource = await fs.readFile(path.join(root, "server.mjs"), "utf8");
  assert.match(serverSource, /fonts\.arabicFontFamily/, "وصف الأداة يجب أن يذكر الحقل");
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

// كلها أعطال أثبتها فحص خصومي بالتنفيذ على الفرع نفسه، لا مراجعة نظر.
test("vault paths cannot escape with an interior traversal segment", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const body = source.slice(source.indexOf("function safePath"), source.indexOf("function randomId"));
  // ‏normalizePath في Obsidian يوحّد الشرطات ولا يحلّ `..` — نقلّده كما هو.
  const safePath = new Function("normalizePath", "BridgeError", `${body}; return safePath;`)(
    (p) => p.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/"),
    class extends Error { constructor(message, code) { super(message); this.code = code; } },
  );

  // فحص البداية وحده كان يسمح بهذه: `..` في الوسط يخرج من الخزنة فعلًا.
  for (const escape of [
    "Notes/../../../Desktop/pwned.md", "a/../../b", "out/../../../etc/x",
    "../x", "..", "/etc/passwd", "C:/Windows/x", "out\\..\\..\\x",
  ]) {
    assert.throws(() => safePath(escape, "path"), /INVALID_ARGUMENT|Vault/, `يجب رفض ${escape}`);
  }
  for (const good of ["ok/inner.md", "دليل التثبيت/ملف.md", "a/b/c.excalidraw.md", "one.md"]) {
    assert.doesNotThrow(() => safePath(good, "path"), `يجب قبول ${good}`);
  }
  // ‏`..` كجزء من اسم مشروع لا كمقطع كامل ليس هروبًا.
  assert.doesNotThrow(() => safePath("notes/a..b.md", "path"));
});

test("create paths retarget label bindings and refuse deleted anchors", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const addElement = source.slice(source.indexOf("async addElementToWorkbench"), source.indexOf("async createElement"));
  // مسارا الإنشاء والتعديل يجب أن يتصرّفا تصرّفًا واحدًا على المدخل نفسه.
  assert.match(addElement, /this\.redirectLabelBindings\(ea, params\)/);

  const { build } = extractMethod(source, "redirectLabelBindings", "  async addElementToWorkbench");
  const view = [
    { id: "boxAAAAA", type: "rectangle" },
    { id: "lblAAAAA", type: "text", containerId: "boxAAAAA" },
    { id: "freeAAAA", type: "text" },
    { id: "goneAAAA", type: "text", containerId: "missing1" },
  ];
  const bridge = build({});
  const ea = { getViewElements: () => view, getElements: () => [] };

  const bound = bridge.redirectLabelBindings(ea, { startElementId: "lblAAAAA", endElementId: "boxAAAAA" });
  assert.equal(bound.startElementId, "boxAAAAA", "نص داخل حاوية يُعاد توجيهه إلى الحاوية");
  assert.equal(bound.endElementId, "boxAAAAA");
  const free = bridge.redirectLabelBindings(ea, { startElementId: "freeAAAA" });
  assert.equal(free.startElementId, "freeAAAA", "نص حر يبقى هدفًا مشروعًا");
  const orphan = bridge.redirectLabelBindings(ea, { startElementId: "goneAAAA" });
  assert.equal(orphan.startElementId, "goneAAAA", "حاوية مفقودة: لا يُعاد التوجيه إلى العدم");

  const copyBinding = source.slice(source.indexOf("  copyBindingTargetsToWorkbench(ea, params)"), source.indexOf("  redirectLabelBindings"));
  assert.match(copyBinding, /const live = \(element\) => element && !element\.isDeleted/);
  assert.match(copyBinding, /getElements\(\)\.filter\(live\)/);
  assert.match(copyBinding, /getViewElements\(\)\.filter\(live\)/);
});

test("batch aliases fail loudly instead of leaking or shadowing", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const declarations =
    source.slice(source.indexOf("class BridgeError"), source.indexOf("function safePath")) +
    "\nlet nextId = 0; const makeId = () => `gen${String(++nextId).padStart(5, \"0\")}`;";
  const { build } = extractMethod(source, "batchCreateElements", "  async updateElement", { declarations });

  // مشهد قائم فيه عنصر معرّفه `boxAAAAA`، وإطار قائم `frmAAAAA`.
  const scene = [{ id: "boxAAAAA", type: "rectangle" }, { id: "frmAAAAA", type: "frame" }];
  const run = (elements) => {
    const seen = [];
    const workbench = [];
    const ea = {
      getViewElements: () => scene,
      getElements: () => workbench,
      addElementsToView: async () => {},
    };
    const bridge = build({
      getActiveContext: () => ({ ea }),
      prepareWorkbenchForAppend: () => {},
      addElementToWorkbench: async (_ea, prepared) => {
        seen.push(prepared);
        const id = `gen${String(seen.length).padStart(5, "0")}`;
        workbench.push({ id, type: prepared.type });
        return id;
      },
      getScene: () => ({ elements: workbench }),
    });
    return { promise: bridge.batchCreateElements({ elements }), seen };
  };
  const rejects = async (elements, code) => {
    await assert.rejects(run(elements).promise, (error) => error.code === code, `توقّعنا ${code}`);
  };

  // اسم مستعار يطابق معرّفًا قائمًا كان يحجبه بصمت: سهم يقصد العنصر القائم يرتبط بالجديد.
  await rejects([{ type: "rectangle", id: "boxAAAAA" }], "ALIAS_SHADOWS_ELEMENT");
  // عنصر ليس كائنًا كان يُنتج TypeError خامًا لا خطأ جسر.
  await rejects([null], "INVALID_ARGUMENT");
  await rejects([{ type: "rectangle" }, "nope"], "INVALID_ARGUMENT");
  await rejects([[]], "INVALID_ARGUMENT");
  // ‏frameId مجهول كان يُكتب خامًا فيصير مرجع إطار معلّقًا لا يرصده شيء.
  await rejects([{ type: "rectangle", frameId: "ghostFrame" }], "ELEMENT_NOT_FOUND");
  // الاسم المكرر داخل الدفعة يُرفض قبل إنشاء أي عنصر.
  await rejects([{ type: "rectangle", id: "aa" }, { type: "ellipse", id: "aa" }], "DUPLICATE_ELEMENT_ALIAS");

  // ما يجب أن ينجح: إطار الدفعة، وإطار قائم، والترتيب، وحفظ ترتيب المتصل.
  const okBatch = run([
    { type: "arrow", startElementId: "one", endElementId: "two" },
    { type: "rectangle", id: "one" },
    { type: "rectangle", id: "two", frameId: "myFrame" },
    { type: "frame", id: "myFrame" },
    { type: "ellipse", frameId: "frmAAAAA" },
  ]);
  const result = await okBatch.promise;
  const order = okBatch.seen.map((element) => element.type);
  assert.deepEqual(order, ["frame", "rectangle", "rectangle", "ellipse", "arrow"], "إطار ثم أشكال ثم أسهم");
  const arrow = okBatch.seen.at(-1);
  assert.equal(arrow.startElementId, result.ids[1], "السهم يرتبط بالمعرّف المولَّد لا بالاسم");
  assert.equal(arrow.endElementId, result.ids[2]);
  assert.equal(okBatch.seen[2].frameId, result.ids[3], "frameId من الدفعة يُحلّ");
  assert.equal(okBatch.seen[3].frameId, "frmAAAAA", "إطار قائم في المشهد يُقبل كما هو");
  assert.equal(result.ids.length, 5);
  assert.ok(okBatch.seen.every((element) => element.id === undefined), "لا اسم مستعار يصل إلى الإنشاء");
  assert.deepEqual(
    result.idMappings.map((mapping) => mapping.requestedId),
    ["one", "two", "myFrame"],
    "الخريطة بترتيب المتصل",
  );
});

test("malformed geometry is reported, not turned into a phantom overlap", async () => {
  const source = await fs.readFile(bridgePath, "utf8");
  const inspector = source.slice(source.indexOf("inspectVisualQuality"), source.indexOf("async getCanvasScreenshot"));
  assert.match(inspector, /Number\.isFinite\(value\)/);
  assert.match(inspector, /type: "invalid_geometry"/);
  assert.match(inspector, /إحداثيات أو أبعاد غير عددية/);
  assert.match(inspector, /&& measurable\(element\)/, "العنصر المشوّه يخرج من حلقة التداخل");
});
