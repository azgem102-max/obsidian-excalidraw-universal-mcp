#!/usr/bin/env node

import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SERVER_NAME = "excalidraw-universal-mcp";
const SERVER_VERSION = "0.6.0";
const PLUGIN_ID = "obsidian-excalidraw-mcp-bridge";
const DEFAULT_PORT = 27125;

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const equal = argument.indexOf("=");
    if (equal === -1) result[argument.slice(2)] = true;
    else result[argument.slice(2, equal)] = argument.slice(equal + 1);
  }
  return result;
}

const cli = parseArguments(process.argv.slice(2));
const vaultInput = cli.vault || process.env.OBSIDIAN_VAULT_PATH || "";

if (!cli["self-test"] && !vaultInput) {
  process.stderr.write(
    "OBSIDIAN_VAULT_PATH or --vault=<path> is required for excalidraw-universal-mcp\n",
  );
  process.exit(2);
}

const vaultPath = vaultInput ? path.resolve(vaultInput) : "";
const pluginDataPath = vaultPath
  ? path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID, "data.json")
  : "";

async function readBridgeSettings() {
  let raw;
  try {
    raw = await fs.readFile(pluginDataPath, "utf8");
  } catch (error) {
    throw new Error(
      `تعذر قراءة إعدادات جسر Obsidian. ثبّت الإضافة وأعد تشغيل Obsidian. (${error.message})`,
    );
  }
  const settings = JSON.parse(raw);
  if (typeof settings.token !== "string" || settings.token.length < 32) {
    throw new Error("رمز جسر Obsidian غير موجود؛ أعد تشغيل Obsidian مرة واحدة");
  }
  return {
    token: settings.token,
    port: Number.isInteger(settings.port) ? settings.port : DEFAULT_PORT,
  };
}

