#!/usr/bin/env node

/**
 * Completes live acceptance coverage for the remaining bridge/MCP tools.
 *
 * It is safe to run against a real vault because it creates one synthetic drawing
 * under `MCP Acceptance Lab/<run-id>/Tool Coverage`, never deletes vault files,
 * and restores the drawing immediately after testing clear_canvas.
 *
 * export_to_excalidraw_url is deliberately opt-in because it uploads the current
 * synthetic scene to excalidraw.com. It is never called without
 * --include-external-share.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BRIDGE_ID = "obsidian-excalidraw-mcp-bridge";
const EXPECTED_VERSION = "0.6.0";

function argumentsMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRunId(value) {
  const id = String(value || "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-");
  if (!id || id === "." || id === "..") throw new Error("--run-id must be a safe, non-empty name.");
  return id.slice(0, 96);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function activeElements(scene) {
  return (scene.elements || []).filter((element) => !element.isDeleted);
}

const args = argumentsMap(process.argv.slice(2));
if (!args.vault || !args.output || !args["run-id"]) {
  process.stderr.write("Usage: node tests/tool-coverage-live-acceptance.mjs --vault <path> --output <folder> --run-id <safe-name> [--include-external-share]\n");
  process.exit(2);
}

const vault = path.resolve(args.vault);
const output = path.resolve(args.output);
const runId = safeRunId(args["run-id"]);
const sandboxRoot = `MCP Acceptance Lab/${runId}/Tool Coverage`;
const sandboxOnDisk = path.join(vault, ...sandboxRoot.split("/"));
const report = {
  startedAt: new Date().toISOString(),
  runId,
  vault,
  sandboxRoot,
  bridge: null,
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
  safety: {
    syntheticSceneOnly: true,
    deletesVaultFiles: false,
    clearCanvasRestoredFromSnapshot: true,
    externalShareEnabled: args["include-external-share"] === true,
  },
};

await fs.mkdir(output, { recursive: true });
try {
  await fs.access(sandboxOnDisk);
  throw new Error(`The isolated run folder already exists: ${sandboxRoot}. Choose a new --run-id; this runner never overwrites prior runs.`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

let settings;
try {
  settings = JSON.parse(await fs.readFile(path.join(vault, ".obsidian", "plugins", BRIDGE_ID, "data.json"), "utf8"));
} catch (error) {
  report.failed += 1;
  report.tests.push({ name: "read bridge settings", status: "failed", durationMs: 0, error: error.message });
}
const endpoint = settings ? `http://127.0.0.1:${settings.port}/rpc` : null;

async function rpc(method, params = {}, timeout = 45_000) {
  if (!endpoint) throw new Error("Bridge settings are unavailable.");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const error = new Error(`${body?.error?.code || response.status}: ${body?.error?.message || "RPC failed"}`);
    error.details = body?.error?.details;
    throw error;
  }
  return body.result;
}

async function test(name, action) {
  const started = Date.now();
  try {
    const evidence = await action();
    const status = evidence?.skipped ? "skipped" : "passed";
    report[status] += 1;
    report.tests.push({ name, status, durationMs: Date.now() - started, evidence });
    return evidence;
  } catch (error) {
    report.failed += 1;
    report.tests.push({ name, status: "failed", durationMs: Date.now() - started, error: error.message, details: error.details });
    return null;
  }
}

async function captureScreenshot(filename) {
  const screenshot = await rpc("get_canvas_screenshot", { background: true, scale: 1 });
  assert(screenshot?.data, "No screenshot data was returned.");
  await fs.writeFile(path.join(output, filename), Buffer.from(screenshot.data, "base64"));
  return { file: filename, elementCount: screenshot.elementCount };
}

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline).trim());
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("MCP server closed before returning a response."));
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
  });
}

/** Calls a server-owned MCP tool; bridge-owned tools continue to use the local bridge RPC. */
async function mcpToolCall(name, toolArguments = {}) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const server = spawn(process.execPath, [path.join(packageRoot, "server.mjs"), `--vault=${vault}`], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const errors = [];
  server.stderr.on("data", (chunk) => errors.push(chunk.toString()));
  const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tool-coverage-live-acceptance", version: "1" } } });
    const initialized = JSON.parse(await readLine(server.stdout));
    assert(initialized.id === 1 && initialized.result, "MCP initialize did not succeed.");
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: toolArguments } });
    const response = JSON.parse(await readLine(server.stdout));
    assert(response.id === 2 && response.result, `MCP tool call failed: ${response.error?.message || "unknown error"}`);
    const text = response.result.content?.find((item) => item.type === "text")?.text;
    if (response.result.isError) throw new Error(text || `MCP tool ${name} failed.`);
    try {
      return JSON.parse(text || "{}");
    } catch {
      throw new Error(`MCP tool ${name} returned non-JSON text: ${text || "<empty>"}`);
    }
  } finally {
    server.kill();
    if (errors.length) report.externalServerStderr = errors.join("").trim();
  }
}

async function mcpExternalShare() {
  const result = await mcpToolCall("export_to_excalidraw_url");
  assert(typeof result.url === "string" && result.url.startsWith("https://excalidraw.com/"), "The external-share response did not contain an Excalidraw URL.");
  return { url: result.url };
}

const bridgeStatus = await test("bridge status", async () => {
  const status = await rpc("status");
  assert(status.bridgeVersion === EXPECTED_VERSION, `Expected bridge ${EXPECTED_VERSION}, received ${status.bridgeVersion || "unknown"}.`);
  report.bridge = status;
  return { bridgeVersion: status.bridgeVersion, activeDrawing: status.activeDrawing };
});

