#!/usr/bin/env node
/**
 * validate-scene.mjs — فحص سلامة رسومات Excalidraw دون Obsidian
 *
 * يعمل على ملف واحد أو مجلد كامل، ويرصد ما لا ترصده اختبارات القبول الحية:
 *   - أسهم غير مرتبطة (لا تتبع الأشكال، ولا يراها Auto Layout)
 *   - حقول غير قياسية (start/end/createdAt/updatedAt)
 *   - خصائص Excalidraw ناقصة (seed المفقود يغيّر مظهر الرسم كل فتح)
 *   - معرّفات أقصر من 8 محارف
 *   - مراجع ارتباط معلّقة (سهم يشير إلى عنصر محذوف)
 *   - نص مرتبط بلا حاوية، وحاوية تشير إلى نص غير موجود
 *
 * الاستخدام:
 *   node validate-scene.mjs --path "<vault>/Excalidraw"
 *   node validate-scene.mjs --path "<file>.excalidraw.md" --json
 *   node validate-scene.mjs --path "<vault>" --strict     # خروج بخطأ على التحذيرات أيضًا
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseSceneFromMarkdown } from "./lib/lz-string.mjs";

// ---------------------------------------------------------------- القواعد
const CANONICAL = [
  "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
  "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds",
  "frameId", "index", "roundness", "seed", "version", "versionNonce", "isDeleted",
  "boundElements", "updated", "link", "locked",
];


const NON_SCHEMA = ["start", "end", "createdAt", "updatedAt"];
const CONNECTABLE = new Set(["rectangle", "ellipse", "diamond", "text", "image", "frame", "blob"]);

function checkScene(scene, file) {
  const issues = [];
  const add = (severity, rule, message, elementId) =>
    issues.push({ severity, rule, message, elementId, file });

  const els = (scene.elements || []).filter((e) => !e.isDeleted);
  const byId = new Map(els.map((e) => [e.id, e]));

  for (const el of els) {
    // 1) أسهم غير مرتبطة
    if (el.type === "arrow") {
      const hasStart = Boolean(el.startBinding?.elementId);
      const hasEnd = Boolean(el.endBinding?.elementId);
      const legacy = Boolean(el.start || el.end);

      if (legacy && !hasStart && !hasEnd) {
        add("error", "arrow-legacy-binding",
          "سهم يستخدم حقلي start/end القديمين بدل startBinding/endBinding — لن يتبع الأشكال، ولن يراه Auto Layout",
          el.id);
      } else if (!hasStart || !hasEnd) {
        add("warning", "arrow-unbound",
          `سهم بلا ارتباط ${!hasStart ? "من البداية" : ""}${!hasStart && !hasEnd ? " و" : ""}${!hasEnd ? "من النهاية" : ""} — لن يتبع الشكل عند تحريكه`,
          el.id);
      }

      // مراجع معلّقة
      for (const [side, b] of [["startBinding", el.startBinding], ["endBinding", el.endBinding]]) {
        if (b?.elementId && !byId.has(b.elementId)) {
          add("error", "binding-dangling",
            `${side} يشير إلى عنصر غير موجود: ${b.elementId}`, el.id);
        } else if (b?.elementId) {
          const target = byId.get(b.elementId);
          if (target.type === "text" && target.containerId) {
            add("error", "binding-to-label",
              `${side} مرتبط بنص داخل حاوية (${b.elementId}) بدل الحاوية نفسها (${target.containerId}) — خطأ شائع عند تمرير معرّف مطلوب مع نص`,
              el.id);
          } else if (!CONNECTABLE.has(target.type)) {
            add("warning", "binding-odd-target",
              `${side} مرتبط بعنصر من نوع ${target.type}`, el.id);
          }
        }
      }
    }

    // 2) حقول غير قياسية
    const bad = NON_SCHEMA.filter((k) => k in el);
    if (bad.length) {
      add("warning", "non-schema-fields",
        `حقول ليست من مخطط Excalidraw: ${bad.join(", ")} — انقلها إلى customData`, el.id);
    }

    // 3) خصائص ناقصة
    const missing = CANONICAL.filter((k) => !(k in el));
    if (missing.length) {
      const critical = missing.filter((k) => ["seed", "index", "versionNonce", "angle", "opacity"].includes(k));
      add(critical.length ? "warning" : "info", "missing-canonical",
        `خصائص ناقصة (${missing.length}): ${missing.join(", ")}` +
        (missing.includes("seed") ? " — غياب seed يغيّر مظهر الخط اليدوي عند كل فتح" : ""),
        el.id);
    }

    // 4) معرّفات غير أصلية. النص أخطر لأنه مفتاح قسم Text Elements الثاني؛
    // معرّف غير أصلي قد يدمج نصوصًا مستقلة عند الحفظ وإعادة الفتح.
    if (typeof el.id === "string" && !/^[0-9A-Za-z]{8}$/.test(el.id)) {
      add(el.type === "text" ? "error" : "warning", "id-not-native",
        `معرّف غير أصلي (${el.id.length} محارف)؛ المطلوب 8 محارف أبجدية رقمية` +
        (el.type === "text" ? " — هذا قد يفسد قسم Text Elements عند الحفظ" : ""), el.id);
    }

    // 5) سلامة النص المرتبط
    if (el.type === "text" && el.containerId) {
      const c = byId.get(el.containerId);
      if (!c) add("error", "label-orphan", `نص مرتبط بحاوية غير موجودة: ${el.containerId}`, el.id);
      else if (!(c.boundElements || []).some((b) => b.id === el.id)) {
        add("error", "label-not-listed",
          `الحاوية ${el.containerId} لا تُدرج هذا النص في boundElements — قد يختفي عند التحريك`, el.id);
      }
    }
    for (const b of el.boundElements || []) {
      if (!byId.has(b.id)) {
        add("error", "bound-dangling",
          `boundElements يشير إلى عنصر غير موجود: ${b.id}`, el.id);
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------- قراءة الملفات
async function readScene(file) {
  return parseSceneFromMarkdown(await fs.readFile(file, "utf8")).scene;
}

async function collect(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const out = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".excalidraw.md")) out.push(p);
    }
  }
  await walk(target);
  return out.sort();
}

// ---------------------------------------------------------------- التشغيل
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.path) {
  process.stderr.write("Usage: node validate-scene.mjs --path <file|folder> [--json] [--strict]\n");
  process.exit(2);
}

const files = await collect(path.resolve(args.path));
const all = [];
const perFile = [];

for (const f of files) {
  try {
    const scene = await readScene(f);
    const issues = checkScene(scene, f);
    all.push(...issues);
    perFile.push({
      file: f,
      source: scene.source || null,
      elements: (scene.elements || []).filter((e) => !e.isDeleted).length,
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
    });
  } catch (error) {
    all.push({ severity: "error", rule: "unreadable", message: error.message, file: f });
    perFile.push({ file: f, errors: 1, warnings: 0, unreadable: true });
  }
}

const errors = all.filter((i) => i.severity === "error").length;
const warnings = all.filter((i) => i.severity === "warning").length;

if (args.json) {
  process.stdout.write(`${JSON.stringify({ ok: errors === 0, files: perFile, issues: all }, null, 2)}\n`);
} else {
  process.stdout.write(`\nفحص سلامة رسومات Excalidraw\n${"=".repeat(34)}\n`);
  for (const f of perFile) {
    const mark = f.errors ? "✗" : f.warnings ? "!" : "✓";
    process.stdout.write(`${mark} ${path.basename(f.file)}  (${f.elements ?? "?"} عنصرًا`);
    if (f.errors) process.stdout.write(`، ${f.errors} خطأ`);
    if (f.warnings) process.stdout.write(`، ${f.warnings} تحذير`);
    process.stdout.write(")\n");
    if (f.source && f.source !== null) process.stdout.write(`    المصدر: ${f.source}\n`);
  }

  const byRule = new Map();
  for (const i of all) {
    if (!byRule.has(i.rule)) byRule.set(i.rule, []);
    byRule.get(i.rule).push(i);
  }
  if (byRule.size) {
    process.stdout.write(`\nالتفصيل:\n`);
    for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const sev = list[0].severity === "error" ? "خطأ" : list[0].severity === "warning" ? "تحذير" : "معلومة";
      process.stdout.write(`\n  [${sev}] ${rule} — ${list.length} حالة\n`);
      process.stdout.write(`    ${list[0].message}\n`);
      const ids = list.map((i) => i.elementId).filter(Boolean).slice(0, 8);
      if (ids.length) process.stdout.write(`    أمثلة: ${ids.join(", ")}${list.length > 8 ? " …" : ""}\n`);
    }
  }

  process.stdout.write(
    `\n${errors === 0 ? (warnings === 0 ? "سليم تمامًا." : `سليم مع ${warnings} تحذيرًا.`) : `${errors} خطأ و${warnings} تحذيرًا.`}\n`,
  );
}

process.exit(errors > 0 || (args.strict && warnings > 0) ? 1 : 0);
