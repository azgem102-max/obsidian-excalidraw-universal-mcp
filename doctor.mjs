#!/usr/bin/env node
/**
 * doctor.mjs — v2
 *
 * ما تغيّر عن v1:
 *  1. فصل installReady عن liveReady. رمز الخروج يعبّر عن التثبيت لا عن كون
 *     Obsidian مفتوحًا، فلا يظهر «غير جاهز» لسبب لا علاقة له بالتثبيت.
 *  2. رسالة صادقة لرفض الاتصال تغطي الاحتمالين: Obsidian مغلق، أو الفحص يعمل
 *     من حاوية/VM/WSL لا تصل إلى 127.0.0.1 للمضيف. ورمز الخطأ يميّز انعدام
 *     الشبكة عن الرفض. فلا يُتّهم المستخدم بأن Obsidian مغلق وهو مفتوح.
 *  3. مقارنة الإصدارات المثبَّتة بـplugin-versions.json وإبراز أي انزياح.
 *  4. تحقّق من إصدار Node قبل أي شيء.
 *  5. --skip-live و--bridge-host و--require-live و--lang en|ar
 *  6. كل حالة جسر تحمل meaning وnextAction وblame في --json، فلا يفسّرها الوكيل
 *     بنفسه من نثر. و`--bridge-host` هو المحاولة قبل الاستسلام بـ`--skip-live`.
 *
 * الاستخدام:
 *   node doctor.mjs --vault "<path>"
 *   node doctor.mjs --vault "<path>" --lang en        # مخرجات إنجليزية لـPowerShell
 *   node doctor.mjs --vault "<path>" --skip-live      # فحص التثبيت فقط
 *   node doctor.mjs --vault "<path>" --require-live   # للـCI: افشل إن لم يكن الجسر حيًّا
 *   node doctor.mjs --vault "<path>" --bridge-host 172.17.0.1   # من حاوية إلى المضيف
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverWindowsClaudeConfigs } from "./platform-paths.mjs";

const REQUIRED_PLUGINS = [
  { id: "obsidian-excalidraw-plugin", label: "Excalidraw" },
  { id: "excalidraw-extras", label: "Excalidraw Extras" },
  { id: "obsidian-excalidraw-mcp-bridge", label: "MCP Bridge" },
];
const BRIDGE_ID = "obsidian-excalidraw-mcp-bridge";
const EXCALIDRAW_ID = "obsidian-excalidraw-plugin";
const MIN_NODE = 18;

const T = {
  ar: {
    head: "فحص Obsidian + Excalidraw MCP",
    install: "التثبيت",
    live: "التشغيل الحيّ",
    plugin: "إضافة",
    enabled: "مفعّلة",
    disabled: "غير مفعّلة",
    scriptsBase: "سكربتات التخطيط",
    scriptsPro: "الحزمة الاحترافية",
    pinned: "المثبَّت في ملف القفل",
    installOk: "التثبيت مكتمل.",
    installBad: "التثبيت غير مكتمل.",
    liveOk: "الجسر حيّ — النظام جاهز للاستخدام.",
    liveSkipped: "تُخطّي الفحص الحيّ بطلبك.",
    liveClosed: "المنفذ رفض الاتصال. الأرجح أن Obsidian مغلق أو الإضافات غير مفعّلة — افتح Obsidian وافتح أي رسم Excalidraw مرة واحدة. وإن كان Obsidian مفتوحًا فعلًا فأنت تشغّل الفحص من حاوية أو VM أو WSL لا تصل إلى 127.0.0.1 للمضيف؛ شغّله على الجهاز نفسه. التثبيت سليم في الحالتين.",
    liveUnreachable: "لا يمكن فحص الجسر من هذه البيئة (حاوية أو VM أو WSL لا تصل إلى 127.0.0.1 للمضيف). شغّل الفحص على الجهاز نفسه — هذا ليس عطلًا في التثبيت.",
    liveNoToken: "لم يُنشأ رمز الجسر بعد. افتح Obsidian وافتح أي رسم Excalidraw مرة واحدة.",
    liveMismatch: (a, b) => `النسخة الحية ${b} لا تطابق المثبَّتة ${a}. أعد تشغيل Obsidian.`,
    nodeOld: (v) => `يتطلب Node ${MIN_NODE} أو أحدث. الموجود ${v}.`,
    versionDrift: (id, got, want) => `${id}: المثبَّت ${got} والمقفول ${want}. شغّل المثبّت بـ--force-plugin-versions إن أردت التطابق.`,
    fontReady: (name) => `الخط العربي جاهز (${name}) — مرّر fontFamily: 4.`,
    fontMissingFile: (p) => `الخط الرابع مسجَّل وملفه مفقود: ${p}. لا تمرّر fontFamily؛ أعد التثبيت بـ--font.`,
    fontDisabled: (name) => `ملف الخط موجود (${name}) وخيار الخط الرابع مطفأ في إعدادات Excalidraw — فعّله ثم أعد الفحص.`,
    fontAbsent: "لا خط عربي مثبَّت — اختياري. لا تمرّر fontFamily إطلاقًا. لإضافة خطك: node install.mjs --font \"<path>\".",
  },
  en: {
    head: "Obsidian + Excalidraw MCP check",
    install: "Installation",
    live: "Live bridge",
    plugin: "plugin",
    enabled: "enabled",
    disabled: "NOT enabled",
    scriptsBase: "layout scripts",
    scriptsPro: "professional scripts",
    pinned: "pinned",
    installOk: "Installation complete.",
    installBad: "Installation incomplete.",
    liveOk: "Bridge is live - system ready.",
    liveSkipped: "Live check skipped by request.",
    liveClosed: "Connection refused. Most likely Obsidian is closed or the plugins are disabled - open Obsidian and open any Excalidraw drawing once. If Obsidian IS open, you are running this from a container/VM/WSL that cannot reach the host's 127.0.0.1; run it on the machine itself. Either way the installation is fine.",
    liveUnreachable: "Bridge cannot be checked from this environment (a container, VM or WSL cannot reach the host's 127.0.0.1). Run the check on the machine itself - this is NOT an installation problem.",
    liveNoToken: "Bridge token not created yet. Open Obsidian and open any Excalidraw drawing once.",
    liveMismatch: (a, b) => `Live version ${b} does not match installed ${a}. Restart Obsidian.`,
    nodeOld: (v) => `Requires Node ${MIN_NODE} or newer. Found ${v}.`,
    versionDrift: (id, got, want) => `${id}: installed ${got}, pinned ${want}. Run the installer with --force-plugin-versions to align.`,
    fontReady: (name) => `Arabic font ready (${name}) - pass fontFamily: 4.`,
    fontMissingFile: (p) => `Fourth font registered but file missing: ${p}. Do NOT pass fontFamily; reinstall with --font.`,
    fontDisabled: (name) => `Font file present (${name}) but the fourth-font option is OFF in Excalidraw settings - enable it and re-run.`,
    fontAbsent: "No Arabic font installed - optional. Do NOT pass fontFamily at all. To add yours: node install.mjs --font \"<path>\".",
  },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return a;
}

async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}

async function countFiles(dir, ext = ".md") {
  try { return (await fs.readdir(dir)).filter((n) => n.endsWith(ext)).length; } catch { return 0; }
}

/** يميّز سبب فشل الوصول إلى الجسر بدل رسالة واحدة مبهمة. */
function classifyFetchError(error) {
  const code = error?.cause?.code || error?.code || "";
  if (code === "ECONNREFUSED") return "obsidian-closed";
  if (["ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ENOTFOUND", "EACCES"].includes(code)) return "unreachable-host";
  if (error?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return "unreachable-host";
  return "unreachable-host";
}

const args = parseArgs(process.argv.slice(2));
const lang = args.lang === "en" ? "en" : "ar";
const t = T[lang];

if (!args.vault) {
  process.stderr.write("Usage: node doctor.mjs --vault <path> [--json] [--lang en|ar] [--skip-live] [--require-live] [--bridge-host <host>]\n");
  process.exit(2);
}

// 0) Node
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < MIN_NODE) {
  process.stderr.write(`${t.nodeOld(process.version)}\n`);
  process.exit(2);
}

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const lock = await readJson(path.join(sourceRoot, "plugin-versions.json"), { plugins: [] });
const pinnedOf = (id) => lock.plugins?.find((p) => p.id === id)?.version || null;