if (bridgeStatus) {
  const drawingPath = `${sandboxRoot}/tool-coverage-${runId}.excalidraw.md`;
  await test("create isolated synthetic drawing", async () => {
    await rpc("create_drawing", { filename: `tool-coverage-${runId}`, foldername: sandboxRoot, open: true, plaintext: "Synthetic MCP tool coverage only. No personal data." });
    await sleep(500);
    const scene = await rpc("get_scene");
    assert(scene.path === drawingPath, "The active drawing is outside the isolated tool-coverage folder.");
    assert(scene.elementCount === 0, "The synthetic drawing is not empty at creation.");
    return { path: scene.path };
  });

  await test("list_drawings", async () => {
    const value = await rpc("list_drawings", { folder: sandboxRoot, query: `tool-coverage-${runId}` });
    assert(value.drawings.some((drawing) => drawing.path === drawingPath), "list_drawings did not return the isolated drawing.");
    return { count: value.count, drawingPath };
  });

  await test("create_element and get_element", async () => {
    const created = await rpc("create_element", { id: "coverage-card", type: "rectangle", x: 80, y: 100, width: 260, height: 140, backgroundColor: "#dbeafe", strokeColor: "#2563eb", fillStyle: "solid", roughness: 0 });
    assert(created.element?.id === "coverage-card", "create_element did not return the requested id.");
    const fetched = await rpc("get_element", { id: "coverage-card" });
    assert(fetched.element?.type === "rectangle" && fetched.element.width === 260, "get_element did not return the created rectangle.");
    return { id: fetched.element.id, type: fetched.element.type, width: fetched.element.width };
  });

  await test("create second element and select_elements", async () => {
    await rpc("create_element", { id: "cover001", type: "text", x: 115, y: 145, text: "اختبار تغطية الأدوات", fontSize: 24, fontFamily: 4, strokeColor: "#172554" });
    const selection = await rpc("select_elements", { elementIds: ["coverage-card", "cover001"] });
    assert(selection.selectedElementIds.length === 2, "select_elements did not report both selected ids.");
    const scene = await rpc("get_scene");
    const selected = Object.keys(scene.appState.selectedElementIds || {});
    assert(selected.includes("coverage-card") && selected.includes("cover001"), "Selection is not present in the scene app state.");
    return { selected };
  });

  await test("describe_scene", async () => {
    const description = await rpc("describe_scene");
    assert(description.types?.rectangle === 1 && description.types?.text === 1, "describe_scene returned incorrect element counts.");
    assert(description.description.includes("coverage-card") && description.description.includes("اختبار تغطية الأدوات"), "describe_scene did not describe the synthetic elements.");
    return { types: description.types, boundingBox: description.boundingBox };
  });

  await test("read_diagram_guide", async () => {
    const guide = await mcpToolCall("read_diagram_guide");
    assert(typeof guide.guide === "string" && guide.guide.length > 120, "The diagram guide is missing or unexpectedly short.");
    return { characters: guide.guide.length };
  });

  await test("delete_element", async () => {
    await rpc("create_element", { id: "delete-target", type: "ellipse", x: 420, y: 120, width: 100, height: 100, backgroundColor: "#fee2e2", strokeColor: "#dc2626" });
    const deleted = await rpc("delete_element", { id: "delete-target" });
    assert(deleted.deleted === true, "delete_element did not confirm deletion.");
    const scene = await rpc("get_scene");
    assert(!activeElements(scene).some((element) => element.id === "delete-target"), "Deleted element is still active in the scene.");
    try {
      await rpc("get_element", { id: "delete-target" });
    } catch (error) {
      assert(error.message.includes("ELEMENT_NOT_FOUND"), `Unexpected get_element result after deletion: ${error.message}`);
      return { id: "delete-target", absentAfterDeletion: true };
    }
    throw new Error("get_element unexpectedly returned a deleted element.");
  });

  const snapshotName = `tool-coverage-${runId}`;
  await test("snapshot_scene before clear_canvas", async () => {
    const snapshot = await rpc("snapshot_scene", { name: snapshotName });
    assert(snapshot.elementCount === 2, `Expected two active elements in snapshot, received ${snapshot.elementCount}.`);
    return snapshot;
  });

  await test("clear_canvas then restore_snapshot", async () => {
    await rpc("clear_canvas");
    const cleared = await rpc("get_scene");
    assert(cleared.elementCount === 0, "clear_canvas did not empty the synthetic scene.");
    const restored = await rpc("restore_snapshot", { name: snapshotName });
    assert(restored.elementCount === 2, `restore_snapshot did not restore the expected element count: ${restored.elementCount}.`);
    const scene = await rpc("get_scene");
    const ids = activeElements(scene).map((element) => element.id);
    assert(ids.includes("coverage-card") && ids.includes("cover001"), "The original synthetic elements were not restored.");
    const screenshot = await captureScreenshot("tool-coverage-restored.png");
    return { restoredIds: ids, screenshot };
  });

  if (args["include-external-share"] === true) {
    await test("export_to_excalidraw_url (synthetic scene only)", mcpExternalShare);
  } else {
    await test("export_to_excalidraw_url", async () => ({
      skipped: true,
      reason: "External sharing is disabled. Re-run with --include-external-share to upload only this synthetic drawing.",
    }));
  }
}

report.finishedAt = new Date().toISOString();
report.total = report.tests.length;
await fs.writeFile(path.join(output, "tool-coverage-live-acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.passed, failed: report.failed, skipped: report.skipped, total: report.total, output, sandboxRoot }, null, 2)}\n`);
process.exitCode = report.failed ? 1 : 0;
