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
