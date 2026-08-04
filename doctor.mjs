#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REQUIRED_PLUGINS = ["obsidian-excalidraw-plugin", "excalidraw-extras", "obsidian-excalidraw-mcp-bridge"];

function argsMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function countFiles(directory, extension = ".md") {
  try { return (await fs.readdir(directory)).filter((name) => name.endsWith(extension)).length; } catch { return 0; }
}

const args = argsMap(process.argv.slice(2));
if (!args.vault) {
  process.stderr.write("Usage: node doctor.mjs --vault <Obsidian Vault path> [--json]\n");
  process.exit(2);
}

const vault = path.resolve(args.vault);
const obsidian = path.join(vault, ".obsidian");
const enabled = await readJson(path.join(obsidian, "community-plugins.json"), []);
const checks = [];
for (const id of REQUIRED_PLUGINS) {
  const manifest = await readJson(path.join(obsidian, "plugins", id, "manifest.json"));
  checks.push({ name: `plugin:${id}`, ok: Boolean(manifest), version: manifest?.version || null, enabled: Array.isArray(enabled) && enabled.includes(id) });
}

const baseScripts = await countFiles(path.join(vault, "Excalidraw", "Scripts", "أدوات التخطيط"));
const professionalScripts = await countFiles(path.join(vault, "Excalidraw", "Scripts", "الحزمة الاحترافية"));
checks.push({ name: "scripts:base", ok: baseScripts >= 17, count: baseScripts });
checks.push({ name: "scripts:professional", ok: professionalScripts >= 15, count: professionalScripts });

const bridgeData = await readJson(path.join(obsidian, "plugins", "obsidian-excalidraw-mcp-bridge", "data.json"));
const installedBridgeVersion = checks.find((check) => check.name === "plugin:obsidian-excalidraw-mcp-bridge")?.version;
let live = null;
if (bridgeData?.token && bridgeData?.port) {
  try {
    const response = await fetch(`http://127.0.0.1:${bridgeData.port}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeData.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "status", params: {} }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    live = body.ok ? body.result : { error: body.error };
  } catch (error) {
    live = { error: "Obsidian أو الجسر غير مفتوح", detail: error.message };
  }
} else live = { error: "يجب تشغيل Obsidian مرة واحدة لإنشاء رمز الجسر" };
const liveBridgeMatches = Boolean(
  live &&
  !live.error &&
  installedBridgeVersion &&
  live.bridgeVersion === installedBridgeVersion,
);
checks.push({
  name: "bridge:live",
  ok: liveBridgeMatches,
  expectedVersion: installedBridgeVersion || null,
  liveVersion: live?.bridgeVersion || null,
  status: live,
});

const next = live?.error
  ? "افتح Obsidian، فعّل الإضافات، ثم أعد الأمر"
  : !liveBridgeMatches
    ? `أعد تشغيل Obsidian لتحميل الجسر ${installedBridgeVersion || "المثبت"} بدل ${live?.bridgeVersion || "النسخة الحية الحالية"}`
    : "النظام جاهز؛ استخدم أدوات MCP باسم excalidraw";

const report = {
  ready: checks.every((check) => check.ok && (check.enabled ?? true)),
  node: process.version,
  vault,
  checks,
  next,
};

if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`\nفحص Obsidian + Excalidraw MCP\n${"=".repeat(34)}\n`);
  for (const check of checks) process.stdout.write(`${check.ok && (check.enabled ?? true) ? "✓" : "✗"} ${check.name}${check.version ? ` (${check.version})` : ""}${check.count !== undefined ? ` (${check.count})` : ""}\n`);
  process.stdout.write(`\n${report.ready ? "جاهز للاستخدام." : `غير جاهز بالكامل: ${report.next}`}\n`);
}
process.exit(report.ready ? 0 : 1);
