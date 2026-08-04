#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  isWindowsAbsolutePath,
  isWslEnvironment,
  localPathInput,
  resolveWslClaudeDesktopTarget,
  shouldBlockCrossHostClaudeDesktop,
  wslPathToWindows,
} from "./platform-paths.mjs";

const BRIDGE_PLUGIN_ID = "obsidian-excalidraw-mcp-bridge";
const OFFICIAL_PLUGIN_IDS = ["obsidian-excalidraw-plugin", "excalidraw-extras"];
const execFileAsync = promisify(execFile);
const RUNNING_IN_WSL = isWslEnvironment();

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const equal = argument.indexOf("=");
    if (equal >= 0) values[argument.slice(2, equal)] = argument.slice(equal + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else values[argument.slice(2)] = true;
  }
  return values;
}

function usage() {
  return [
    "Excalidraw Universal MCP installer",
    "",
    "Required:",
    "  --vault <path>                 Obsidian Vault path",
    "",
    "Optional:",
    "  --project-root <path>          Project that receives .mcp.json (default: cwd)",
    "  --clients <list>               project,codex,claude-desktop or all",
    "  --codex-config <path>          Override Codex config.toml path",
    "  --claude-desktop-config <path> Override Claude Desktop JSON path",
    "  --font <path>                  User-owned .otf/.ttf/.woff/.woff2 local font",
    "  --force-plugin-versions        Replace installed official plugins with pinned versions",
    "  --offline                      Do not download; require official plugins to exist",
    "  --skip-official                Do not install/check official plugins",
    "  --help                         Show this help",
    "",
    "WSL: Claude Desktop on Windows receives Windows Node and Windows paths automatically.",
    "     Keep the repository and Vault on a mounted Windows drive such as /mnt/c.",
    "Linux agent + Windows desktop: double-click setup-windows.cmd on Windows.",
  ].join("\n");
}

function tomlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function removeTomlSections(config, sectionNames) {
  const targets = new Set(sectionNames.map((name) => `[${name}]`));
  const output = [];
  let skipping = false;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) skipping = targets.has(trimmed);
    if (!skipping) output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function backupOnce(filePath, suffix) {
  if (!(await exists(filePath))) return null;
  const backupPath = `${filePath}.${suffix}.bak`;
  if (!(await exists(backupPath))) await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function ensureVault(vaultPath) {
  const obsidianPath = path.join(vaultPath, ".obsidian");
  if (!(await exists(obsidianPath))) {
    throw new Error(`المجلد ليس Obsidian Vault صالحًا: ${vaultPath}`);
  }
  return obsidianPath;
}

async function download(url, destination, optional = false) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    if (optional) return false;
    throw new Error(`تعذر تنزيل ${url}: ${error.message}`);
  }
  if (!response.ok) {
    if (optional && response.status === 404) return false;
    throw new Error(`تعذر تنزيل ${url}: HTTP ${response.status}`);
  }
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return true;
}

async function installedVersion(pluginDirectory) {
  const manifest = await readJson(path.join(pluginDirectory, "manifest.json"), null);
  return manifest?.version || null;
}

