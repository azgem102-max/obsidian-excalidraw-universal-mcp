import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(currentDirectory, "..", "server.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function nextLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

test("MCP protocol lists tools and proxies a bridge call", async (context) => {
  const token = "a".repeat(64);
  const bridge = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        result: { method: payload.method, activeDrawing: "Test.excalidraw.md" },
      }),
    );
  });
  const address = await listen(bridge);
  context.after(() => bridge.close());

  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-excalidraw-mcp-"));
  context.after(() => fs.rm(vault, { recursive: true, force: true }));
  const dataDirectory = path.join(vault, ".obsidian", "plugins", "obsidian-excalidraw-mcp-bridge");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(
    path.join(dataDirectory, "data.json"),
    JSON.stringify({ token, port: address.port }),
    "utf8",
  );

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })}\n`,
  );
  const initialized = JSON.parse(await nextLine(child.stdout));
  assert.equal(initialized.result.serverInfo.name, "excalidraw-universal-mcp");

  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
  );
  const listed = JSON.parse(await nextLine(child.stdout));
  assert.ok(listed.result.tools.some((tool) => tool.name === "run_script"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "create_element"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_canvas_screenshot"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "create_note"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_backlinks"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_vault_structure"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "create_drop_shadow"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "set_pen"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "insert_library_item"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "save_elements_to_library"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "create_transclusion"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "inspect_visual_quality"));
  assert.equal(listed.result.tools.length, 59);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    })}\n`,
  );
  const called = JSON.parse(await nextLine(child.stdout));
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.method, "status");
  assert.equal(called.result.structuredContent.activeDrawing, "Test.excalidraw.md");
});
