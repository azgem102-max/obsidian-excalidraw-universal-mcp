import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("portable package contains AI entrypoints and pinned official plugins", async () => {
  for (const name of ["START-HERE-AR.md", "AGENTS.md", "CLAUDE.md", "doctor.mjs", "install-on-windows.ps1", "setup-windows.cmd", "plugin-versions.json"]) {
    await fs.access(path.join(root, name));
  }
  const lock = JSON.parse(await fs.readFile(path.join(root, "plugin-versions.json"), "utf8"));
  assert.deepEqual(lock.plugins.map((plugin) => plugin.id), ["obsidian-excalidraw-plugin", "excalidraw-extras"]);
  assert.equal(lock.plugins[0].version, "2.25.3");
  assert.equal(lock.plugins[1].version, "0.0.15");
});

test("portable installer builds an isolated vault and project config without network", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-ai-kit-"));
  const vault = path.join(temporary, "Vault");
  const project = path.join(temporary, "Project");
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(root, "install.mjs"), "--vault", vault, "--clients", "project",
      "--project-root", project, "--skip-official", "--offline",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.bridge.version, "0.5.3");
    assert.equal(result.content.baseFileCount, 34);
    assert.equal(result.content.professionalFileCount, 15);
    const config = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
    assert.equal(config.mcpServers.excalidraw.env.OBSIDIAN_VAULT_PATH, vault);
    assert.equal((await fs.readdir(path.join(vault, "Excalidraw", "Scripts", "أدوات التخطيط"))).filter((name) => name.endsWith(".md")).length, 17);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("the public package does not redistribute font binaries", async () => {
  const fontDirectory = path.join(root, "assets", "fonts");
  const files = await fs.readdir(fontDirectory);
  assert.deepEqual(files, ["README.md"]);
});

test("Windows helper uses Windows Node and remains compatible with legacy PowerShell decoding", async () => {
  const helper = await fs.readFile(path.join(root, "install-on-windows.ps1"), "utf8");
  assert.match(helper, /Find-NodeCommand/);
  assert.match(helper, /Select-ObsidianVault/);
  assert.match(helper, /nodeMajor -lt 18/);
  assert.match(helper, /--project-root/);
  assert.match(helper, /install\.mjs/);
  assert.doesNotMatch(helper, /[^\x00-\x7F]/);
});

test("one-click Windows setup is self-contained and asks before installing Node", async () => {
  const helper = await fs.readFile(path.join(root, "setup-windows.cmd"), "utf8");
  assert.match(helper, /install-on-windows\.ps1/);
  assert.match(helper, /ExecutionPolicy Bypass/);
  assert.match(helper, /choice \/C YN/);
  assert.match(helper, /OpenJS\.NodeJS\.LTS/);
  assert.match(helper, /process\.versions\.node/);
  assert.match(helper, /--accept-package-agreements/);
  assert.doesNotMatch(helper, /[^\x00-\x7F]/);
});

test("doctor rejects a stale live bridge until Obsidian is restarted", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-doctor-"));
  const vault = path.join(temporary, "Vault");
  const obsidian = path.join(vault, ".obsidian");
  const token = "a".repeat(64);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { bridgeVersion: "0.5.2" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    for (const [id, version] of [
      ["obsidian-excalidraw-plugin", "2.25.3"],
      ["excalidraw-extras", "0.0.15"],
      ["obsidian-excalidraw-mcp-bridge", "0.5.3"],
    ]) {
      const directory = path.join(obsidian, "plugins", id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ id, version }));
    }
    await fs.writeFile(path.join(obsidian, "community-plugins.json"), JSON.stringify([
      "obsidian-excalidraw-plugin", "excalidraw-extras", "obsidian-excalidraw-mcp-bridge",
    ]));
    await fs.writeFile(
      path.join(obsidian, "plugins", "obsidian-excalidraw-mcp-bridge", "data.json"),
      JSON.stringify({ token, port }),
    );
    for (const [folder, count] of [["أدوات التخطيط", 17], ["الحزمة الاحترافية", 15]]) {
      const directory = path.join(vault, "Excalidraw", "Scripts", folder);
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(Array.from({ length: count }, (_, index) => fs.writeFile(path.join(directory, `${index}.md`), "")));
    }

    let failure;
    try {
      await execFileAsync(process.execPath, [path.join(root, "doctor.mjs"), "--vault", vault, "--json"]);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "doctor should exit non-zero for a stale live bridge");
    const report = JSON.parse(failure.stdout);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((check) => check.name === "bridge:live").ok, false);
    assert.match(report.next, /أعد تشغيل Obsidian/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
