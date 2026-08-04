import assert from "node:assert/strict";
import test from "node:test";

import {
  isWslEnvironment,
  localPathInput,
  resolveWslClaudeDesktopTarget,
  shouldBlockCrossHostClaudeDesktop,
  windowsPathToWsl,
  wslPathToWindows,
  discoverWindowsClaudeConfigs,
} from "../platform-paths.mjs";

test("WSL is distinguished from ordinary Linux", () => {
  assert.equal(isWslEnvironment({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "linux" }), true);
  assert.equal(isWslEnvironment({ platform: "linux", env: {}, release: "5.15.90-microsoft-standard-WSL2" }), true);
  assert.equal(isWslEnvironment({ platform: "linux", env: {}, release: "6.8.0-generic" }), false);
});

test("Windows and mounted WSL paths convert without losing spaces or Arabic text", () => {
  const windowsPath = "C:\\Users\\name\\Desktop\\مشاريع\\Obsidian Vault";
  const wslPath = "/mnt/c/Users/name/Desktop/مشاريع/Obsidian Vault";
  assert.equal(windowsPathToWsl(windowsPath), wslPath);
  assert.equal(wslPathToWindows(wslPath), windowsPath);
  assert.equal(localPathInput(windowsPath, { wsl: true }), wslPath);
});

test("Claude Desktop receives Windows-native MCP paths when installer runs in WSL", () => {
  const target = resolveWslClaudeDesktopTarget({
    sourceRoot: "/mnt/c/Users/name/repo",
    vaultPath: "/mnt/d/Notes/Obsidian Vault",
    windowsAppData: "C:\\Users\\name\\AppData\\Roaming",
    windowsNode: "C:\\Program Files\\nodejs\\node.exe",
  });
  assert.equal(target.configAccessPath, "/mnt/c/Users/name/AppData/Roaming/Claude/claude_desktop_config.json");
  assert.equal(target.configDisplayPath, "C:\\Users\\name\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
  assert.equal(target.serverConfig.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(target.serverConfig.args, ["C:\\Users\\name\\repo\\server.mjs"]);
  assert.equal(target.serverConfig.env.OBSIDIAN_VAULT_PATH, "D:\\Notes\\Obsidian Vault");
});

test("Linux-only paths fail before Claude Desktop receives an invalid config", () => {
  assert.throws(
    () => wslPathToWindows("/home/name/repo/server.mjs"),
    /mounted Windows drive/,
  );
});

test("a separate Linux agent cannot silently configure Windows Claude Desktop", () => {
  assert.equal(shouldBlockCrossHostClaudeDesktop({
    platform: "linux",
    wsl: false,
    claudeDesktopSelected: true,
    explicitConfig: false,
  }), true);
  assert.equal(shouldBlockCrossHostClaudeDesktop({
    platform: "linux",
    wsl: true,
    claudeDesktopSelected: true,
    explicitConfig: false,
  }), false);
  assert.equal(shouldBlockCrossHostClaudeDesktop({
    platform: "linux",
    wsl: false,
    claudeDesktopSelected: true,
    explicitConfig: true,
  }), false);
});

test("discoverWindowsClaudeConfigs finds the MSIX config the Store build actually reads", () => {
  // نسخة المتجر تعزل إعدادها داخل Packages\Claude_*، فالكتابة في
  // AppData\Roaming\Claude لا تصل إليها — وكان المثبّت يطبع "تم" بلا أثر.
  const files = new Map([
    ["C:\\U\\AppData\\Local\\Packages\\Claude_abc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json", '{"mcpServers":{}}'],
    ["C:\\U\\AppData\\Roaming\\Claude\\claude_desktop_config.json", "{}"],
  ]);
  const fakeFs = {
    existsSync: (target) => files.has(target),
    readFileSync: (target) => files.get(target),
    readdirSync: () => [
      { name: "Claude_abc", isDirectory: () => true },
      { name: "SomethingElse", isDirectory: () => true },
    ],
  };
  const found = discoverWindowsClaudeConfigs({
    fs: fakeFs,
    localAppData: "C:\\U\\AppData\\Local",
    appData: "C:\\U\\AppData\\Roaming",
    platform: "win32",
  });
  assert.equal(found.length, 2, "both the MSIX and the classic path must be reported");
  assert.equal(found[0].kind, "msix", "the file that actually holds mcpServers comes first");
  assert.equal(found[0].hasMcpServers, true);
  assert.equal(found[1].kind, "classic");
});

test("discoverWindowsClaudeConfigs stays silent off Windows", () => {
  assert.deepEqual(discoverWindowsClaudeConfigs({ fs: {}, platform: "linux" }), []);
});

test("fresh Windows setup creates the MSIX config when the Store package exists", () => {
  const fakeFs = {
    existsSync: () => false,
    readFileSync: () => "",
    readdirSync: () => [{ name: "Claude_store", isDirectory: () => true }],
  };
  const found = discoverWindowsClaudeConfigs({
    fs: fakeFs,
    localAppData: "C:\\U\\AppData\\Local",
    appData: "C:\\U\\AppData\\Roaming",
    platform: "win32",
    includeMissing: true,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "msix-new");
  assert.equal(found[0].exists, false);
  assert.match(found[0].path, /LocalCache\\Roaming\\Claude\\claude_desktop_config\.json$/);
});

test("fresh classic Windows setup keeps the one-click config path", () => {
  const fakeFs = {
    existsSync: () => false,
    readFileSync: () => "",
    readdirSync: () => [],
  };
  const found = discoverWindowsClaudeConfigs({
    fs: fakeFs,
    localAppData: "C:\\U\\AppData\\Local",
    appData: "C:\\U\\AppData\\Roaming",
    platform: "win32",
    includeMissing: true,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "classic-new");
  assert.match(found[0].path, /AppData\\Roaming\\Claude\\claude_desktop_config\.json$/);
});