const vault = path.resolve(args.vault);
const obsidian = path.join(vault, ".obsidian");
// مسار غير موجود كان يعطي مخرجًا **مطابقًا حرفًا بحرف** لخزنة حقيقية غير مثبَّتة،
// فخطأ مطبعي واحد يعني «التثبيت ناقص» إلى الأبد — والمسار هنا عربي وفيه مسافات.
const vaultExists = await fs.stat(vault).then((entry) => entry.isDirectory(), () => false);
const obsidianExists = await fs.stat(obsidian).then((entry) => entry.isDirectory(), () => false);
const enabled = await readJson(path.join(obsidian, "community-plugins.json"), []);
const enabledList = Array.isArray(enabled) ? enabled : [];

// 1) فحوص التثبيت
const installChecks = [];
for (const { id } of REQUIRED_PLUGINS) {
  const manifest = await readJson(path.join(obsidian, "plugins", id, "manifest.json"));
  const pinned = pinnedOf(id);
  const drift = Boolean(manifest && pinned && manifest.version !== pinned);
  installChecks.push({
    name: `plugin:${id}`,
    // A newer/different official version is preserved intentionally by the
    // installer. Report drift clearly, but do not call a working install bad.
    ok: Boolean(manifest) && enabledList.includes(id),
    present: Boolean(manifest),
    enabled: enabledList.includes(id),
    version: manifest?.version || null,
    pinnedVersion: pinned,
    versionDrift: drift,
  });
}