async function bridgeCall(method, params = {}) {
  const settings = await readBridgeSettings();
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${settings.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      // 45s يترك للجسر فرصة إعادة خطأ مهلة مفهوم عندما تكون الواجهة قادرة على
      // تشغيل المؤقت. تحويل Mermaid المتزامن قد يحجب خيط الواجهة؛ الجسر يحمي
      // الطابور ويمنع تكرار الطلب المطابق حتى لو انتهت مهلة النقل هنا.
      signal: AbortSignal.timeout(Number(process.env.EXCALIDRAW_RPC_TIMEOUT_MS) || 45_000),
    });
  } catch (error) {
    throw new Error(
      `تعذر الاتصال بإضافة Excalidraw داخل Obsidian. تأكد أن Obsidian مفتوح وأن الجسر مفعّل. (${error.message})`,
    );
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const code = body?.error?.code ? `[${body.error.code}] ` : "";
    const details = body?.error?.details ? `\n${JSON.stringify(body.error.details, null, 2)}` : "";
    throw new Error(`${code}${body?.error?.message || `HTTP ${response.status}`}${details}`);
  }
  return body.result;
}

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const stringArray = { type: "array", items: { type: "string" } };
const openObject = { type: "object", additionalProperties: true };
const elementTypes = [
  "rectangle",
  "ellipse",
  "diamond",
  "blob",
  "text",
  "line",
  "arrow",
  "freedraw",
  "frame",
  "embeddable",
];
const elementProperties = {
  id: { type: "string", description: "اسم مستعار اختياري؛ يعيد الجسر المعرّف الأصلي في resolvedId أو idMappings" },
  type: { type: "string", enum: elementTypes },
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" },
  points: {
    type: "array",
    items: {
      oneOf: [
        { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        objectSchema({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
      ],
    },
  },
  text: { type: "string", description: "نص العنصر أو عنوان الشكل" },
  backgroundColor: { type: "string" },
  strokeColor: { type: "string" },
  strokeWidth: { type: "number" },
  strokeStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
  fillStyle: { type: "string", enum: ["hachure", "cross-hatch", "solid"] },
  roughness: { type: "number" },
  opacity: { type: "number" },
  angle: { type: "number" },
  fontSize: { type: "number" },
  fontFamily: { oneOf: [{ type: "string" }, { type: "number" }] },
  textAlign: { type: "string", enum: ["left", "center", "right"] },
  verticalAlign: { type: "string", enum: ["top", "middle", "bottom"] },
  startElementId: { type: "string" },
  endElementId: { type: "string" },
  startArrowhead: { type: ["string", "null"] },
  endArrowhead: { type: ["string", "null"] },
  roundness: openObject,
  elbowed: { type: "boolean" },
  groupIds: stringArray,
  frameId: { type: ["string", "null"] },
  locked: { type: "boolean" },
  link: { type: ["string", "null"] },
  customData: openObject,
  pressures: { type: "array", items: { type: "number" } },
  simulatePressure: { type: "boolean" },
  variability: { type: "string", enum: ["variable", "constant"] },
  streamline: { type: "number" },
};
const elementSchema = objectSchema(elementProperties, ["type", "x", "y"]);

const tools = [
  {
    name: "create_element",
    description:
      "أنشئ عنصر Excalidraw في الرسم المفتوح داخل Obsidian. نفس تنسيق أداة Excalidraw الأصلية، مع دعم النصوص والربط.",
    inputSchema: elementSchema,
  },
  {
    name: "get_element",
    description: "اقرأ عنصرًا واحدًا من الرسم النشط بالمعرّف.",
    inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "update_element",
    description: "عدّل خصائص عنصر موجود مع إبقاء خصائصه الأخرى.",
    inputSchema: objectSchema(elementProperties, ["id"]),
  },
  {
    name: "delete_element",
    description: "احذف عنصرًا واحدًا من الرسم النشط.",
    inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "query_elements",
    description: "ابحث عن عناصر الرسم حسب النوع أو الخصائص المتداخلة أو النطاق المكاني.",
    inputSchema: objectSchema({
      type: { type: "string" },
      filter: openObject,
      bbox: objectSchema({
        x_min: { type: "number" },
        x_max: { type: "number" },
        y_min: { type: "number" },
        y_max: { type: "number" },
      }),
    }),
  },
  {
    name: "batch_create_elements",
    description: "أنشئ عدة عناصر مترابطة دفعة واحدة؛ الأفضل لبناء الرسومات المنظمة.",
    inputSchema: objectSchema({ elements: { type: "array", items: elementSchema } }, ["elements"]),
  },
  {
    name: "duplicate_elements",
    description: "انسخ عناصر مع إزاحة اختيارية.",
    inputSchema: objectSchema(
      { elementIds: stringArray, offsetX: { type: "number" }, offsetY: { type: "number" } },
      ["elementIds"],
    ),
  },
  {
    name: "align_elements",
    description: "حاذِ عدة عناصر إلى طرف أو مركز مشترك.",
    inputSchema: objectSchema(
      {
        elementIds: stringArray,
        alignment: {
          type: "string",
          enum: ["left", "center", "right", "top", "middle", "bottom"],
        },
      },
      ["elementIds", "alignment"],
    ),
  },
  {
    name: "distribute_elements",
    description: "وزّع ثلاثة عناصر أو أكثر بمسافات متساوية.",
    inputSchema: objectSchema(
      {
        elementIds: stringArray,
        direction: { type: "string", enum: ["horizontal", "vertical"] },
      },
      ["elementIds", "direction"],
    ),
  },
  {
    name: "group_elements",
    description: "اجمع عناصر في مجموعة Excalidraw حقيقية.",
    inputSchema: objectSchema({ elementIds: stringArray }, ["elementIds"]),
  },
  {
    name: "ungroup_elements",
    description: "فك مجموعة Excalidraw بالمعرّف.",
    inputSchema: objectSchema({ groupId: { type: "string" } }, ["groupId"]),
  },
  {
    name: "lock_elements",
    description: "اقفل عناصر لمنع تعديلها اليدوي العرضي.",
    inputSchema: objectSchema({ elementIds: stringArray }, ["elementIds"]),
  },
  {
    name: "unlock_elements",
    description: "افتح العناصر المقفلة.",
    inputSchema: objectSchema({ elementIds: stringArray }, ["elementIds"]),
  },
  {
    name: "set_z_order",
    description: "قدّم العناصر إلى الأمام أو أرسلها إلى الخلف أو ضعها في ترتيب طبقة محدد.",
    inputSchema: objectSchema({
      elementIds: stringArray,
      position: { type: "string", enum: ["front", "back"] },
      index: { type: "integer", minimum: 0 },
    }, ["elementIds"]),
  },
  {
    name: "apply_style_to_elements",
    description: "طبّق الألوان والتعبئة والحدود والخشونة والشفافية والخط على عدة عناصر دفعة واحدة.",
    inputSchema: objectSchema({ elementIds: stringArray, style: openObject }, ["elementIds", "style"]),
  },
  {
    name: "create_drop_shadow",
    description: "أنشئ ظلًا خلف أشكال مغلقة بنسخة مزاحة منخفضة الشفافية، لأن Excalidraw لا يملك خاصية ظل أصلية مستقلة.",
    inputSchema: objectSchema({
      elementIds: stringArray,
      offsetX: { type: "number" },
      offsetY: { type: "number" },
      color: { type: "string" },
      opacity: { type: "number", minimum: 0, maximum: 100 },
      locked: { type: "boolean" },
      group: { type: "boolean" },
    }, ["elementIds"]),
  },
  {
    name: "set_pen",
    description: "فعّل قلمًا مخصصًا أو هايلايتر واضبط خيارات Perfect Freehand في الرسم النشط.",
    inputSchema: objectSchema({
      preset: { type: "string", enum: ["finetip", "marker", "highlighter", "custom"] },
      highlighter: { type: "boolean" },
      constantPressure: { type: "boolean" },
      hasOutline: { type: "boolean" },
      outlineWidth: { type: "number" },
      thinning: { type: "number" },
      smoothing: { type: "number" },
      streamline: { type: "number" },
      easing: { type: "string" },
      startTaper: { oneOf: [{ type: "number" }, { type: "boolean" }] },
      endTaper: { oneOf: [{ type: "number" }, { type: "boolean" }] },
      startCap: { type: "boolean" },
      endCap: { type: "boolean" },
      strokeWidth: { type: "number" },
      strokeColor: { type: "string" },
    }),
  },
  {
    name: "describe_scene",
    description: "أعد وصفًا مكانيًا مفهومًا للـAI للعناصر والنصوص والروابط وحدود الرسم.",
    inputSchema: objectSchema(),
  },
  {
    name: "inspect_visual_quality",
    description: "افحص صغر الخط وتجاوز النص وتداخل الأشكال هندسيًا قبل المراجعة بالصورة.",
    inputSchema: objectSchema({ minFontSize: { type: "number", minimum: 8, maximum: 40 } }),
  },
  {
    name: "get_canvas_screenshot",
    description: "التقط صورة PNG للرسم المفتوح وأعدها مباشرة للـAI لفحص الجودة بصريًا.",
    inputSchema: objectSchema({
      background: { type: "boolean", default: true },
      scale: { type: "number", minimum: 0.1, maximum: 4, default: 1 },
    }),
  },
  {
    name: "get_resource",
    description: "اقرأ المشهد أو العناصر أو السمة أو مكتبة Excalidraw.",
    inputSchema: objectSchema(
      { resource: { type: "string", enum: ["scene", "elements", "theme", "library"] } },
      ["resource"],
    ),
  },
  {
    name: "export_scene",
    description: "صدّر الرسم كبيانات Excalidraw، أو احفظ نسخة .excalidraw داخل الـVault.",
    inputSchema: objectSchema({ filePath: { type: "string" } }),
  },
  {
    name: "import_scene",
    description: "استورد مشهدًا من بيانات أو ملف داخل الـVault، بالاستبدال أو الدمج.",
    inputSchema: objectSchema(
      {
        mode: { type: "string", enum: ["replace", "merge"] },
        filePath: { type: "string" },
        data: { oneOf: [{ type: "string" }, openObject] },
      },
      ["mode"],
    ),
  },
  {
    name: "export_to_image",
    description: "صدّر PNG أو SVG داخل الـVault أو أعد النتيجة مباشرة للـAI.",
    inputSchema: objectSchema(
      {
        format: { type: "string", enum: ["png", "svg"] },
        filePath: { type: "string" },
        background: { type: "boolean" },
        scale: { type: "number" },
      },
      ["format"],
    ),
  },
  {
    name: "export_to_excalidraw_url",
    description:
      "أنشئ رابط excalidraw.com مشفرًا اختياريًا. هذه الأداة وحدها تتصل بخدمة Excalidraw الخارجية.",
    inputSchema: objectSchema(),
  },
  {
    name: "clear_canvas",
    description: "امسح عناصر الرسم النشط. يفضّل أخذ لقطة قبل ذلك.",
    inputSchema: objectSchema(),
  },
  {
    name: "snapshot_scene",
    description: "احفظ لقطة مسماة مؤقتة من الرسم للتراجع الآمن.",
    inputSchema: objectSchema({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "restore_snapshot",
    description: "استعد لقطة مسماة أُنشئت في جلسة Obsidian الحالية.",
    inputSchema: objectSchema({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "set_viewport",
    description: "كبّر الرسم ليلائم المحتوى أو عناصر محددة، أو اضبط موضع الكاميرا.",
    inputSchema: objectSchema({
      scrollToContent: { type: "boolean" },
      scrollToElementId: { type: "string" },
      scrollToElementIds: stringArray,
      selectElements: { type: "boolean" },
      zoom: { type: "number" },
      offsetX: { type: "number" },
      offsetY: { type: "number" },
    }),
  },
  {
    name: "read_diagram_guide",
    description: "اقرأ إرشادات مختصرة لبناء رسم منظم وقابل للقراءة.",
    inputSchema: objectSchema(),
  },
  {
    name: "create_from_mermaid",
    description: "حوّل Mermaid إلى عناصر Excalidraw حقيقية. إعادة الطلب المطابق تُعيد النتيجة السابقة منعًا للتكرار؛ استخدم forceDuplicate للتكرار المقصود.",
    inputSchema: objectSchema(
      {
        mermaidDiagram: { type: "string" },
        groupElements: { type: "boolean", default: true },
        forceDuplicate: { type: "boolean", default: false },
      },
      ["mermaidDiagram"],
    ),
  },
  {
    name: "status",
    description:
      "تحقق من Obsidian وExcalidraw والرسم النشط وإصدار الجسر. يعيد أيضًا fonts.arabicFontFamily: مرّره في fontFamily للنص العربي، وإن كان null فلا تمرّر fontFamily إطلاقًا.",
    inputSchema: objectSchema(),
  },
  {
    name: "list_drawings",
    description: "اسرد كل رسومات Excalidraw الموجودة في Vault.",
    inputSchema: objectSchema({ folder: { type: "string" }, query: { type: "string" } }),
  },
  {
    name: "open_drawing",
    description: "افتح رسمًا داخل Obsidian واجعله هدف أدوات Excalidraw المعتادة.",
    inputSchema: objectSchema(
      { path: { type: "string" }, newLeaf: { type: "boolean", default: false } },
      ["path"],
    ),
  },
  {
    name: "create_drawing",
    description: "أنشئ ملف Obsidian Excalidraw أصليًا جديدًا وافتحه افتراضيًا ليصبح هدف أدوات المشهد. استخدم open:false فقط للإنشاء الصامت.",
    inputSchema: objectSchema({
      filename: { type: "string" },
      foldername: { type: "string" },
      templatePath: { type: "string" },
      open: { type: "boolean", default: true },
      frontmatterKeys: openObject,
      plaintext: { type: "string" },
    }),
  },
  {
    name: "list_notes",
    description: "اسرد ملاحظات Markdown العادية مع خصائصها وروابطها ووسومها.",
    inputSchema: objectSchema({ folder: { type: "string" }, query: { type: "string" } }),
  },
  {
    name: "read_note",
    description: "اقرأ ملاحظة Obsidian كاملة. يجمع tags وسوم المتن والـFrontmatter، ويعيد inlineTags وfrontmatterTags منفصلين أيضًا.",
    inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "create_note",
    description: "أنشئ ملاحظة Markdown منظمة داخل الـVault مع Frontmatter اختياري.",
    inputSchema: objectSchema(
      {
        path: { type: "string" },
        content: { type: "string" },
        frontmatter: openObject,
        overwrite: { type: "boolean", default: false },
      },
      ["path"],
    ),
  },
  {
    name: "update_note",
    description: "حدّث نص الملاحظة أو ألحق محتوى أو عدّل خصائص Frontmatter دون فقد بقية الخصائص.",
    inputSchema: objectSchema(
      {
        path: { type: "string" },
        content: { type: "string" },
        prepend: { type: "string" },
        append: { type: "string" },
        frontmatter: openObject,
      },
      ["path"],
    ),
  },
  {
    name: "move_note",
    description: "انقل ملاحظة أو أعد تسميتها عبر Obsidian مع تحديث الروابط بحسب إعدادات التطبيق.",
    inputSchema: objectSchema({
      path: { type: "string" },
      newPath: { type: "string" },
      updateLinks: {
        type: "boolean",
        default: true,
        description: "عطّله للنقل السريع في الخزن الكبيرة عندما لا تحتاج تحديث الروابط.",
      },
    }, ["path", "newPath"]),
  },
  {
    name: "trash_note",
    description: "انقل ملاحظة إلى سلة Obsidian القابلة للاستعادة بدل الحذف النهائي.",
    inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "search_notes",
    description: "ابحث داخل عناوين ومحتوى ملاحظات Obsidian وأعد مقتطفات من النتائج.",
    inputSchema: objectSchema(
      { query: { type: "string" }, folder: { type: "string" }, limit: { type: "number" } },
      ["query"],
    ),
  },
  {
    name: "get_backlinks",
    description: "اعرض الملاحظات التي تشير إلى ملف محدد وعدد الروابط من كل مصدر.",
    inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "get_vault_structure",
    description: "اعرض بنية مجلدات الـVault وأعداد الملاحظات والرسومات والمرفقات.",
    inputSchema: objectSchema({ maxDepth: { type: "number", minimum: 1, maximum: 8 } }),
  },
  {
    name: "search_vault_images",
    description: "ابحث في صور الـVault بالاسم والمجلد والامتداد قبل إدراجها في الرسم.",
    inputSchema: objectSchema({
      query: { type: "string" }, folder: { type: "string" }, limit: { type: "number" },
      extensions: { type: "array", items: { type: "string" } },
    }),
  },
  {
    name: "set_drawing_frontmatter",
    description: "اضبط خصائص رسم Excalidraw النشط مثل وضع العرض والتصدير والوسوم.",
    inputSchema: objectSchema({ properties: openObject }, ["properties"]),
  },
  {
    name: "create_obsidian_link",
    description: "اربط عنصرًا بملاحظة Obsidian أو عنوان أو block reference مع اسم مستعار اختياري.",
    inputSchema: objectSchema({
      elementId: { type: "string" }, filePath: { type: "string" }, heading: { type: "string" },
      blockId: { type: "string" }, alias: { type: "string" },
    }, ["elementId", "filePath"]),
  },
  {
    name: "create_transclusion",
    description: "أنشئ تضمينًا نصيًا لقسم أو block من ملاحظة Obsidian داخل الرسم.",
    inputSchema: objectSchema({
      filePath: { type: "string" }, heading: { type: "string" }, blockId: { type: "string" },
      wrapAt: { type: "number" }, x: { type: "number" }, y: { type: "number" },
      fontSize: { type: "number" }, fontFamily: { oneOf: [{ type: "number" }, { type: "string" }] },
      strokeColor: { type: "string" },
    }, ["filePath", "x", "y"]),
  },
  {
    name: "search_library",
    description: "ابحث في مكتبة أشكال Excalidraw المحملة واعرض أسماء العناصر وأنواعها.",
    inputSchema: objectSchema({ query: { type: "string" } }),
  },
  {
    name: "save_elements_to_library",
    description: "احفظ مجموعة عناصر من الرسم النشط كمكوّن قابل لإعادة الاستخدام في مكتبة Excalidraw.",
    inputSchema: objectSchema({
      elementIds: stringArray,
      name: { type: "string" },
      status: { type: "string", enum: ["published", "unpublished"] },
    }, ["elementIds"]),
  },
  {
    name: "insert_library_item",
    description: "أدرج عنصر مكتبة Excalidraw في موضع وحجم محددين مع إصلاح المعرفات والروابط الداخلية.",
    inputSchema: objectSchema({
      itemId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, scale: { type: "number" },
    }, ["itemId", "x", "y"]),
  },
  {
    name: "select_elements",
    description: "حدّد عناصر برمجيًا قبل تشغيل سكربت يعتمد على التحديد.",
    inputSchema: objectSchema({ elementIds: stringArray }, ["elementIds"]),
  },
  {
    name: "list_scripts",
    description: "اكتشف جميع سكربتات Script Engine المثبتة؛ تظهر السكربتات الجديدة تلقائيًا.",
    inputSchema: objectSchema({ query: { type: "string" } }),
  },
  {
    name: "run_script",
    description:
      "شغّل أي سكربت Excalidraw مثبت، مع تحديد العناصر وتمرير إجابات النوافذ دون تدخل يدوي.",
    inputSchema: objectSchema(
      {
        script: { type: "string" },
        elementIds: stringArray,
        responses: { type: "array", items: {} },
      },
      ["script"],
    ),
  },
  {
    name: "save_drawing",
    description: "احفظ رسم Obsidian Excalidraw النشط فورًا.",
    inputSchema: objectSchema(),
  },
  {
    name: "add_image",
    description: "أدرج صورة من ملف داخل الـVault أو رابط، مع ملفات Excalidraw المضمنة الصحيحة.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        filePath: { type: "string" },
        url: { type: "string" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "add_latex",
    description: "حوّل معادلة LaTeX إلى عنصر رسومي داخل Excalidraw.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        latex: { type: "string" },
        scaleX: { type: "number" },
        scaleY: { type: "number" },
      },
      ["x", "y", "latex"],
    ),
  },
  {
    name: "add_embeddable",
    description: "أدرج رابطًا أو ملاحظة Obsidian كعنصر تفاعلي مضمّن.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        url: { type: "string" },
        filePath: { type: "string" },
        customData: openObject,
      },
      ["x", "y"],
    ),
  },
  {
    name: "add_frame",
    description: "أضف إطار Excalidraw لتنظيم المشهد أو العرض الشرائحي.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        name: { type: "string" },
      },
      ["x", "y", "width", "height"],
    ),
  },
];

const toolNames = new Set(tools.map((tool) => tool.name));
const DIAGRAM_GUIDE = `
Excalidraw quality guide:
- Plan the coordinate grid before drawing. Keep 40–80px between elements.
- Body text should be at least 16px; titles at least 20px.
- Use solid pastel fills with darker matching strokes. Use dashed borders only for zones.
- Create background zones first, then primary shapes, then bound arrows, then annotations.
- Prefer batch_create_elements for connected scenes. Bind arrows with startElementId/endElementId.
- After each meaningful batch, call get_canvas_screenshot and visually check truncation, overlap, spacing, and arrow crossings.
- Do not bind a title to a large background zone; use a free-standing text element near its top edge.
`;

function concatBuffers(...buffers) {
  let total = 4;
  for (const buffer of buffers) total += 4 + buffer.length;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 1);
  let offset = 4;
  for (const buffer of buffers) {
    view.setUint32(offset, buffer.length);
    offset += 4;
    output.set(buffer, offset);
    offset += buffer.length;
  }
  return output;
}

async function exportToExcalidrawUrl() {
  const scene = await bridgeCall("get_scene", {});
  if (!scene.elements?.length) throw new Error("الرسم فارغ ولا يمكن إنشاء رابط له");
  const encoder = new TextEncoder();
  const sceneData = encoder.encode(
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files || {},
    }),
  );
  const compressed = deflateSync(Buffer.from(concatBuffers(encoder.encode("{}"), sceneData)));
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, [
    "encrypt",
  ]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed);
  const metadata = encoder.encode(
    JSON.stringify({ version: 2, compression: "pako@1", encryption: "AES-GCM" }),
  );
  const payload = concatBuffers(metadata, iv, new Uint8Array(encrypted));
  const response = await fetch("https://json.excalidraw.com/api/v2/post/", {
    method: "POST",
    body: Buffer.from(payload),
  });
  if (!response.ok) throw new Error(`تعذر رفع الرسم: HTTP ${response.status}`);
  const uploaded = await response.json();
  const jwk = await webcrypto.subtle.exportKey("jwk", key);
  return { url: `https://excalidraw.com/#json=${uploaded.id},${jwk.k}` };
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolResult(name, result) {
  if (
    (name === "get_canvas_screenshot" || name === "export_to_image") &&
    result?.mimeType === "image/png" &&
    result?.data
  ) {
    return {
      content: [
        { type: "image", data: result.data, mimeType: result.mimeType },
        { type: "text", text: JSON.stringify({ elementCount: result.elementCount ?? null }) },
      ],
      structuredContent: { mimeType: result.mimeType, elementCount: result.elementCount ?? null },
      isError: false,
    };
  }
  return {
    content: [
      { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
    ],
    structuredContent:
      result && typeof result === "object"
        ? result
        : { value: result === undefined ? null : result },
    isError: false,
  };
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return failure(message?.id, -32600, "Invalid Request");
  }
  if (message.id === undefined) return null;

  switch (message.method) {
    case "initialize":
      return success(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "ping":
      return success(message.id, {});
    case "tools/list":
      return success(message.id, { tools });
    case "tools/call": {
      const name = message.params?.name;
      if (!toolNames.has(name)) {
        return success(message.id, {
          content: [{ type: "text", text: `أداة غير معروفة: ${name}` }],
          isError: true,
        });
      }
      try {
        let result;
        if (name === "read_diagram_guide") result = { guide: DIAGRAM_GUIDE.trim() };
        else if (name === "export_to_excalidraw_url") result = await exportToExcalidrawUrl();
        else result = await bridgeCall(name, message.params?.arguments || {});
        return success(message.id, toolResult(name, result));
      } catch (error) {
        return success(message.id, {
          content: [{ type: "text", text: error.message || String(error) }],
          isError: true,
        });
      }
    }
    default:
      return failure(message.id, -32601, "Method not found");
  }
}

async function runStdio() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`);
        continue;
      }
      try {
        const response = await handleMessage(message);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify(failure(message.id, -32603, "Internal error", error.message))}\n`,
        );
      }
    }
  }
}

async function runHealthCheck() {
  const result = await bridgeCall("status", {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");
if (isMain) {
  if (cli.health) {
    runHealthCheck().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  } else if (cli["self-test"]) {
    process.stdout.write(`${JSON.stringify({ name: SERVER_NAME, tools: tools.length })}\n`);
  } else {
    runStdio().catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
  }
}

export { bridgeCall, handleMessage, readBridgeSettings, tools };