async function installOfficialPlugin(spec, pluginsRoot, options) {
  const destination = path.join(pluginsRoot, spec.id);
  const currentVersion = await installedVersion(destination);
  if (currentVersion && currentVersion !== spec.version && !options.force) {
    return { id: spec.id, version: currentVersion, state: "preserved", pinnedVersion: spec.version };
  }
  if (currentVersion === spec.version) {
    return { id: spec.id, version: currentVersion, state: "already-installed" };
  }
  if (options.offline) {
    throw new Error(`الإضافة ${spec.id} غير مثبتة بالإصدار ${spec.version} والوضع offline مفعّل`);
  }

  const staging = path.join(pluginsRoot, `.${spec.id}.ai-kit-staging-${process.pid}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const file of spec.files) {
      const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${file.name}`;
      await download(url, path.join(staging, file.name), file.optional === true);
    }
    const manifest = await readJson(path.join(staging, "manifest.json"), null);
    if (manifest?.id !== spec.id || manifest?.version !== spec.version) {
      throw new Error(`بيانات إصدار ${spec.id} لا تطابق ملف القفل`);
    }
    if (await exists(destination)) {
      const backupsRoot = path.join(pluginsRoot, ".ai-kit-backups");
      await fs.mkdir(backupsRoot, { recursive: true });
      const backup = path.join(backupsRoot, `${spec.id}-${currentVersion || "unknown"}-${Date.now()}`);
      await fs.cp(destination, backup, { recursive: true });
      await fs.rm(destination, { recursive: true, force: true });
    }
    await fs.rename(staging, destination);
    return { id: spec.id, version: spec.version, state: "installed" };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function installOfficialPlugins(sourceRoot, obsidianPath, options) {
  if (options.skip) return [];
  const lock = await readJson(path.join(sourceRoot, "plugin-versions.json"), null);
  if (!lock?.plugins) throw new Error("plugin-versions.json غير صالح");
  const pluginsRoot = path.join(obsidianPath, "plugins");
  await fs.mkdir(pluginsRoot, { recursive: true });
  const results = [];
  for (const id of OFFICIAL_PLUGIN_IDS) {
    const spec = lock.plugins.find((plugin) => plugin.id === id);
    if (!spec) throw new Error(`الإضافة ${id} غير موجودة في ملف القفل`);
    results.push(await installOfficialPlugin(spec, pluginsRoot, options));
  }
  return results;
}

async function installBridge(sourceDirectory, obsidianPath) {
  const destination = path.join(obsidianPath, "plugins", BRIDGE_PLUGIN_ID);
  await fs.mkdir(destination, { recursive: true });
  for (const name of ["manifest.json", "main.js", "styles.css"]) {
    await fs.copyFile(path.join(sourceDirectory, name), path.join(destination, name));
  }
  return destination;
}

async function enablePlugins(obsidianPath) {
  const communityPluginsPath = path.join(obsidianPath, "community-plugins.json");
  await backupOnce(communityPluginsPath, BRIDGE_PLUGIN_ID);
  const plugins = await readJson(communityPluginsPath, []);
  if (!Array.isArray(plugins)) throw new Error("community-plugins.json ليس مصفوفة");
  for (const id of [...OFFICIAL_PLUGIN_IDS, BRIDGE_PLUGIN_ID]) {
    if (!plugins.includes(id)) plugins.push(id);
  }
  await fs.writeFile(communityPluginsPath, `${JSON.stringify(plugins, null, 2)}\n`, "utf8");
  return communityPluginsPath;
}

async function copyDirectoryFiles(source, destination) {
  if (!(await exists(source))) return 0;
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    count += 1;
  }
  return count;
}

async function installContent(sourceRoot, vaultPath) {
  const baseDestination = path.join(vaultPath, "Excalidraw", "Scripts", "أدوات التخطيط");
  const professionalDestination = path.join(vaultPath, "Excalidraw", "Scripts", "الحزمة الاحترافية");
  const baseFileCount = await copyDirectoryFiles(path.join(sourceRoot, "base-scripts"), baseDestination);
  const professionalFileCount = await copyDirectoryFiles(path.join(sourceRoot, "professional-scripts"), professionalDestination);

  const guideDestination = path.join(vaultPath, "دليل الاحتراف");
  await fs.mkdir(guideDestination, { recursive: true });
  const guides = [
    ["START-HERE-AR.md", "00-ابدأ من هنا.md"],
    ["PROFESSIONAL-GUIDE-AR.md", "01-الدليل الاحترافي لـ Obsidian وExcalidraw.md"],
    ["SCRIPT-CATALOG-AR.md", "02-دليل السكربتات المثبتة.md"],
    ["ACCEPTANCE-TEST-MATRIX.md", "03-مصفوفة اختبار القبول.md"],
  ];
  for (const [sourceName, destinationName] of guides) {
    await fs.copyFile(path.join(sourceRoot, sourceName), path.join(guideDestination, destinationName));
  }
  return { baseDestination, baseFileCount, professionalDestination, professionalFileCount, guideDestination };
}