const baseCount = await countFiles(path.join(vault, "Excalidraw", "Scripts", "أدوات التخطيط"));
const proCount = await countFiles(path.join(vault, "Excalidraw", "Scripts", "الحزمة الاحترافية"));
installChecks.push({ name: "scripts:base", ok: baseCount >= 17, count: baseCount, expected: 17 });
installChecks.push({ name: "scripts:professional", ok: proCount >= 15, count: proCount, expected: 15 });

const installReady = installChecks.every((c) => c.ok);
const installedBridgeVersion = installChecks.find((c) => c.name === `plugin:${BRIDGE_ID}`)?.version || null;

// الخط العربي: معلومة لا شرط. المستودع لا يوزّع خطًا، والمستخدم يضيف خطه بنفسه
// بـ--font. لكن سكوت الطبيب عنه كان يترك الوكيل يخمّن رقم fontFamily. يُقرأ من
// إعدادات Excalidraw على القرص فيعمل بلا Obsidian مفتوح.
const excalidrawSettings = await readJson(
  path.join(obsidian, "plugins", EXCALIDRAW_ID, "data.json"),
  {},
);
// إملاء المفتاح كما هو upstream — لا تصحّحه.
const rawFontPath = excalidrawSettings?.experimantalFourthFont;
// مسار داخل الخزنة فقط. مطلقًا أو صاعدًا بـ`..` أو بشرطة خلفية لا تحمّله الإضافة،
// فقول «جاهز» عنه كذب — ونفس الشرط في الجسر حتى لا يختلف التقريران.
const looksLikeFontFile =
  typeof rawFontPath === "string" && /\.(otf|ttf|woff2?)$/i.test(rawFontPath);
const fourthFontPath =
  looksLikeFontFile && !rawFontPath.startsWith("/") &&
  !rawFontPath.includes("\\") && !rawFontPath.split("/").includes("..") && !/^[A-Za-z]:/.test(rawFontPath)
    ? rawFontPath
    : null;
const fourthFontEnabled = excalidrawSettings?.experimentalEnableFourthFont === true;
// ملف لا مجلد: `fs.access` ينجح على المجلدات، ومجلد ليس خطًا.
const fourthFontFound = fourthFontPath
  ? await fs.stat(path.join(vault, ...fourthFontPath.split("/"))).then((s) => s.isFile(), () => false)
  : false;
const font = {
  enabled: fourthFontEnabled,
  vaultPath: fourthFontPath,
  fileFound: fourthFontFound,
  arabicFontFamily: fourthFontEnabled && fourthFontFound ? 4 : null,
};

