import os from "node:os";
import path from "node:path";
import process from "node:process";

export function isWslEnvironment({ platform = process.platform, env = process.env, release = os.release() } = {}) {
  return platform === "linux" && (Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(release));
}

export function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ""));
}

export function shouldBlockCrossHostClaudeDesktop({
  platform = process.platform,
  wsl = isWslEnvironment(),
  claudeDesktopSelected = false,
  explicitConfig = false,
} = {}) {
  return platform === "linux" && !wsl && claudeDesktopSelected && !explicitConfig;
}

export function windowsPathToWsl(value) {
  const input = String(value || "");
  const match = input.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) throw new Error(`Windows path expected: ${input}`);
  const drive = match[1].toLowerCase();
  const rest = match[2].replaceAll("\\", "/");
  return path.posix.join("/mnt", drive, rest);
}

export function wslPathToWindows(value) {
  const normalized = path.posix.normalize(String(value || ""));
  const match = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (!match) {
    throw new Error(
      `Windows applications cannot use this Linux-only path: ${value}. ` +
      "Keep the repository and Obsidian Vault on a mounted Windows drive such as /mnt/c.",
    );
  }
  const drive = match[1].toUpperCase();
  const rest = (match[2] || "").replaceAll("/", "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

export function localPathInput(value, { wsl = isWslEnvironment() } = {}) {
  if (wsl && isWindowsAbsolutePath(value)) return windowsPathToWsl(value);
  return value;
}

/**
 * نسخة Claude Desktop من متجر مايكروسوفت (MSIX) تعزل إعدادها داخل حاوية الحزمة:
 *   %LOCALAPPDATA%\\Packages\\Claude_<hash>\\LocalCache\\...\\claude_desktop_config.json
 * فالكتابة في %APPDATA%\\Claude لا تصل إليها إطلاقًا — وكان المثبّت يطبع
 * "installed": true بلا أثر في التطبيق.
 * تُعيد كل ملفات الإعداد الموجودة فعلًا، والأولوية لما يحتوي mcpServers.
 */
export function discoverWindowsClaudeConfigs({
  fs: fsImpl,
  localAppData = process.env.LOCALAPPDATA,
  appData = process.env.APPDATA,
  platform = process.platform,
  includeMissing = false,
} = {}) {
  if (platform !== "win32" || !fsImpl) return [];
  const found = [];
  const seen = new Set();
  const add = (file, kind, allowMissing = false) => {
    const resolved = path.win32.normalize(file);
    if (seen.has(resolved)) return;
    const exists = fsImpl.existsSync(resolved);
    if (!exists && !allowMissing) return;
    seen.add(resolved);
    let hasMcpServers = false;
    if (exists) {
      try { hasMcpServers = fsImpl.readFileSync(resolved, "utf8").includes('"mcpServers"'); } catch { /* لا */ }
    }
    found.push({ path: resolved, kind, exists, hasMcpServers });
  };

  const localRoot = localAppData || path.win32.join(os.homedir(), "AppData", "Local");
  const packages = path.win32.join(localRoot, "Packages");
  let entries = [];
  try { entries = fsImpl.readdirSync(packages, { withFileTypes: true }); } catch { entries = []; }
  const msixCaches = [];
  for (const entry of entries) {
    if (!entry.isDirectory?.() || !entry.name.startsWith("Claude")) continue;
    const cache = path.win32.join(packages, entry.name, "LocalCache");
    msixCaches.push(cache);
    for (const rel of [
      ["Roaming", "Claude", "claude_desktop_config.json"],
      ["Local", "Claude", "claude_desktop_config.json"],
    ]) add(path.win32.join(cache, ...rel), "msix");
  }

  const roamingRoot = appData || path.win32.join(os.homedir(), "AppData", "Roaming");
  const classicPath = path.win32.join(roamingRoot, "Claude", "claude_desktop_config.json");
  add(classicPath, "classic");

  // On a fresh install the config file may not exist yet. Keep setup one-click:
  // create the MSIX roaming config when a Store package exists, otherwise use
  // the classic location. We only synthesize a path when no real config exists.
  if (includeMissing && found.length === 0) {
    if (msixCaches.length) {
      for (const cache of msixCaches) {
        add(path.win32.join(cache, "Roaming", "Claude", "claude_desktop_config.json"), "msix-new", true);
      }
    } else {
      add(classicPath, "classic-new", true);
    }
  }

  return found.sort((a, b) => Number(b.hasMcpServers) - Number(a.hasMcpServers) || Number(b.exists) - Number(a.exists));
}

export function resolveWslClaudeDesktopTarget({
  sourceRoot,
  vaultPath,
  configPath,
  windowsAppData,
  windowsNode,
}) {
  const configWindowsPath = configPath
    ? (isWindowsAbsolutePath(configPath) ? path.win32.normalize(configPath) : wslPathToWindows(configPath))
    : path.win32.join(windowsAppData, "Claude", "claude_desktop_config.json");
  const serverWindowsPath = wslPathToWindows(path.posix.join(sourceRoot, "server.mjs"));
  const vaultWindowsPath = wslPathToWindows(vaultPath);
  return {
    configAccessPath: windowsPathToWsl(configWindowsPath),
    configDisplayPath: configWindowsPath,
    serverConfig: {
      command: path.win32.normalize(windowsNode),
      args: [serverWindowsPath],
      env: { OBSIDIAN_VAULT_PATH: vaultWindowsPath },
    },
  };
}