async function installLocalFont(fontInput, vaultPath, obsidianPath) {
  if (!fontInput) return null;
  const fontPath = path.resolve(localPathInput(fontInput, { wsl: RUNNING_IN_WSL }));
  const extension = path.extname(fontPath).toLowerCase();
  if (![".otf", ".ttf", ".woff", ".woff2"].includes(extension)) {
    throw new Error("صيغة الخط يجب أن تكون otf أو ttf أو woff أو woff2");
  }
  if (!(await exists(fontPath))) throw new Error(`ملف الخط غير موجود: ${fontPath}`);
  const relative = path.posix.join("Excalidraw", "Custom Fonts", path.basename(fontPath));
  const destination = path.join(vaultPath, ...relative.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(fontPath, destination);

  const settingsPath = path.join(obsidianPath, "plugins", "obsidian-excalidraw-plugin", "data.json");
  const settings = await readJson(settingsPath, {});
  settings.experimentalEnableFourthFont = true;
  settings.experimantalFourthFont = relative;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { source: fontPath, destination, vaultPath: relative };
}

function mcpServerConfig(serverPath, vaultPath, command = process.execPath) {
  return { command, args: [serverPath], env: { OBSIDIAN_VAULT_PATH: vaultPath } };
}

async function configureJsonClient(configPath, serverConfig) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await backupOnce(configPath, BRIDGE_PLUGIN_ID);
  const config = await readJson(configPath, {});
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  delete config.mcpServers["obsidian-excalidraw"];
  config.mcpServers.excalidraw = serverConfig;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

async function configureCodex(configPath, serverPath, vaultPath) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await backupOnce(configPath, BRIDGE_PLUGIN_ID);
  const original = (await exists(configPath)) ? await fs.readFile(configPath, "utf8") : "";
  const config = removeTomlSections(original, [
    "mcp_servers.excalidraw", "mcp_servers.excalidraw.env",
    "mcp_servers.obsidian_excalidraw", "mcp_servers.obsidian_excalidraw.env",
  ]);
  const block = [
    "", "[mcp_servers.excalidraw]", `command = ${tomlLiteral(process.execPath)}`,
    `args = [${tomlLiteral(serverPath)}]`, "startup_timeout_sec = 30", "",
    "[mcp_servers.excalidraw.env]", `OBSIDIAN_VAULT_PATH = ${tomlLiteral(vaultPath)}`, "",
  ].join("\n");
  await fs.writeFile(configPath, `${config.trimEnd()}\n${block}`, "utf8");
  return configPath;
}

function defaultClaudeDesktopConfig() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

async function windowsPowerShellValue(expression, label) {
  try {
    const { stdout } = await execFileAsync(
      process.env.EXCALIDRAW_MCP_WINDOWS_POWERSHELL || "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", expression],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    const value = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
    if (!value) throw new Error("empty output");
    return value;
  } catch (error) {
    throw new Error(`تعذر اكتشاف ${label} من WSL: ${error.message}`);
  }
}

async function resolveWslWindowsAppData() {
  if (process.env.EXCALIDRAW_MCP_WINDOWS_APPDATA) return process.env.EXCALIDRAW_MCP_WINDOWS_APPDATA;
  return windowsPowerShellValue("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $env:APPDATA", "مجلد APPDATA في Windows");
}

async function resolveWslWindowsNode() {
  if (process.env.EXCALIDRAW_MCP_WINDOWS_NODE) return process.env.EXCALIDRAW_MCP_WINDOWS_NODE;
  return windowsPowerShellValue(
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Command node.exe -ErrorAction Stop).Source",
    "Node.js الخاص بـWindows",
  );
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function wslManualClaudeCommand(sourceRoot, vaultPath, target) {
  const sourceWindowsPath = wslPathToWindows(sourceRoot);
  const vaultWindowsPath = wslPathToWindows(vaultPath);
  return [
    `Set-Location -LiteralPath ${powershellLiteral(sourceWindowsPath)}`,
    `& ${powershellLiteral(target.serverConfig.command)} '.\\install.mjs' --vault ${powershellLiteral(vaultWindowsPath)} --clients 'claude-desktop' --claude-desktop-config ${powershellLiteral(target.configDisplayPath)}`,
  ].join("\n");
}

async function wslClaudeDesktopTarget(args, sourceRoot, vaultPath) {
  const rawConfigPath = args["claude-desktop-config"];
  const configPath = rawConfigPath
    ? (isWindowsAbsolutePath(rawConfigPath)
      ? rawConfigPath
      : path.resolve(localPathInput(rawConfigPath, { wsl: true })))
    : null;
  return resolveWslClaudeDesktopTarget({
    sourceRoot,
    vaultPath,
    configPath,
    windowsAppData: await resolveWslWindowsAppData(),
    windowsNode: await resolveWslWindowsNode(),
  });
}

function requestedClients(value) {
  const raw = String(value || "project").split(",").map((item) => item.trim()).filter(Boolean);
  if (raw.includes("all")) return new Set(["project", "codex", "claude-desktop"]);
  return new Set(raw);
}