// 2) الفحص الحيّ — منفصل تمامًا
const bridgeData = await readJson(path.join(obsidian, "plugins", BRIDGE_ID, "data.json"));
let bridge = { state: "skipped", detail: null, liveVersion: null };

if (args["skip-live"]) {
  bridge = { state: "skipped", detail: null, liveVersion: null };
} else if (!bridgeData?.token || !bridgeData?.port) {
  bridge = { state: "no-token", detail: null, liveVersion: null };
} else {
  const host = args["bridge-host"] || "127.0.0.1";
  try {
    const response = await fetch(`http://${host}:${bridgeData.port}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeData.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "status", params: {} }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    if (!body.ok) bridge = { state: "rpc-error", detail: body.error, liveVersion: null };
    else if (body.result?.bridgeVersion !== installedBridgeVersion) {
      bridge = { state: "version-mismatch", detail: null, liveVersion: body.result?.bridgeVersion || null };
    } else {
      bridge = { state: "ok", detail: null, liveVersion: body.result.bridgeVersion, status: body.result };
    }
  } catch (error) {
    bridge = { state: classifyFetchError(error), detail: error.message, liveVersion: null };
  }
}

const liveReady = bridge.state === "ok";

// كل حالة تحمل معناها وخطوتها التالية في **حقل**، لا في نثر يفسّره الوكيل. وثيقةٌ
// كانت تقول «bridge غير ok يعني Obsidian مغلق» — وهي خاطئة في أربع حالات من خمس،
// وأخطرها `no-token` ومعناها «لم يُفتح رسم Excalidraw بعد» لا «Obsidian مغلق».
const BRIDGE_STATES = {
  ok: {
    meaning: "الجسر حيّ ويطابق النسخة المثبَّتة.",
    meaningEn: "Bridge is live and matches the installed version.",
    nextAction: null,
    blame: "none",
  },
  skipped: {
    meaning: "لم يُفحص الجسر بطلبك (--skip-live). هذه ليست نتيجة، فلا تقل «جاهز» ولا «فاشل».",
    meaningEn: "Live check skipped by request (--skip-live). Not a result: do not report ready or failed.",
    nextAction: "شغّل الفحص بلا --skip-live على الجهاز نفسه.",
    nextActionEn: "Re-run without --skip-live on the machine itself.",
    blame: "unknown",
  },
  "no-token": {
    meaning: "الإضافة مثبَّتة ولم يُفتح أي رسم Excalidraw بعد، فلم يُولَّد رمز الجسر ولم يُفتح المنفذ. Obsidian ليس السبب.",
    meaningEn: "Plugin installed but no Excalidraw drawing has been opened yet, so no bridge token and no port. Obsidian being closed is NOT the cause.",
    nextAction: "افتح Obsidian ثم افتح أي رسم Excalidraw مرة واحدة، ثم أعد الفحص.",
    nextActionEn: "Open Obsidian, then open any Excalidraw drawing once, and re-run.",
    blame: "user-action",
  },
  "obsidian-closed": {
    meaning: "المنفذ رفض الاتصال: Obsidian مغلق أو الإضافات غير مفعّلة.",
    meaningEn: "Connection refused: Obsidian is closed or the plugins are disabled.",
    nextAction: "افتح Obsidian وتأكد أن الإضافات الثلاث مفعّلة، ثم أعد الفحص.",
    nextActionEn: "Open Obsidian, confirm the three plugins are enabled, and re-run.",
    blame: "user-action",
  },
  "unreachable-host": {
    meaning: "لا يمكن فحص الجسر من هذه البيئة (حاوية أو VM أو WSL لا تصل إلى 127.0.0.1 للمضيف). التثبيت غير متهم.",
    meaningEn: "Bridge cannot be reached from this environment (container/VM/WSL cannot reach the host's 127.0.0.1). The installation is not at fault.",
    nextAction: "شغّل الفحص على الجهاز نفسه، أو مرّر --bridge-host <host> لعنوان يصل إلى المضيف.",
    nextActionEn: "Run on the machine itself, or pass --bridge-host <host> for an address that reaches it.",
    blame: "environment",
  },
  "version-mismatch": {
    meaning: "الجسر حيّ لكن النسخة العاملة في الذاكرة أقدم من المثبَّتة على القرص.",
    meaningEn: "Bridge is live but the version running in memory is older than the one installed on disk.",
    nextAction: "أعد تشغيل Obsidian (أو أطفئ الإضافة وأشعلها) ليُحمَّل الملف الجديد.",
    nextActionEn: "Restart Obsidian (or toggle the plugin off and on) to load the new file.",
    blame: "user-action",
  },
  "rpc-error": {
    meaning: "الجسر يستجيب ويرفض النداء — خطأ داخلي لا مشكلة اتصال.",
    meaningEn: "The bridge responds but rejects the call: an internal error, not a connectivity problem.",
    nextAction: "راجع تفصيل الخطأ في bridge.detail وسجل مطوّر Obsidian.",
    nextActionEn: "Inspect bridge.detail and the Obsidian developer console.",
    blame: "bug",
  },
};
const bridgeExplanation = BRIDGE_STATES[bridge.state] || {
  meaning: `حالة غير معروفة: ${bridge.state}`,
  meaningEn: `Unknown state: ${bridge.state}`,
  nextAction: "راجع bridge.detail.",
  nextActionEn: "Inspect bridge.detail.",
  blame: "unknown",
};
const liveMessage = {
  ok: t.liveOk,
  skipped: t.liveSkipped,
  "no-token": t.liveNoToken,
  "obsidian-closed": t.liveClosed,
  "unreachable-host": t.liveUnreachable,
  "rpc-error": `RPC: ${JSON.stringify(bridge.detail)}`,
  "version-mismatch": t.liveMismatch(installedBridgeVersion, bridge.liveVersion),
}[bridge.state];

// تسجيل العميل: `ready:true` كان ممكنًا مع **صفر** تسجيل، فالمستخدم لا يرى أدوات
// والطبيب يقول جاهز. لا يُحتسب في `installReady` (فقد يكون العميل مسجَّلًا بمسار
// مخصّص لا نعرفه) لكنه يُبلَّغ صريحًا مع خطوته.
const clientRegistrations = [];
{
  const projectRoot = path.resolve(args["project-root"] || process.cwd());
  const mcpJson = await readJson(path.join(projectRoot, ".mcp.json"));
  clientRegistrations.push({
    client: "project",
    path: path.join(projectRoot, ".mcp.json"),
    registered: Boolean(mcpJson?.mcpServers?.excalidraw),
  });
  const codexPath = path.join(process.env.HOME || process.env.USERPROFILE || "", ".codex", "config.toml");
  const codexToml = await fs.readFile(codexPath, "utf8").catch(() => "");
  clientRegistrations.push({
    client: "codex",
    path: codexPath,
    registered: /\[mcp_servers\.excalidraw\]/.test(codexToml),
  });
  if (process.platform === "win32") {
    for (const candidate of discoverWindowsClaudeConfigs({ fs: fsSync })) {
      const config = await readJson(candidate.path);
      clientRegistrations.push({
        client: "claude-desktop",
        path: candidate.path,
        registered: Boolean(config?.mcpServers?.excalidraw),
      });
    }
  }
}
const anyClientRegistered = clientRegistrations.some((entry) => entry.registered);

// 3) التقرير
const report = {
  ready: installReady && liveReady,
  installReady,
  liveReady,
  bridgeState: bridge.state,
  node: process.version,
  vault,
  vaultExists,
  ...(vaultExists ? {} : { vaultMissing: `المسار غير موجود أو ليس مجلدًا: ${vault}. تحقّق من الكتابة قبل إعادة التثبيت.` }),
  ...(vaultExists && !obsidianExists ? { obsidianMissing: `لا يوجد مجلد .obsidian داخل ${vault}: افتح هذا المجلد كخزنة في Obsidian مرة واحدة أولًا.` } : {}),
  installChecks,
  font,
  clientRegistrations,
  anyClientRegistered,
  ...(anyClientRegistered ? {} : {
    clientRegistrationHint:
      "لم يُعثر على تسجيل الخادم لأي عميل معروف. إن كان عميلك يقرأ من مسار مخصّص فهذا متوقّع؛ وإلا شغّل install.mjs بـ--clients المناسب. الطبيب لا يفحص هذا في installReady.",
  }),
  bridge: {
    state: bridge.state,
    installedVersion: installedBridgeVersion,
    liveVersion: bridge.liveVersion,
    message: liveMessage,
    // الوكيل يقرأ هذين لا النثر.
    meaning: bridgeExplanation.meaning,
    meaningEn: bridgeExplanation.meaningEn,
    nextAction: bridgeExplanation.nextAction,
    nextActionEn: bridgeExplanation.nextActionEn ?? null,
    blame: bridgeExplanation.blame,
    detail: bridge.detail ?? null,
    status: bridge.status ?? null,
  },
};

const fontMessage = font.arabicFontFamily
  ? t.fontReady(font.vaultPath.split("/").pop())
  : font.vaultPath && !font.fileFound
    ? t.fontMissingFile(font.vaultPath)
    : font.fileFound && !font.enabled
      ? t.fontDisabled(font.vaultPath.split("/").pop())
      : t.fontAbsent;

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const line = "=".repeat(Math.max(t.head.length + 4, 34));
  process.stdout.write(`\n${t.head}\n${line}\n\n${t.install}\n`);
  for (const c of installChecks) {
    const mark = c.ok ? "✓" : "✗";
    if (c.name.startsWith("plugin:")) {
      const id = c.name.slice(7);
      let extra = c.version ? ` (${c.version})` : "";
      if (c.versionDrift) extra += ` ≠ ${t.pinned} ${c.pinnedVersion}`;
      if (c.present && !c.enabled) extra += ` — ${t.disabled}`;
      process.stdout.write(`  ${mark} ${id}${extra}\n`);
    } else {
      const label = c.name === "scripts:base" ? t.scriptsBase : t.scriptsPro;
      process.stdout.write(`  ${mark} ${label}: ${c.count}/${c.expected}\n`);
    }
  }
  process.stdout.write(`  ${font.arabicFontFamily ? "✓" : "–"} ${fontMessage}\n`);
  process.stdout.write(`  ${installReady ? "→ " + t.installOk : "→ " + t.installBad}\n`);
  process.stdout.write(`\n${t.live}\n  ${liveReady ? "✓" : ["unreachable-host","skipped"].includes(bridge.state) ? "–" : "✗"} ${liveMessage}\n`);
  // الخطوة التالية مطبوعة صريحة: لا يفسّر أحدٌ الحالة بنفسه.
  if (bridgeExplanation.nextAction) {
    process.stdout.write(`  → ${lang === "en" ? bridgeExplanation.meaningEn : bridgeExplanation.meaning}\n`);
    process.stdout.write(`  → ${lang === "en" ? (bridgeExplanation.nextActionEn ?? bridgeExplanation.nextAction) : bridgeExplanation.nextAction}\n`);
  }
  if (!vaultExists) process.stdout.write(`\n  ✗ ${report.vaultMissing}\n`);
  else if (!obsidianExists) process.stdout.write(`\n  ✗ ${report.obsidianMissing}\n`);
  if (!anyClientRegistered) process.stdout.write(`\n  ! ${report.clientRegistrationHint}\n`);
  for (const c of installChecks.filter((x) => x.versionDrift)) {
    process.stdout.write(`\n  ! ${t.versionDrift(c.name.slice(7), c.version, c.pinnedVersion)}\n`);
  }
  // سطر واحد ثابت لا يتغيّر بتغيّر اللغة. كان معيار النجاح في الوثائق عبارة عربية،
  // والوثائق نفسها توصي بـ`--lang en` على PowerShell — فالعبارة لا تُطبع أبدًا في
  // المسار الموصى به، ويستنتج الوكيل فشلًا من تثبيت ناجح. هذا السطر هو المعيار.
  process.stdout.write(
    `\nRESULT install=${installReady ? "ready" : "incomplete"} bridge=${bridge.state} client=${anyClientRegistered ? "registered" : "unknown"} ready=${installReady && liveReady}\n\n`,
  );
}

// رمز الخروج: يعبّر عن التثبيت. الفحص الحيّ يُلزم فقط بـ--require-live.
const failLive = args["require-live"] && !liveReady;
process.exit(installReady && !failLive ? 0 : 1);