async function configureClients(args, sourceRoot, serverPath, vaultPath, preparedWslClaudeDesktopTarget = null) {
  const clients = requestedClients(args.clients);
  const configured = {};
  if (clients.has("project")) {
    const projectRoot = path.resolve(localPathInput(args["project-root"] || process.cwd(), { wsl: RUNNING_IN_WSL }));
    configured.project = await configureJsonClient(
      path.join(projectRoot, ".mcp.json"),
      mcpServerConfig(serverPath, vaultPath),
    );
  }
  if (clients.has("codex")) {
    const codexConfig = path.resolve(localPathInput(
      args["codex-config"] || path.join(os.homedir(), ".codex", "config.toml"),
      { wsl: RUNNING_IN_WSL },
    ));
    configured.codex = await configureCodex(codexConfig, serverPath, vaultPath);
  }
  if (clients.has("claude-desktop")) {
    if (RUNNING_IN_WSL) {
      const target = preparedWslClaudeDesktopTarget || await wslClaudeDesktopTarget(args, sourceRoot, vaultPath);
      try {
        await configureJsonClient(target.configAccessPath, target.serverConfig);
      } catch (error) {
        throw new Error([
          `تعذر تحديث Claude Desktop على Windows من WSL: ${error.message}`,
          "شغّل الأمر التالي مرة واحدة في Windows PowerShell:",
          "",
          wslManualClaudeCommand(sourceRoot, vaultPath, target),
        ].join("\n"));
      }
      configured.claudeDesktop = target.configDisplayPath;
      configured.claudeDesktopHost = "windows-from-wsl";
    } else {
      const claudeConfig = path.resolve(args["claude-desktop-config"] || defaultClaudeDesktopConfig());
      configured.claudeDesktop = await configureJsonClient(
        claudeConfig,
        mcpServerConfig(serverPath, vaultPath),
      );
    }
  }
  configured.instructions = path.join(sourceRoot, "CLAUDE.md");
  return configured;
}

const args = parseArguments(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (!args.vault) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

const selectedClients = requestedClients(args.clients);
if (shouldBlockCrossHostClaudeDesktop({
  wsl: RUNNING_IN_WSL,
  claudeDesktopSelected: selectedClients.has("claude-desktop"),
  explicitConfig: Boolean(args["claude-desktop-config"]),
})) {
  throw new Error([
    "جلسة Linux الحالية منفصلة عن Claude Desktop على Windows، لذلك لن يكتب المثبّت مسارات Linux داخل إعداد Windows.",
    "نزّل الريبو على Windows ثم شغّل هذا الأمر في Windows PowerShell:",
    "",
    "Double-click setup-windows.cmd on Windows and select your Obsidian vault.",
  ].join("\n"));
}

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const vaultPath = path.resolve(localPathInput(args.vault, { wsl: RUNNING_IN_WSL }));
const obsidianPath = await ensureVault(vaultPath);
const serverPath = path.join(sourceRoot, "server.mjs");
const preparedWslClaudeDesktopTarget = RUNNING_IN_WSL && selectedClients.has("claude-desktop")
  ? await wslClaudeDesktopTarget(args, sourceRoot, vaultPath)
  : null;
const officialPlugins = await installOfficialPlugins(sourceRoot, obsidianPath, {
  force: args["force-plugin-versions"] === true,
  offline: args.offline === true,
  skip: args["skip-official"] === true,
});
const bridgePath = await installBridge(path.join(sourceRoot, "obsidian-plugin"), obsidianPath);
const enabledPluginsPath = await enablePlugins(obsidianPath);
const content = await installContent(sourceRoot, vaultPath);
const font = await installLocalFont(args.font, vaultPath, obsidianPath);
const clients = await configureClients(
  args,
  sourceRoot,
  serverPath,
  vaultPath,
  preparedWslClaudeDesktopTarget,
);

process.stdout.write(`${JSON.stringify({
  installed: true,
  vaultPath,
  officialPlugins,
  bridge: { path: bridgePath, version: (await readJson(path.join(bridgePath, "manifest.json"), {})).version },
  enabledPluginsPath,
  content,
  font,
  clients,
  next: ["Restart Obsidian once", "Restart the selected MCP clients once", `Run: node ${path.join(sourceRoot, "doctor.mjs")} --vault ${JSON.stringify(vaultPath)}`],
}, null, 2)}\n`);
