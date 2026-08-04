const http = require("http");
const crypto = require("crypto");
const { Plugin, TFile, Notice, normalizePath, stringifyYaml, parseYaml } = require("obsidian");

const PLUGIN_ID = "obsidian-excalidraw-mcp-bridge";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const EXCALIDRAW_EXTRAS_PLUGIN_ID = "excalidraw-extras";
const DEFAULT_PORT = 27125;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 30_000;
const SCRIPT_EXTENSIONS = new Set(["md", "js", "txt"]);

class BridgeError extends Error {
  constructor(message, code = "BRIDGE_ERROR", details) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function serializable(value) {
  if (value === undefined) return null;
  try {
    return jsonClone(value);
  } catch {
    return String(value);
  }
}

function asArray(value, label) {
  if (!Array.isArray(value)) {
    throw new BridgeError(`${label} يجب أن تكون مصفوفة`, "INVALID_ARGUMENT");
  }
  return value;
}

function safePath(value, label = "path") {
  if (typeof value !== "string" || !value.trim()) {
    throw new BridgeError(`${label} مطلوب`, "INVALID_ARGUMENT");
  }
  const normalized = normalizePath(value.trim().replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === "..") {
    throw new BridgeError(`${label} يجب أن يبقى داخل الـVault`, "INVALID_ARGUMENT");
  }
  return normalized;
}

function randomId() {
  // Match Excalidraw's native eight-character IDs. Long prefixed IDs can be
  // re-keyed by Obsidian's parsed-text layer and leave duplicate block entries.
  const alphabet = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return [...crypto.randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function pointTuple(point) {
  return Array.isArray(point)
    ? [Number(point[0]), Number(point[1])]
    : [Number(point.x), Number(point.y)];
}

function nestedValue(object, dottedKey) {
  return String(dottedKey)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), object);
}

class ObsidianExcalidrawMcpBridge extends Plugin {
  async onload() {
    const stored = (await this.loadData()) || {};
    this.settings = {
      port: Number.isInteger(stored.port) ? stored.port : DEFAULT_PORT,
      token:
        typeof stored.token === "string" && stored.token.length >= 32
          ? stored.token
          : crypto.randomBytes(32).toString("hex"),
    };
    await this.saveData(this.settings);

    this.operationQueue = Promise.resolve();
    this.snapshots = new Map();
    this.server = http.createServer((request, response) => {
      this.handleHttpRequest(request, response).catch((error) => {
        this.writeError(response, error, 500);
      });
    });

    this.server.on("error", (error) => {
      console.error(`[${PLUGIN_ID}] server error`, error);
      new Notice(`تعذر تشغيل جسر Excalidraw MCP على المنفذ ${this.settings.port}`);
    });

    this.server.listen(this.settings.port, "127.0.0.1", () => {
      console.info(`[${PLUGIN_ID}] listening on http://127.0.0.1:${this.settings.port}`);
    });

    this.register(() => {
      if (this.server) this.server.close();
    });
  }

  onunload() {
    if (this.server) this.server.close();
  }

  async handleHttpRequest(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      return this.writeJson(response, 200, {
        ok: true,
        plugin: PLUGIN_ID,
        version: this.manifest.version,
      });
    }

    if (request.method !== "POST" || request.url !== "/rpc") {
      return this.writeJson(response, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "المسار غير موجود" },
      });
    }

    const expected = `Bearer ${this.settings.token}`;
    if (request.headers.authorization !== expected) {
      return this.writeJson(response, 401, {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "رمز الجسر غير صحيح" },
      });
    }

    let payload;
    try {
      payload = JSON.parse(await this.readBody(request));
    } catch (error) {
      return this.writeError(response, error, 400);
    }

    if (!payload || typeof payload.method !== "string") {
      return this.writeError(response, new BridgeError("method مطلوب", "INVALID_REQUEST"), 400);
    }

    try {
      const result = await this.enqueue(() => this.dispatch(payload.method, payload.params || {}));
      return this.writeJson(response, 200, { ok: true, result });
    } catch (error) {
      return this.writeError(response, error, 400);
    }
  }

  enqueue(operation) {
    const runWithTimeout = () => {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new BridgeError("انتهت مهلة العملية داخل Obsidian", "OPERATION_TIMEOUT")),
          OPERATION_TIMEOUT_MS,
        );
      });
      return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => {
        clearTimeout(timeoutId);
      });
    };
    const next = this.operationQueue.then(runWithTimeout, runWithTimeout);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new BridgeError("حجم الطلب أكبر من الحد", "BODY_TOO_LARGE"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  writeJson(response, statusCode, body) {
    if (response.headersSent) return;
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
  }

  writeError(response, error, statusCode) {
    const normalized =
      error instanceof BridgeError
        ? error
        : new BridgeError(error?.message || String(error), "INTERNAL_ERROR");
    console.error(`[${PLUGIN_ID}]`, normalized);
    this.writeJson(response, statusCode, {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    });
  }

  getExcalidrawPlugin() {
    const plugin = this.app.plugins?.plugins?.[EXCALIDRAW_PLUGIN_ID];
    if (!plugin) {
      throw new BridgeError("إضافة Excalidraw غير محملة داخل Obsidian", "EXCALIDRAW_NOT_LOADED");
    }
    return plugin;
  }

  getExcalidrawExtrasStatus() {
    const manifest = this.app.plugins?.manifests?.[EXCALIDRAW_EXTRAS_PLUGIN_ID];
    const plugin = this.app.plugins?.plugins?.[EXCALIDRAW_EXTRAS_PLUGIN_ID];
    return {
      installed: Boolean(manifest),
      enabled: Boolean(plugin),
      version: manifest?.version || null,
    };
  }

  requireExcalidrawExtras(component) {
    const status = this.getExcalidrawExtrasStatus();
    if (!status.installed || !status.enabled) {
      throw new BridgeError(
        `ميزة ${component} تحتاج إضافة Excalidraw Extras الرسمية وتفعيلها داخل Obsidian`,
        "EXCALIDRAW_EXTRAS_REQUIRED",
        { component, ...status },
      );
    }
    return this.app.plugins.plugins[EXCALIDRAW_EXTRAS_PLUGIN_ID];
  }

  getGlobalEA() {
    const ea = globalThis.ExcalidrawAutomate;
    if (!ea) {
      throw new BridgeError(
        "ExcalidrawAutomate غير متاح. افتح رسمًا واحدًا ثم أعد المحاولة",
        "EA_NOT_AVAILABLE",
      );
    }
    return ea;
  }

  getActiveContext() {
    const ea = this.getGlobalEA();
    const view = ea.setView("active") || ea.setView("first");
    if (!view) {
      throw new BridgeError("لا يوجد رسم Excalidraw مفتوح", "NO_ACTIVE_DRAWING");
    }
    const api = ea.getExcalidrawAPI();
    if (!api) {
      throw new BridgeError("واجهة الرسم غير جاهزة", "API_NOT_READY");
    }
    return { ea, view, api };
  }

  prepareWorkbenchForAppend(ea) {
    // The EA workbench is separate from the visible scene. Retain the existing
    // non-text elements so a later save cannot discard special additions such
    // as images, frames, embeds, or LaTeX. Existing text must stay out of the
    // workbench: addElementsToView serializes Text Elements independently and
    // re-entering them corrupts text on a later Mermaid/text append.
    const persistentElements = ea
      .getViewElements()
      .filter((element) => !element.isDeleted && element.type !== "text");
    ea.clear();
    ea.copyViewElementsToEAforEditing(persistentElements, true);
    return persistentElements;
  }

  getFile(pathValue, label = "path") {
    const path = safePath(pathValue, label);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new BridgeError(`الملف غير موجود: ${path}`, "FILE_NOT_FOUND");
    }
    return file;
  }

  async dispatch(method, params) {
    switch (method) {
      case "status":
        return this.status();
      case "list_drawings":
        return this.listDrawings(params);
      case "open_drawing":
        return this.openDrawing(params);
      case "create_drawing":
        return this.createDrawing(params);
      case "list_notes":
        return this.listNotes(params);
      case "read_note":
        return this.readNote(params);
      case "create_note":
        return this.createNote(params);
      case "update_note":
        return this.updateNote(params);
      case "move_note":
        return this.moveNote(params);
      case "trash_note":
        return this.trashNote(params);
      case "search_notes":
        return this.searchNotes(params);
      case "get_backlinks":
        return this.getBacklinks(params);
      case "get_vault_structure":
        return this.getVaultStructure(params);
      case "search_vault_images":
        return this.searchVaultImages(params);
      case "set_drawing_frontmatter":
        return this.setDrawingFrontmatter(params);
      case "create_obsidian_link":
        return this.createObsidianLink(params);
      case "create_transclusion":
        return this.createTransclusion(params);
      case "search_library":
        return this.searchLibrary(params);
      case "save_elements_to_library":
        return this.saveElementsToLibrary(params);
      case "insert_library_item":
        return this.insertLibraryItem(params);
      case "get_scene":
        return this.getScene();
      case "get_element":
        return this.getElement(params);
      case "query_elements":
        return this.queryElements(params);
      case "create_element":
        return this.createElement(params);
      case "batch_create_elements":
        return this.batchCreateElements(params);
      case "update_element":
        return this.updateElement(params);
      case "delete_element":
        return this.deleteElement(params);
      case "duplicate_elements":
        return this.duplicateElements(params);
      case "align_elements":
        return this.alignElements(params);
      case "distribute_elements":
        return this.distributeElements(params);
      case "group_elements":
        return this.groupElements(params);
      case "ungroup_elements":
        return this.ungroupElements(params);
      case "lock_elements":
        return this.setElementsLocked(params, true);
      case "unlock_elements":
        return this.setElementsLocked(params, false);
      case "set_z_order":
        return this.setZOrder(params);
      case "apply_style_to_elements":
        return this.applyStyleToElements(params);
      case "create_drop_shadow":
        return this.createDropShadow(params);
      case "set_pen":
        return this.setPen(params);
      case "describe_scene":
        return this.describeScene();
      case "inspect_visual_quality":
        return this.inspectVisualQuality(params);
      case "get_canvas_screenshot":
        return this.getCanvasScreenshot(params);
      case "get_resource":
        return this.getResource(params);
      case "export_scene":
        return this.exportScene(params);
      case "import_scene":
        return this.importScene(params);
      case "export_to_image":
        return this.exportToImage(params);
      case "clear_canvas":
        return this.clearCanvas();
      case "snapshot_scene":
        return this.snapshotScene(params);
      case "restore_snapshot":
        return this.restoreSnapshot(params);
      case "set_viewport":
        return this.setViewport(params);
      case "create_from_mermaid":
        return this.createFromMermaid(params);
      case "add_image":
        return this.addImage(params);
      case "add_latex":
        return this.addLatex(params);
      case "add_embeddable":
        return this.addEmbeddable(params);
      case "add_frame":
        return this.addFrame(params);
      case "replace_scene":
        return this.replaceScene(params);
      case "append_scene":
        return this.appendScene(params);
      case "select_elements":
        return this.selectElements(params);
      case "patch_elements":
        return this.patchElements(params);
      case "delete_elements":
        return this.deleteElements(params);
      case "list_scripts":
        return this.listScripts(params);
      case "run_script":
        return this.runScript(params);
      case "save_drawing":
        return this.saveDrawing();
      case "export_image":
        return this.exportImage(params);
      default:
        throw new BridgeError(`طريقة غير مدعومة: ${method}`, "METHOD_NOT_FOUND");
    }
  }

  status() {
    const excalidraw = this.getExcalidrawPlugin();
    let activeDrawing = null;
    let elementCount = 0;
    try {
      const { ea, view } = this.getActiveContext();
      activeDrawing = view.file?.path || null;
      elementCount = ea.getViewElements().filter((element) => !element.isDeleted).length;
    } catch {
      // The bridge can be healthy before a drawing is opened.
    }
    return {
      bridgeVersion: this.manifest.version,
      excalidrawVersion: excalidraw.manifest?.version || null,
      excalidrawExtras: this.getExcalidrawExtrasStatus(),
      vaultName: this.app.vault.getName(),
      activeDrawing,
      elementCount,
      port: this.settings.port,
    };
  }

  listDrawings(params) {
    const prefix = params.folder ? `${safePath(params.folder, "folder").replace(/\/$/, "")}/` : "";
    const query = typeof params.query === "string" ? params.query.toLowerCase() : "";
    const files = this.app.vault
      .getFiles()
      .filter((file) => {
        const path = file.path.toLowerCase();
        const isDrawing = path.endsWith(".excalidraw.md") || path.endsWith(".excalidraw");
        return (
          isDrawing && (!prefix || file.path.startsWith(prefix)) && (!query || path.includes(query))
        );
      })
      .map((file) => ({ path: file.path, name: file.name, mtime: file.stat.mtime }));
    return { drawings: files, count: files.length };
  }

  async openDrawing(params) {
    const file = this.getFile(params.path);
    // مثل createDrawing: ورشة EA حالة عامة مشتركة. إن بقيت عناصر الرسم السابق
    // فيها سرّبتها عملية لاحقة إلى الرسم الجديد — وقد حدث ذلك فعلًا.
    try { this.getGlobalEA().clear(); } catch { /* EA غير متاح بعد */ }
    const leaf = this.app.workspace.getLeaf(params.newLeaf === true ? "tab" : false);
    await leaf.openFile(file, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const ea = this.getGlobalEA();
      ea.clear();
      ea.setView("active"); // اربط EA بالعرض الجديد صراحةً
    } catch { /* EA غير متاح بعد */ }
    const viewType = leaf.view?.getViewType?.();
    if (viewType !== "excalidraw") {
      throw new BridgeError(
        `فُتح الملف لكن العرض الحالي ليس Excalidraw: ${viewType || "unknown"}`,
        "VIEW_NOT_READY",
      );
    }
    return { path: file.path, viewType };
  }

  async createDrawing(params) {
    const ea = this.getGlobalEA();
    // ea.create() serializes the current EA workbench when no template is supplied.
    // Always start from an empty workbench so a new drawing cannot inherit elements
    // from the previously edited canvas.
    ea.clear();
    const filename =
      typeof params.filename === "string" && params.filename.trim()
        ? params.filename.trim()
        : undefined;
    const foldername =
      typeof params.foldername === "string" && params.foldername.trim()
        ? safePath(params.foldername, "foldername")
        : undefined;
    const createdPath = await ea.create({
      filename,
      foldername,
      templatePath: params.templatePath,
      onNewPane: params.open === true,
      silent: params.open !== true,
      frontmatterKeys: params.frontmatterKeys,
      plaintext: params.plaintext,
    });
    return { path: createdPath };
  }

  isRegularMarkdown(file) {
    return file instanceof TFile && file.extension === "md" && !file.path.endsWith(".excalidraw.md");
  }

  noteSummary(file) {
    const cache = this.app.metadataCache.getFileCache(file) || {};
    return {
      path: file.path,
      name: file.basename,
      size: file.stat.size,
      mtime: file.stat.mtime,
      tags: (cache.tags || []).map((tag) => tag.tag),
      frontmatter: cache.frontmatter ? jsonClone(cache.frontmatter) : {},
      headingCount: cache.headings?.length || 0,
      linkCount: (cache.links?.length || 0) + (cache.embeds?.length || 0),
    };
  }

  listNotes(params) {
    const prefix = params.folder ? `${safePath(params.folder, "folder").replace(/\/$/, "")}/` : "";
    const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
    const notes = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isRegularMarkdown(file))
      .filter((file) => (!prefix || file.path.startsWith(prefix)) && (!query || file.path.toLowerCase().includes(query)))
      .map((file) => this.noteSummary(file));
    return { notes, count: notes.length };
  }

  async readNote(params) {
    const file = this.getFile(params.path);
    if (!this.isRegularMarkdown(file)) {
      throw new BridgeError("المسار ليس ملاحظة Markdown عادية", "NOT_A_NOTE");
    }
    const content = await this.app.vault.read(file);
    const summary = this.noteSummary(file);
    // MetadataCache updates asynchronously after create/modify. Reading the YAML
    // directly keeps immediate MCP reads deterministic instead of returning stale
    // properties for a correctly-written note.
    if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (match) {
        try {
          summary.frontmatter = parseYaml(match[1]) || {};
        } catch {
          // Keep the cache result if a user-owned document contains invalid YAML.
        }
      }
    }
    return { ...summary, content };
  }

  async ensureFolderForPath(filePath) {
    const slash = filePath.lastIndexOf("/");
    if (slash < 0) return;
    const folderPath = filePath.slice(0, slash);
    if (!folderPath || this.app.vault.getAbstractFileByPath(folderPath)) return;
    await this.app.vault.createFolder(folderPath);
  }

  noteDocument(content, frontmatter) {
    const body = String(content || "");
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter) || !Object.keys(frontmatter).length) {
      return body;
    }
    return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}`;
  }

  async createNote(params) {
    let notePath = safePath(params.path);
    if (!notePath.toLowerCase().endsWith(".md")) notePath += ".md";
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing && params.overwrite !== true) {
      throw new BridgeError(`الملاحظة موجودة: ${notePath}`, "FILE_EXISTS");
    }
    await this.ensureFolderForPath(notePath);
    const document = this.noteDocument(params.content, params.frontmatter);
    const file = existing instanceof TFile
      ? (await this.app.vault.modify(existing, document), existing)
      : await this.app.vault.create(notePath, document);
    return { path: file.path, created: !existing, overwritten: Boolean(existing) };
  }

  async updateNote(params) {
    const file = this.getFile(params.path);
    if (!this.isRegularMarkdown(file)) throw new BridgeError("المسار ليس ملاحظة Markdown عادية", "NOT_A_NOTE");
    let content = await this.app.vault.read(file);
    if (params.content !== undefined) content = String(params.content);
    if (params.prepend) content = `${String(params.prepend)}${content}`;
    if (params.append) content = `${content}${String(params.append)}`;
    if (content !== await this.app.vault.read(file)) await this.app.vault.modify(file, content);
    if (params.frontmatter && typeof params.frontmatter === "object") {
      await this.app.fileManager.processFrontMatter(file, (data) => {
        for (const [key, value] of Object.entries(params.frontmatter)) {
          if (value === null) delete data[key];
          else data[key] = jsonClone(value);
        }
      });
    }
    return { path: file.path, updated: true };
  }

  async moveNote(params) {
    const file = this.getFile(params.path);
    let newPath = safePath(params.newPath, "newPath");
    if (!newPath.toLowerCase().endsWith(".md")) newPath += ".md";
    if (this.app.vault.getAbstractFileByPath(newPath)) throw new BridgeError(`الوجهة موجودة: ${newPath}`, "FILE_EXISTS");
    await this.ensureFolderForPath(newPath);
    // fileManager.renameFile يشغّل تحديث روابط الخزنة كلها؛ في خزنة كبيرة قد
    // يجمّد واجهة Obsidian فتتوقف كل عمليات الجسر خلفه في الطابور.
    const updateLinks = params.updateLinks !== false;
    if (updateLinks) await this.app.fileManager.renameFile(file, newPath);
    else await this.app.vault.rename(file, newPath);
    return { oldPath: params.path, path: newPath, moved: true, linksUpdated: updateLinks };
  }

  async trashNote(params) {
    const file = this.getFile(params.path);
    if (!this.isRegularMarkdown(file)) throw new BridgeError("المسار ليس ملاحظة Markdown عادية", "NOT_A_NOTE");
    await this.app.vault.trash(file, false);
    return { path: file.path, trashed: true, recoverable: true };
  }

  async searchNotes(params) {
    const query = String(params.query || "").trim().toLowerCase();
    if (!query) throw new BridgeError("query مطلوب", "INVALID_ARGUMENT");
    const prefix = params.folder ? `${safePath(params.folder, "folder").replace(/\/$/, "")}/` : "";
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
    const matches = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isRegularMarkdown(file) || (prefix && !file.path.startsWith(prefix))) continue;
      const content = await this.app.vault.cachedRead(file);
      const lower = content.toLowerCase();
      const index = lower.indexOf(query);
      if (index < 0 && !file.path.toLowerCase().includes(query)) continue;
      matches.push({
        path: file.path,
        name: file.basename,
        excerpt: index < 0 ? "" : content.slice(Math.max(0, index - 100), Math.min(content.length, index + query.length + 180)),
      });
      if (matches.length >= limit) break;
    }
    return { query: params.query, matches, count: matches.length };
  }

  getBacklinks(params) {
    const file = this.getFile(params.path);
    const links = [];
    const resolved = this.app.metadataCache.resolvedLinks || {};
    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (targets?.[file.path]) links.push({ sourcePath, count: targets[file.path] });
    }
    return { path: file.path, backlinks: links, count: links.length };
  }

  getVaultStructure(params) {
    const maxDepth = Math.max(1, Math.min(8, Number(params.maxDepth) || 4));
    const folders = new Map();
    for (const file of this.app.vault.getFiles()) {
      const parts = file.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= Math.min(parts.length, maxDepth); depth += 1) {
        const folder = parts.slice(0, depth).join("/");
        const entry = folders.get(folder) || { path: folder, notes: 0, drawings: 0, attachments: 0 };
        if (depth === parts.length) {
          if (file.path.endsWith(".excalidraw.md") || file.extension === "excalidraw") entry.drawings += 1;
          else if (file.extension === "md") entry.notes += 1;
          else entry.attachments += 1;
        }
        folders.set(folder, entry);
      }
    }
    return { folders: [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)), maxDepth };
  }

  searchVaultImages(params) {
    const query = String(params.query || "").toLowerCase();
    const prefix = params.folder ? `${safePath(params.folder, "folder").replace(/\/$/, "")}/` : "";
    const extensions = new Set((params.extensions || ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"]).map((item) => String(item).toLowerCase()));
    const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
    const images = this.app.vault.getFiles()
      .filter((file) => extensions.has(file.extension.toLowerCase()))
      .filter((file) => (!prefix || file.path.startsWith(prefix)) && (!query || file.path.toLowerCase().includes(query)))
      .slice(0, limit)
      .map((file) => ({ path: file.path, name: file.name, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime }));
    return { images, count: images.length };
  }

  async setDrawingFrontmatter(params) {
    const { view } = this.getActiveContext();
    const file = view.file;
    if (!(file instanceof TFile)) throw new BridgeError("ملف الرسم غير متاح", "FILE_NOT_FOUND");
    const properties = params.properties && typeof params.properties === "object" ? params.properties : {};
    await this.app.fileManager.processFrontMatter(file, (data) => {
      for (const [key, value] of Object.entries(properties)) {
        if (value === null) delete data[key];
        else data[key] = jsonClone(value);
      }
    });
    return { path: file.path, properties: Object.keys(properties), updated: true };
  }

  async createObsidianLink(params) {
    const target = this.getFile(params.filePath, "filePath");
    let destination = target.path.replace(/\.md$/i, "");
    if (params.heading) destination += `#${String(params.heading).replace(/^#/, "")}`;
    if (params.blockId) destination += `#^${String(params.blockId).replace(/^\^/, "")}`;
    const link = `[[${destination}${params.alias ? `|${params.alias}` : ""}]]`;
    await this.patchElements({ patches: [{ id: params.elementId, set: { link } }] });
    return { elementId: params.elementId, link, target: target.path };
  }

  async createTransclusion(params) {
    const target = this.getFile(params.filePath, "filePath");
    let destination = target.path.replace(/\.md$/i, "");
    if (params.heading) destination += `#${String(params.heading).replace(/^#/, "")}`;
    if (params.blockId) destination += `#^${String(params.blockId).replace(/^\^/, "")}`;
    const transclusionMarkup = `![[${destination}]]${params.wrapAt ? `{${Number(params.wrapAt)}}` : ""}`;
    const markdown = await this.app.vault.cachedRead(target);
    const visibleText = this.resolveTransclusionText(markdown, params);
    if (!visibleText) {
      throw new BridgeError("لم يُعثر على محتوى التضمين المطلوب", "TRANSCLUSION_TARGET_EMPTY", {
        target: target.path,
        heading: params.heading || null,
        blockId: params.blockId || null,
      });
    }
    const requestedId = typeof params.id === "string" && params.id ? params.id : randomId();
    const created = await this.createElement({
      id: requestedId,
      type: "text", x: params.x, y: params.y, text: visibleText,
      // Keep all text fields as display text. Assigning an Obsidian embed only
      // to rawText makes Excalidraw merge unrelated Text Elements on reopen.
      // The source markup and target stay in customData, which survives saves
      // without exposing a block id in the visible canvas text.
      rawText: visibleText, originalText: visibleText, wrapAt: params.wrapAt,
      link: `[[${destination}]]`,
      customData: {
        mcpTransclusion: {
          source: transclusionMarkup,
          target: target.path,
          heading: params.heading || null,
          blockId: params.blockId || null,
          wrapAt: params.wrapAt || null,
        },
      },
      fontSize: params.fontSize || 18, fontFamily: params.fontFamily || 4,
      strokeColor: params.strokeColor || "#334155",
    });
    await this.saveDrawing();
    return {
      element: created.element,
      requestedId,
      resolvedId: created.element.id,
      transclusion: transclusionMarkup,
      target: target.path,
    };
  }

  resolveTransclusionText(markdown, params) {
    const withoutFrontmatter = String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const lines = withoutFrontmatter.split(/\r?\n/);
    if (params.blockId) {
      const blockId = String(params.blockId).replace(/^\^/, "");
      const marker = new RegExp(`(?:^|\\s)\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
      const index = lines.findIndex((line) => marker.test(line));
      if (index < 0) return "";
      let start = index;
      while (start > 0 && lines[start - 1].trim() && !/^#{1,6}\s/.test(lines[start - 1])) start -= 1;
      return lines.slice(start, index + 1).join("\n").replace(marker, "").trim();
    }
    if (params.heading) {
      const wanted = String(params.heading).replace(/^#+\s*/, "").trim();
      const index = lines.findIndex((line) => {
        const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        return match && match[2].trim() === wanted;
      });
      if (index < 0) return "";
      const level = lines[index].match(/^#+/)[0].length;
      let end = index + 1;
      while (end < lines.length) {
        const next = lines[end].match(/^(#{1,6})\s+/);
        if (next && next[1].length <= level) break;
        end += 1;
      }
      return lines.slice(index + 1, end).join("\n").trim();
    }
    return withoutFrontmatter.trim();
  }

  async getLibraryItems() {
    const plugin = this.getExcalidrawPlugin();
    if (typeof plugin.getStencilLibrary === "function") {
      const library = plugin.getStencilLibrary();
      if (Array.isArray(library?.libraryItems)) return library.libraryItems;
    }
    const { api } = this.getActiveContext();
    return (await api.getLibraryItems?.()) || [];
  }

  async searchLibrary(params) {
    const query = String(params.query || "").toLowerCase();
    const items = await this.getLibraryItems();
    const matches = items
      .filter((item) => !query || String(item.name || "").toLowerCase().includes(query) || item.id.toLowerCase().includes(query))
      .map((item) => ({
        id: item.id,
        name: item.name || null,
        status: item.status,
        created: item.created,
        elementCount: item.elements?.length || 0,
        types: [...new Set((item.elements || []).map((element) => element.type))],
      }));
    return { items: matches, count: matches.length };
  }

  async saveElementsToLibrary(params) {
    const plugin = this.getExcalidrawPlugin();
    if (typeof plugin.getStencilLibrary !== "function" || typeof plugin.setStencilLibrary !== "function") {
      throw new BridgeError("واجهة مكتبة Excalidraw غير متاحة في هذه النسخة", "LIBRARY_NOT_SUPPORTED");
    }

    const selected = this.elementsByIds(params.elementIds);
    const selectedIds = new Set(selected.map((element) => element.id));
    const left = Math.min(...selected.map((element) => element.x));
    const top = Math.min(...selected.map((element) => element.y));
    const elements = selected.map((element) => {
      const clone = jsonClone(element);
      clone.x -= left;
      clone.y -= top;
      clone.isDeleted = false;
      if (clone.frameId && !selectedIds.has(clone.frameId)) clone.frameId = null;
      if (clone.containerId && !selectedIds.has(clone.containerId)) clone.containerId = null;
      clone.boundElements = (clone.boundElements || []).filter((bound) => selectedIds.has(bound.id));
      if (clone.startBinding?.elementId && !selectedIds.has(clone.startBinding.elementId)) clone.startBinding = null;
      if (clone.endBinding?.elementId && !selectedIds.has(clone.endBinding.elementId)) clone.endBinding = null;
      return clone;
    });
    const status = params.status === "unpublished" ? "unpublished" : "published";
    const item = {
      id: randomId(),
      name: String(params.name || "مكوّن MCP"),
      status,
      created: Date.now(),
      elements,
    };

    const library = jsonClone(plugin.getStencilLibrary());
    library.libraryItems = [...(library.libraryItems || []).filter((entry) => entry.id !== item.id), item];
    await plugin.setStencilLibrary(library);
    const stored = (await this.getLibraryItems()).find((entry) => entry.id === item.id);
    if (!stored) {
      throw new BridgeError("لم يؤكد Excalidraw حفظ المكوّن في المكتبة", "LIBRARY_SAVE_FAILED", { itemId: item.id });
    }
    return {
      item: {
        id: stored.id,
        name: stored.name || item.name,
        status: stored.status,
        created: stored.created,
        elementCount: stored.elements?.length || 0,
        types: [...new Set((stored.elements || []).map((element) => element.type))],
      },
    };
  }

  async insertLibraryItem(params) {
    const { ea } = this.getActiveContext();
    const items = await this.getLibraryItems();
    const item = items.find((entry) => entry.id === params.itemId);
    if (!item) throw new BridgeError(`عنصر المكتبة غير موجود: ${params.itemId}`, "LIBRARY_ITEM_NOT_FOUND");
    this.prepareWorkbenchForAppend(ea);
    const box = ea.getBoundingBox(item.elements);
    const scale = Number.isFinite(Number(params.scale)) ? Number(params.scale) : 1;
    const idMap = new Map();
    const groupMap = new Map();
    const clones = item.elements.map((element) => {
      const clone = ea.cloneElement(element);
      idMap.set(element.id, clone.id);
      for (const groupId of element.groupIds || []) if (!groupMap.has(groupId)) groupMap.set(groupId, randomId("group"));
      clone.x = Number(params.x) + (element.x - box.topX) * scale;
      clone.y = Number(params.y) + (element.y - box.topY) * scale;
      clone.width *= scale;
      clone.height *= scale;
      return { original: element, clone };
    });
    for (const { original, clone } of clones) {
      clone.groupIds = (original.groupIds || []).map((id) => groupMap.get(id));
      clone.containerId = idMap.get(original.containerId) || null;
      clone.frameId = idMap.get(original.frameId) || null;
      clone.boundElements = (original.boundElements || []).map((bound) => ({ ...bound, id: idMap.get(bound.id) || bound.id }));
      if (clone.startBinding?.elementId) clone.startBinding.elementId = idMap.get(clone.startBinding.elementId) || clone.startBinding.elementId;
      if (clone.endBinding?.elementId) clone.endBinding.elementId = idMap.get(clone.endBinding.elementId) || clone.endBinding.elementId;
      ea.elementsDict[clone.id] = clone;
    }
    await ea.addElementsToView(false, true, true);
    return { itemId: item.id, ids: clones.map(({ clone }) => clone.id), count: clones.length };
  }

  getScene() {
    const { ea, view, api } = this.getActiveContext();
    const appState = api.getAppState();
    const elements = ea.getViewElements().filter((element) => !element.isDeleted);
    return {
      path: view.file?.path || null,
      elements: jsonClone(elements),
      appState: jsonClone({
        viewBackgroundColor: appState.viewBackgroundColor,
        theme: appState.theme,
        gridSize: appState.gridSize,
        gridStep: appState.gridStep,
        gridModeEnabled: appState.gridModeEnabled,
        selectedElementIds: appState.selectedElementIds || {},
        zoom: appState.zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
      }),
      files: jsonClone(api.getFiles?.() || {}),
      elementCount: elements.length,
    };
  }

  getElement(params) {
    if (typeof params.id !== "string" || !params.id) {
      throw new BridgeError("id مطلوب", "INVALID_ARGUMENT");
    }
    const element = this.getScene().elements.find((item) => item.id === params.id);
    if (!element) throw new BridgeError(`العنصر غير موجود: ${params.id}`, "ELEMENT_NOT_FOUND");
    return { element };
  }

  queryElements(params) {
    const scene = this.getScene();
    const filter = params.filter && typeof params.filter === "object" ? params.filter : {};
    const bbox = params.bbox && typeof params.bbox === "object" ? params.bbox : null;
    const elements = scene.elements.filter((element) => {
      if (params.type && element.type !== params.type) return false;
      for (const [key, expected] of Object.entries(filter)) {
        if (nestedValue(element, key) !== expected) return false;
      }
      if (bbox) {
        const left = Number(element.x) || 0;
        const top = Number(element.y) || 0;
        const right = left + (Number(element.width) || 0);
        const bottom = top + (Number(element.height) || 0);
        if (bbox.x_min !== undefined && right < bbox.x_min) return false;
        if (bbox.x_max !== undefined && left > bbox.x_max) return false;
        if (bbox.y_min !== undefined && bottom < bbox.y_min) return false;
        if (bbox.y_max !== undefined && top > bbox.y_max) return false;
      }
      return true;
    });
    return { elements, count: elements.length, path: scene.path };
  }

  applyStyle(ea, params) {
    // ea.style حالة عامة تبقى بين النداءات: عنصر متقطع واحد كان يجعل كل ما بعده
    // متقطعًا بشفافية موروثة. أعِد الافتراضيات القياسية ثم طبّق المطلوب فقط.
    const canonical = {
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
    };
    for (const [key, value] of Object.entries(canonical)) {
      if (key in ea.style) ea.style[key] = value;
    }
    ea.style.startArrowHead = null;
    ea.style.endArrowHead = "arrow";
    const styleKeys = [
      "strokeColor",
      "backgroundColor",
      "fillStyle",
      "strokeWidth",
      "strokeStyle",
      "roughness",
      "opacity",
      "fontSize",
      "fontFamily",
      "textAlign",
      "verticalAlign",
      "roundness",
    ];
    for (const key of styleKeys) {
      if (params[key] !== undefined && key in ea.style) ea.style[key] = params[key];
    }
    if (params.startArrowhead !== undefined) ea.style.startArrowHead = params.startArrowhead;
    if (params.endArrowhead !== undefined) ea.style.endArrowHead = params.endArrowhead;
  }

  copyBindingTargetsToWorkbench(ea, params) {
    const ids = [params.startElementId, params.endElementId].filter(Boolean);
    if (!ids.length) return;
    const inWorkbench = new Set(ea.getElements().map((element) => element.id));
    const missingFromWorkbench = ids.filter((id) => !inWorkbench.has(id));
    if (!missingFromWorkbench.length) return;
    const viewElements = new Map(ea.getViewElements().map((element) => [element.id, element]));
    const missingFromView = missingFromWorkbench.filter((id) => !viewElements.has(id));
    if (missingFromView.length) {
      throw new BridgeError("عناصر الربط غير موجودة", "ELEMENT_NOT_FOUND", {
        missing: missingFromView,
      });
    }
    ea.copyViewElementsToEAforEditing(
      missingFromWorkbench.map((id) => viewElements.get(id)),
      true,
    );
  }

  async addElementToWorkbench(ea, params) {
    if (!params || typeof params !== "object" || typeof params.type !== "string") {
      throw new BridgeError("type مطلوب لكل عنصر", "INVALID_ARGUMENT");
    }
    const type = params.type;
    const x = Number(params.x) || 0;
    const y = Number(params.y) || 0;
    const parsedWidth = Number(params.width);
    const parsedHeight = Number(params.height);
    const width = Number.isFinite(parsedWidth) ? parsedWidth : 160;
    const height = Number.isFinite(parsedHeight) ? parsedHeight : 80;
    // Any id supplied by an MCP client is an alias, never a raw Excalidraw id.
    // Excalidraw for Obsidian stores text in a second Markdown section keyed by
    // native eight-character ids. Letting an arbitrary alias reach addText can
    // merge unrelated text blocks on save/reopen. The caller receives the real
    // identity through requestedId/resolvedId or idMappings.
    const id = randomId();
    this.applyStyle(ea, params);

    let createdId;
    if (["rectangle", "ellipse", "diamond", "blob"].includes(type) && params.text) {
      const box = type === "rectangle" ? "box" : type;
      createdId = ea.addText(
        x,
        y,
        String(params.text),
        {
          autoResize: false,
          width,
          height,
          textAlign: params.textAlign || "center",
          textVerticalAlign: params.verticalAlign || "middle",
          box,
          boxPadding: Number(params.boxPadding) || 0,
        },
        id,
      );
    } else if (type === "rectangle") {
      createdId = ea.addRect(x, y, width, height, id);
    } else if (type === "ellipse") {
      createdId = ea.addEllipse(x, y, width, height, id);
    } else if (type === "diamond") {
      createdId = ea.addDiamond(x, y, width, height, id);
    } else if (type === "blob") {
      createdId = ea.addBlob(x, y, width, height, id);
    } else if (type === "frame") {
      createdId = ea.addFrame(x, y, width, height, params.name || params.text, id);
    } else if (type === "text") {
      createdId = ea.addText(
        x,
        y,
        String(params.text || ""),
        {
          autoResize: params.autoResize !== false,
          width: params.width,
          height: params.height,
          textAlign: params.textAlign,
          textVerticalAlign: params.verticalAlign,
          wrapAt: params.wrapAt,
        },
        id,
      );
    } else if (type === "arrow" || type === "line" || type === "freedraw") {
      this.copyBindingTargetsToWorkbench(ea, params);
      const rawPoints = Array.isArray(params.points)
        ? params.points.map(pointTuple)
        : [
            [0, 0],
            [width || 100, height || 0],
          ];
      const absolutePoints = rawPoints.map(([px, py]) => [x + px, y + py]);
      if (type === "arrow") {
        createdId = ea.addArrow(
          absolutePoints,
          {
            startArrowHead: params.startArrowhead ?? null,
            endArrowHead: params.endArrowhead ?? "arrow",
            startObjectId: params.startElementId,
            endObjectId: params.endElementId,
          },
          id,
        );
      } else {
        createdId = ea.addLine(absolutePoints, id);
      }
      if (type === "freedraw") {
        const free = ea.getElement(createdId);
        free.type = "freedraw";
        free.pressures = Array.isArray(params.pressures) ? params.pressures.map(Number) : [];
        free.simulatePressure = params.simulatePressure !== false;
        free.strokeOptions = {
          variability: params.variability === "constant" ? "constant" : "variable",
          streamline: Number.isFinite(Number(params.streamline)) ? Number(params.streamline) : 0.5,
        };
        free.startBinding = null;
        free.endBinding = null;
        free.startArrowhead = null;
        free.endArrowhead = null;
      } else if (params.text) ea.addLabelToLine(createdId, String(params.text));
    } else if (type === "embeddable") {
      createdId = ea.addEmbeddable(x, y, width, height, params.url, undefined, params.customData);
    } else {
      throw new BridgeError(
        `نوع العنصر غير مدعوم مباشرة: ${type}. استخدم add_image أو add_latex أو سكربت Excalidraw للأنواع المتخصصة.`,
        "UNSUPPORTED_ELEMENT_TYPE",
      );
    }

    const element = ea.getElement(createdId);
    if (element) {
      const directKeys = [
        "link",
        "groupIds",
        "locked",
        "frameId",
        "customData",
        "angle",
        "opacity",
        "roundness",
        "elbowed",
        "rawText",
        "originalText",
      ];
      for (const key of directKeys) {
        if (params[key] !== undefined) element[key] = jsonClone(params[key]);
      }
    }
    return createdId;
  }

  async createElement(params) {
    const { ea } = this.getActiveContext();
    const previousIds = new Set(ea.getViewElements().filter((element) => !element.isDeleted).map((element) => element.id));
    this.prepareWorkbenchForAppend(ea);
    const id = await this.addElementToWorkbench(ea, params);
    const requestedId = typeof params.id === "string" && params.id ? params.id : null;
    const identity = requestedId && requestedId !== id ? { requestedId, resolvedId: id } : {};
    const warnings = params.type === "arrow" && !params.startElementId && !params.endElementId
      ? [{ code: "ARROW_WITHOUT_BINDING", message: "السهم غير مرتبط؛ لن يتبع الأشكال ولن يراه Auto Layout" }]
      : [];
    const warningResult = warnings.length ? { warnings } : {};
    const staged = ea.getElement(id) ? jsonClone(ea.getElement(id)) : null;
    await ea.addElementsToView(false, true, true);
    const current = this.getScene().elements.filter((element) => !element.isDeleted);
    const direct = current.find((element) => element.id === id);
    if (direct) return { element: direct, ...identity, ...warningResult };

    // Excalidraw may replace special text (notably Obsidian transclusions) with a
    // newly generated element. Return that committed identity instead of failing
    // on the pre-conversion text id.
    const created = current.filter((element) => !previousIds.has(element.id));
    const nearest = created.sort((left, right) => {
      const leftDistance = Math.abs(left.x - (Number(params.x) || 0)) + Math.abs(left.y - (Number(params.y) || 0));
      const rightDistance = Math.abs(right.x - (Number(params.x) || 0)) + Math.abs(right.y - (Number(params.y) || 0));
      return leftDistance - rightDistance;
    })[0];
    if (nearest) return { element: nearest, requestedId: requestedId || id, resolvedId: nearest.id, ...warningResult };
    if (staged) return { element: staged, ...identity, ...warningResult, committed: false };
    throw new BridgeError(`تعذر العثور على العنصر المنشأ: ${id}`, "ELEMENT_NOT_FOUND");
  }

  async batchCreateElements(params) {
    const elements = asArray(params.elements, "elements");
    const { ea } = this.getActiveContext();
    this.prepareWorkbenchForAppend(ea);
    const ids = new Array(elements.length);
    const aliases = new Map();
    for (const element of elements) {
      if (typeof element.id !== "string" || !element.id) continue;
      if (aliases.has(element.id)) {
        throw new BridgeError(`اسم العنصر مكرر داخل الدفعة: ${element.id}`, "DUPLICATE_ELEMENT_ALIAS");
      }
      aliases.set(element.id, null);
    }

    // Create frames, then shapes, then arrows. This lets an arrow reference a
    // friendly alias from the same batch while the stored scene only receives
    // native ids. Returned ids retain the caller's original order.
    const indexed = elements.map((element, index) => ({ element, index }));
    const ordered = [
      ...indexed.filter(({ element }) => element.type === "frame"),
      ...indexed.filter(({ element }) => element.type !== "frame" && element.type !== "arrow"),
      ...indexed.filter(({ element }) => element.type === "arrow"),
    ];
    const resolveAlias = (value) => typeof value === "string" && aliases.get(value) ? aliases.get(value) : value;
    for (const { element, index } of ordered) {
      const prepared = { ...element };
      delete prepared.id;
      if (prepared.startElementId !== undefined) prepared.startElementId = resolveAlias(prepared.startElementId);
      if (prepared.endElementId !== undefined) prepared.endElementId = resolveAlias(prepared.endElementId);
      if (prepared.frameId !== undefined) prepared.frameId = resolveAlias(prepared.frameId);
      const id = await this.addElementToWorkbench(ea, prepared);
      ids[index] = id;
      if (typeof element.id === "string" && element.id) aliases.set(element.id, id);
    }
    await ea.addElementsToView(false, true, true);
    const created = this.getScene().elements.filter((element) => ids.includes(element.id));
    const idMappings = elements.flatMap((element, index) =>
      typeof element.id === "string" && element.id
        ? [{ requestedId: element.id, resolvedId: ids[index] }]
        : [],
    );
    const warnings = elements
      .filter((element) => element.type === "arrow" && !element.startElementId && !element.endElementId)
      .map(() => ({ code: "ARROW_WITHOUT_BINDING", message: "السهم غير مرتبط؛ لن يتبع الأشكال ولن يراه Auto Layout" }));
    return { ids, elements: created, count: ids.length, idMappings, ...(warnings.length ? { warnings } : {}) };
  }

  async updateElement(params) {
    if (typeof params.id !== "string" || !params.id) {
      throw new BridgeError("id مطلوب", "INVALID_ARGUMENT");
    }
    const { id, startElementId, endElementId, ...set } = params;

    // startElementId/endElementId ليسا خصائص Excalidraw. تمريرهما خامًا كان
    // ينتج نجاحًا كاذبًا: الحقلان يُكتبان والارتباط لا يقع.
    if (startElementId !== undefined || endElementId !== undefined) {
      const { ea } = this.getActiveContext();
      const view = new Map(
        ea.getViewElements().filter((element) => !element.isDeleted).map((element) => [element.id, element]),
      );
      const target = view.get(id);
      if (!target) throw new BridgeError("العنصر غير موجود", "ELEMENT_NOT_FOUND", { missing: [id] });
      if (target.type !== "arrow") {
        throw new BridgeError("الارتباط لا ينطبق إلا على الأسهم", "INVALID_ARGUMENT", { id, type: target.type });
      }
      const resolveBinding = (raw, side) => {
        if (raw === undefined) return undefined;
        if (raw === null) return null;
        const element = view.get(String(raw));
        if (!element) throw new BridgeError(`هدف ${side} غير موجود`, "ELEMENT_NOT_FOUND", { missing: [raw] });
        // ربط سهم بنص داخل حاوية خطأ شائع؛ أعِد التوجيه إلى الحاوية.
        const anchor = element.type === "text" && element.containerId && view.has(element.containerId)
          ? view.get(element.containerId)
          : element;
        return { elementId: anchor.id, focus: 0, gap: 8 };
      };
      const startBinding = resolveBinding(startElementId, "startElementId");
      const endBinding = resolveBinding(endElementId, "endElementId");
      if (startBinding !== undefined) set.startBinding = startBinding;
      if (endBinding !== undefined) set.endBinding = endBinding;

      const nextStart = startBinding === undefined ? target.startBinding : startBinding;
      const nextEnd = endBinding === undefined ? target.endBinding : endBinding;
      const nextAnchorIds = new Set([nextStart?.elementId, nextEnd?.elementId].filter(Boolean));
      const touchedAnchorIds = new Set([
        target.startBinding?.elementId,
        target.endBinding?.elementId,
        ...nextAnchorIds,
      ].filter(Boolean));
      const extra = [];
      for (const anchorId of touchedAnchorIds) {
        const anchor = view.get(anchorId);
        if (!anchor) continue;
        const original = Array.isArray(anchor.boundElements) ? anchor.boundElements : [];
        const withoutArrow = original.filter((entry) => entry.id !== id);
        const updated = nextAnchorIds.has(anchorId)
          ? [...withoutArrow, { id, type: "arrow" }]
          : withoutArrow;
        if (JSON.stringify(original) !== JSON.stringify(updated)) {
          extra.push({ id: anchor.id, set: { boundElements: updated.length ? updated : null } });
        }
      }
      await this.patchElements({ patches: [{ id, set }, ...extra] });

      const result = this.getElement({ id });
      const after = result.element;
      const wantStart = startBinding === undefined ? undefined : startBinding?.elementId ?? null;
      const wantEnd = endBinding === undefined ? undefined : endBinding?.elementId ?? null;
      const gotStart = after.startBinding?.elementId ?? null;
      const gotEnd = after.endBinding?.elementId ?? null;
      if ((wantStart !== undefined && gotStart !== wantStart) || (wantEnd !== undefined && gotEnd !== wantEnd)) {
        throw new BridgeError(
          "لم يُطبَّق الارتباط فعلًا — احذف السهم وأعِد إنشاءه بـbatch_create_elements",
          "BINDING_NOT_APPLIED",
          { requested: { startElementId, endElementId }, actual: { startBinding: gotStart, endBinding: gotEnd } },
        );
      }
      return result;
    }

    await this.patchElements({ patches: [{ id, set }] });
    const result = this.getElement({ id });
    const after = result.element;
    // النجاح الكاذب أسوأ من العطل: الوكيل يظن أنه أصلح ويكمل. النص تحديدًا قد
    // لا يتغيّر لأنه مخزَّن أيضًا في قسم Text Elements.
    const unchanged = Object.keys(set).filter(
      (key) => ["text", "originalText", "rawText"].includes(key) &&
        String(after[key] ?? "") !== String(set[key] ?? ""),
    );
    if (unchanged.length) {
      throw new BridgeError(
        `لم يتغيّر ${unchanged.join(", ")} فعلًا — احذف العنصر وأعِد إنشاءه`,
        "UPDATE_NOT_APPLIED",
        { fields: unchanged, actual: unchanged.map((key) => after[key]) },
      );
    }
    return result;
  }

  async deleteElement(params) {
    await this.deleteElements({ elementIds: [params.id] });
    return { id: params.id, deleted: true };
  }

  async duplicateElements(params) {
    const elementIds = asArray(params.elementIds, "elementIds");
    const offsetX = Number(params.offsetX) || 20;
    const offsetY = Number(params.offsetY) || 20;
    const { ea } = this.getActiveContext();
    const current = new Map(ea.getViewElements().map((element) => [element.id, element]));
    const missing = elementIds.filter((id) => !current.has(id));
    if (missing.length) {
      throw new BridgeError("بعض العناصر غير موجودة", "ELEMENT_NOT_FOUND", { missing });
    }
    this.prepareWorkbenchForAppend(ea);
    const ids = [];
    for (const id of elementIds) {
      const clone = ea.cloneElement(current.get(id));
      clone.x += offsetX;
      clone.y += offsetY;
      ea.elementsDict[clone.id] = clone;
      ids.push(clone.id);
    }
    await ea.addElementsToView(false, true, true);
    return {
      ids,
      elements: this.getScene().elements.filter((element) => ids.includes(element.id)),
    };
  }

  async alignElements(params) {
    const elements = this.elementsByIds(params.elementIds);
    const alignment = params.alignment;
    const left = Math.min(...elements.map((element) => element.x));
    const right = Math.max(...elements.map((element) => element.x + element.width));
    const top = Math.min(...elements.map((element) => element.y));
    const bottom = Math.max(...elements.map((element) => element.y + element.height));
    const patches = elements.map((element) => {
      const set = {};
      if (alignment === "left") set.x = left;
      else if (alignment === "center") set.x = (left + right - element.width) / 2;
      else if (alignment === "right") set.x = right - element.width;
      else if (alignment === "top") set.y = top;
      else if (alignment === "middle") set.y = (top + bottom - element.height) / 2;
      else if (alignment === "bottom") set.y = bottom - element.height;
      else throw new BridgeError("قيمة alignment غير صحيحة", "INVALID_ARGUMENT");
      return { id: element.id, set };
    });
    return this.patchElements({ patches });
  }

  async distributeElements(params) {
    const elements = this.elementsByIds(params.elementIds);
    if (elements.length < 3) {
      throw new BridgeError("التوزيع يحتاج ثلاثة عناصر على الأقل", "INVALID_ARGUMENT");
    }
    const horizontal = params.direction === "horizontal";
    const sorted = [...elements].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const start = horizontal ? first.x : first.y;
    const end = horizontal ? last.x + last.width : last.y + last.height;
    const totalSize = sorted.reduce(
      (sum, element) => sum + (horizontal ? element.width : element.height),
      0,
    );
    const gap = (end - start - totalSize) / (sorted.length - 1);
    let cursor = start;
    const patches = sorted.map((element) => {
      const set = horizontal ? { x: cursor } : { y: cursor };
      cursor += (horizontal ? element.width : element.height) + gap;
      return { id: element.id, set };
    });
    return this.patchElements({ patches });
  }

  elementsByIds(elementIds) {
    const ids = asArray(elementIds, "elementIds");
    const current = new Map(this.getScene().elements.map((element) => [element.id, element]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length) {
      throw new BridgeError("بعض العناصر غير موجودة", "ELEMENT_NOT_FOUND", { missing });
    }
    return ids.map((id) => current.get(id));
  }

  async groupElements(params) {
    const elements = this.elementsByIds(params.elementIds);
    const { ea } = this.getActiveContext();
    ea.clear();
    ea.copyViewElementsToEAforEditing(elements, true);
    const groupId = ea.addToGroup(elements.map((element) => element.id));
    await ea.addElementsToView(false, true, false);
    return { groupId, elementIds: elements.map((element) => element.id) };
  }

  async ungroupElements(params) {
    if (typeof params.groupId !== "string" || !params.groupId) {
      throw new BridgeError("groupId مطلوب", "INVALID_ARGUMENT");
    }
    const members = this.getScene().elements.filter((element) =>
      (element.groupIds || []).includes(params.groupId),
    );
    if (!members.length) throw new BridgeError("المجموعة غير موجودة", "GROUP_NOT_FOUND");
    return this.patchElements({
      patches: members.map((element) => ({
        id: element.id,
        set: { groupIds: element.groupIds.filter((id) => id !== params.groupId) },
      })),
    });
  }

  setElementsLocked(params, locked) {
    const elements = this.elementsByIds(params.elementIds);
    return this.patchElements({
      patches: elements.map((element) => ({ id: element.id, set: { locked } })),
    });
  }

  setZOrder(params) {
    const elements = this.elementsByIds(params.elementIds);
    const { ea, api } = this.getActiveContext();
    if (params.position === "front") api.bringToFront(elements);
    else if (params.position === "back") api.sendToBack(elements);
    else if (Number.isInteger(params.index)) {
      for (const element of elements) ea.moveViewElementToZIndex(element.id, params.index);
    } else throw new BridgeError("position أو index مطلوب", "INVALID_ARGUMENT");
    return {
      elementIds: elements.map((element) => element.id),
      position: params.position,
      index: params.index,
    };
  }

  applyStyleToElements(params) {
    const ids = asArray(params.elementIds, "elementIds");
    const style = params.style && typeof params.style === "object" ? params.style : {};
    const allowed = new Set([
      "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle",
      "roughness", "opacity", "fontSize", "fontFamily", "textAlign", "verticalAlign",
      "roundness", "startArrowhead", "endArrowhead",
    ]);
    const set = Object.fromEntries(Object.entries(style).filter(([key]) => allowed.has(key)));
    if (!Object.keys(set).length) throw new BridgeError("لا توجد خصائص نمط صالحة", "INVALID_ARGUMENT");
    return this.patchElements({ patches: ids.map((id) => ({ id, set })) });
  }

  async createDropShadow(params) {
    const elements = this.elementsByIds(params.elementIds).filter((element) =>
      ["rectangle", "ellipse", "diamond", "blob"].includes(element.type),
    );
    if (!elements.length) throw new BridgeError("حدد أشكالًا مغلقة لإنشاء الظل", "INVALID_ARGUMENT");
    const { ea } = this.getActiveContext();
    ea.clear();
    ea.copyViewElementsToEAforEditing(elements, true);
    const offsetX = Number.isFinite(Number(params.offsetX)) ? Number(params.offsetX) : 10;
    const offsetY = Number.isFinite(Number(params.offsetY)) ? Number(params.offsetY) : 10;
    const color = params.color || "#0f172a";
    const opacity = Number.isFinite(Number(params.opacity)) ? Number(params.opacity) : 20;
    const pairs = [];
    for (const original of elements) {
      const shadow = ea.cloneElement(original);
      shadow.x += offsetX;
      shadow.y += offsetY;
      shadow.strokeColor = color;
      shadow.backgroundColor = color;
      shadow.fillStyle = "solid";
      shadow.opacity = opacity;
      shadow.roughness = 0;
      shadow.boundElements = [];
      shadow.link = null;
      shadow.locked = params.locked !== false;
      shadow.groupIds = [];
      shadow.customData = {
        ...(shadow.customData || {}),
        mcpRole: "drop-shadow",
        mcpShadowOf: original.id,
      };
      ea.elementsDict[shadow.id] = shadow;
      if (params.group !== false) ea.addToGroup([original.id, shadow.id]);
      pairs.push({ elementId: original.id, shadowId: shadow.id });
    }
    await ea.addElementsToView(false, true, false);
    for (const pair of pairs) {
      const viewElements = ea.getViewElements();
      const originalIndex = viewElements.findIndex((element) => element.id === pair.elementId);
      ea.moveViewElementToZIndex(pair.shadowId, Math.max(0, originalIndex - 1));
    }
    return { shadows: pairs, count: pairs.length };
  }

  setPen(params) {
    const { ea, api } = this.getActiveContext();
    const highlighter = params.preset === "highlighter" || params.highlighter === true;
    const penOptions = {
      highlighter,
      constantPressure: params.constantPressure !== false,
      hasOutline: params.hasOutline === true,
      outlineWidth: Number(params.outlineWidth) || 1,
      options: {
        thinning: Number.isFinite(Number(params.thinning)) ? Number(params.thinning) : highlighter ? 0 : -0.5,
        smoothing: Number.isFinite(Number(params.smoothing)) ? Number(params.smoothing) : 0.5,
        streamline: Number.isFinite(Number(params.streamline)) ? Number(params.streamline) : 0.5,
        easing: params.easing || "linear",
        start: { taper: params.startTaper ?? 0, cap: params.startCap !== false, easing: params.easing || "linear" },
        end: { taper: params.endTaper ?? 0, cap: params.endCap !== false, easing: params.easing || "linear" },
      },
    };
    ea.viewUpdateScene({
      appState: {
        currentStrokeOptions: penOptions,
        currentItemStrokeWidth: Number(params.strokeWidth) || (highlighter ? 4 : 1),
        currentItemStrokeColor: params.strokeColor || (highlighter ? "#facc15" : "#3e6f8d"),
        currentItemBackgroundColor: "transparent",
        currentItemFillStyle: "hachure",
      },
      storeAction: "none",
    });
    api.setActiveTool({ type: "freedraw" });
    return { activeTool: "freedraw", preset: params.preset || "custom", penOptions };
  }

  describeScene() {
    const scene = this.getScene();
    if (!scene.elements.length) return { description: "The canvas is empty.", ...scene };
    const counts = {};
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const lines = scene.elements
      .slice()
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((element) => {
        counts[element.type] = (counts[element.type] || 0) + 1;
        minX = Math.min(minX, element.x);
        minY = Math.min(minY, element.y);
        maxX = Math.max(maxX, element.x + (element.width || 0));
        maxY = Math.max(maxY, element.y + (element.height || 0));
        const label = element.text || element.rawText || "";
        const connection =
          element.type === "arrow"
            ? ` | ${element.startBinding?.elementId || "?"} -> ${element.endBinding?.elementId || "?"}`
            : "";
        return `[${element.id}] ${element.type} @ (${Math.round(element.x)}, ${Math.round(element.y)}) ${Math.round(element.width || 0)}x${Math.round(element.height || 0)}${label ? ` | text: ${JSON.stringify(label)}` : ""}${connection}`;
      });
    return {
      path: scene.path,
      elementCount: scene.elementCount,
      types: counts,
      boundingBox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
      description: lines.join("\n"),
    };
  }

  inspectVisualQuality(params) {
    const scene = this.getScene();
    const issues = [];
    const minFontSize = Number(params.minFontSize) || 16;
    const shapes = scene.elements.filter((element) =>
      ["rectangle", "ellipse", "diamond", "blob", "image", "embeddable"].includes(element.type) &&
      element.customData?.mcpRole !== "drop-shadow",
    );
    for (const element of scene.elements) {
      if (element.type === "text" && Number(element.fontSize) < minFontSize) {
        issues.push({ type: "small_text", severity: "warning", elementIds: [element.id], message: `حجم الخط ${element.fontSize} أصغر من ${minFontSize}` });
      }
      if (element.type === "text" && element.containerId) {
        const container = scene.elements.find((candidate) => candidate.id === element.containerId);
        // Connector labels use containerId as an anchor. Their bounds naturally
        // exceed the arrow's thin geometry, so they are not text overflow.
        const isShapeContainer = container && !["arrow", "line", "freedraw"].includes(container.type);
        if (isShapeContainer && (element.width > container.width || element.height > container.height)) {
          issues.push({ type: "text_overflow", severity: "error", elementIds: [container.id, element.id], message: "النص يتجاوز حاويته" });
        }
      }
    }
    for (let index = 0; index < shapes.length; index += 1) {
      const first = shapes[index];
      for (let next = index + 1; next < shapes.length; next += 1) {
        const second = shapes[next];
        if (first.frameId === second.id || second.frameId === first.id) continue;
        const overlapX = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
        const overlapY = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
        if (overlapX <= 8 || overlapY <= 8) continue;
        // الاحتواء الكامل نمط مقصود: مسارات ومناطق وخلفيات. عدّه خطأً كان يُصفّر
        // نتيجة أي مخطط swimlane سليم، فيتعلّم الوكيل تجاهل الأداة.
        const contains = (outer, inner) =>
          inner.x >= outer.x && inner.y >= outer.y &&
          inner.x + inner.width <= outer.x + outer.width &&
          inner.y + inner.height <= outer.y + outer.height;
        if (contains(first, second) || contains(second, first)) {
          issues.push({ type: "containment", severity: "info", elementIds: [first.id, second.id], message: "عنصر داخل عنصر — مقصود عادةً" });
          continue;
        }
        issues.push({ type: "overlap", severity: "error", elementIds: [first.id, second.id], message: `تقاطع جزئي ${Math.round(overlapX)}×${Math.round(overlapY)}` });
      }
    }
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.filter((issue) => issue.severity === "warning").length;
    const infos = issues.filter((issue) => issue.severity === "info").length;
    return {
      path: scene.path,
      elementCount: scene.elementCount,
      issues,
      summary: { errors, warnings, infos, passed: errors === 0 },
      score: Math.max(0, 100 - errors * 20 - warnings * 5),
      note: "الفحص الهندسي لا يغني عن get_canvas_screenshot والمراجعة البصرية.",
    };
  }

  async getCanvasScreenshot(params) {
    const { ea } = this.getActiveContext();
    const elements = ea.getViewElements().filter((element) => !element.isDeleted);
    ea.clear();
    ea.copyViewElementsToEAforEditing(elements, true);
    const encoded = await ea.createPNGBase64(undefined, Number(params.scale) || 1, {
      withBackground: params.background !== false,
    });
    const data = String(encoded).includes(",")
      ? String(encoded).slice(String(encoded).indexOf(",") + 1)
      : String(encoded);
    return { mimeType: "image/png", data, elementCount: elements.length };
  }

  async getResource(params) {
    const scene = this.getScene();
    if (params.resource === "scene") return scene;
    if (params.resource === "elements") return { elements: scene.elements };
    if (params.resource === "theme") return { theme: scene.appState.theme };
    if (params.resource === "library") {
      const items = await this.getLibraryItems();
      return { items: jsonClone(items), count: items.length };
    }
    throw new BridgeError("resource غير معروف", "INVALID_ARGUMENT");
  }

  async exportScene(params) {
    const scene = this.getScene();
    const data = {
      type: "excalidraw",
      version: 2,
      source: "obsidian-excalidraw-universal-mcp",
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files,
    };
    const outputPath = params.filePath || params.outputPath;
    if (!outputPath) return { scene: data, path: scene.path };
    const target = safePath(outputPath, "filePath");
    if (target.toLowerCase().endsWith(".md")) {
      throw new BridgeError(
        "تصدير Markdown الأصلي يتم عبر create_drawing أو save_drawing؛ استخدم امتداد .excalidraw لهذا التصدير.",
        "UNSUPPORTED_EXPORT_FORMAT",
      );
    }
    const text = JSON.stringify(data, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(target);
    if (existing instanceof TFile) await this.app.vault.modify(existing, text);
    else {
      await this.ensureParentFolder(target);
      await this.app.vault.create(target, text);
    }
    return { outputPath: target, bytes: Buffer.byteLength(text, "utf8") };
  }

  async importScene(params) {
    let scene;
    if (params.filePath) {
      const file = this.getFile(params.filePath, "filePath");
      if (file.extension.toLowerCase() === "md") {
        const ea = this.getGlobalEA();
        scene = await ea.getSceneFromFile(file);
      } else scene = JSON.parse(await this.app.vault.read(file));
    } else if (typeof params.data === "string") scene = JSON.parse(params.data);
    else scene = params.data;
    if (!scene || !Array.isArray(scene.elements)) {
      throw new BridgeError("ملف المشهد لا يحتوي elements", "INVALID_SCENE");
    }
    if (params.mode === "merge") return this.appendScene({ elements: scene.elements });
    return this.replaceScene({
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files,
    });
  }

  async exportToImage(params) {
    if (params.filePath || params.outputPath) {
      return this.exportImage({
        format: params.format,
        outputPath: params.filePath || params.outputPath,
        scale: params.scale,
      });
    }
    if ((params.format || "png") === "png") return this.getCanvasScreenshot(params);
    const { ea } = this.getActiveContext();
    const elements = ea.getViewElements().filter((element) => !element.isDeleted);
    ea.clear();
    ea.copyViewElementsToEAforEditing(elements, true);
    const svg = await ea.createSVG();
    return { mimeType: "image/svg+xml", data: new XMLSerializer().serializeToString(svg) };
  }

  async clearCanvas() {
    const { ea } = this.getActiveContext();
    const elements = ea.getViewElements().filter((element) => !element.isDeleted);
    if (elements.length) ea.deleteViewElements(elements);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (ea.getViewElements().every((element) => element.isDeleted)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.saveDrawing();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (ea.getViewElements().every((element) => element.isDeleted)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const remaining = ea.getViewElements().filter((element) => !element.isDeleted);
    if (remaining.length) {
      throw new BridgeError("تعذر إفراغ اللوحة بالكامل", "CLEAR_CANVAS_FAILED", {
        remainingElementIds: remaining.map((element) => element.id),
      });
    }
    return { elementCount: 0, deleted: elements.length };
  }

  snapshotScene(params) {
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new BridgeError("name مطلوب", "INVALID_ARGUMENT");
    }
    const scene = this.getScene();
    this.snapshots.set(params.name.trim(), jsonClone(scene));
    return { name: params.name.trim(), elementCount: scene.elementCount };
  }

  restoreSnapshot(params) {
    const snapshot = this.snapshots.get(params.name);
    if (!snapshot) throw new BridgeError(`اللقطة غير موجودة: ${params.name}`, "SNAPSHOT_NOT_FOUND");
    return this.replaceScene(snapshot);
  }

  setViewport(params) {
    const { ea, api } = this.getActiveContext();
    if (Array.isArray(params.scrollToElementIds) && params.scrollToElementIds.length) {
      const elements = this.elementsByIds(params.scrollToElementIds);
      ea.viewZoomToElements(params.selectElements === true, elements);
    } else if (params.scrollToElementId) {
      const elements = this.elementsByIds([params.scrollToElementId]);
      ea.viewZoomToElements(false, elements);
    } else if (params.scrollToContent) {
      ea.viewZoomToElements(
        false,
        ea.getViewElements().filter((element) => !element.isDeleted),
      );
    } else {
      const appState = {};
      if (params.zoom !== undefined) appState.zoom = { value: Number(params.zoom) };
      if (params.offsetX !== undefined) appState.scrollX = Number(params.offsetX);
      if (params.offsetY !== undefined) appState.scrollY = Number(params.offsetY);
      api.updateScene({ appState });
    }
    return { updated: true, appState: this.getScene().appState };
  }

  async createFromMermaid(params) {
    if (typeof params.mermaidDiagram !== "string" || !params.mermaidDiagram.trim()) {
      throw new BridgeError("mermaidDiagram مطلوب", "INVALID_ARGUMENT");
    }
    this.requireExcalidrawExtras("Mermaid");
    const { ea } = this.getActiveContext();
    this.prepareWorkbenchForAppend(ea);
    const result = await ea.addMermaid(params.mermaidDiagram, params.groupElements !== false);
    if (typeof result === "string") throw new BridgeError(result, "MERMAID_ERROR");
    await ea.addElementsToView(false, true, true);
    return { ids: result, count: result.length };
  }

  async addImage(params) {
    const { ea } = this.getActiveContext();
    this.prepareWorkbenchForAppend(ea);
    const source = params.filePath || params.url;
    if (!source) throw new BridgeError("filePath أو url مطلوب", "INVALID_ARGUMENT");
    const file = params.filePath ? this.getFile(params.filePath, "filePath") : source;
    const id = await ea.addImage(Number(params.x) || 0, Number(params.y) || 0, file, true, true);
    await ea.addElementsToView(false, true, true);
    return this.getElement({ id });
  }

  async addLatex(params) {
    this.requireExcalidrawExtras("LaTeX");
    const { ea } = this.getActiveContext();
    this.prepareWorkbenchForAppend(ea);
    const id = await ea.addLaTex(
      Number(params.x) || 0,
      Number(params.y) || 0,
      String(params.latex || params.tex || ""),
      Number(params.scaleX) || 1,
      Number(params.scaleY) || 1,
    );
    await ea.addElementsToView(false, true, true);
    return this.getElement({ id });
  }

  async addEmbeddable(params) {
    const { ea } = this.getActiveContext();
    this.prepareWorkbenchForAppend(ea);
    const file = params.filePath ? this.getFile(params.filePath, "filePath") : undefined;
    const id = ea.addEmbeddable(
      Number(params.x) || 0,
      Number(params.y) || 0,
      Number(params.width) || 480,
      Number(params.height) || 320,
      params.url,
      file,
      params.customData,
    );
    await ea.addElementsToView(false, true, true);
    return this.getElement({ id });
  }

  async addFrame(params) {
    return this.createElement({ ...params, type: "frame" });
  }

  async replaceScene(params) {
    const elements = asArray(params.elements, "elements");
    const { ea } = this.getActiveContext();
    ea.viewUpdateScene({
      elements: jsonClone(elements),
      appState: params.appState ? jsonClone(params.appState) : undefined,
      files: params.files ? jsonClone(params.files) : undefined,
      storeAction: params.commitToHistory === false ? "none" : "capture",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.saveDrawing();
    return { elementCount: elements.length };
  }

  async appendScene(params) {
    const incoming = asArray(params.elements, "elements");
    const { ea } = this.getActiveContext();
    const existing = ea.getViewElements().filter((element) => !element.isDeleted);
    const ids = new Set(existing.map((element) => element.id));
    const duplicate = incoming.find((element) => ids.has(element.id));
    if (duplicate) {
      throw new BridgeError(`معرّف العنصر موجود مسبقًا: ${duplicate.id}`, "DUPLICATE_ELEMENT_ID");
    }
    ea.viewUpdateScene({
      elements: [...jsonClone(existing), ...jsonClone(incoming)],
      storeAction: params.commitToHistory === false ? "none" : "capture",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.saveDrawing();
    return { added: incoming.length, elementCount: existing.length + incoming.length };
  }

  selectElements(params) {
    const elementIds = asArray(params.elementIds, "elementIds");
    const { ea, api } = this.getActiveContext();
    const known = new Set(ea.getViewElements().map((element) => element.id));
    const missing = elementIds.filter((id) => !known.has(id));
    if (missing.length) {
      throw new BridgeError("بعض العناصر غير موجودة", "ELEMENT_NOT_FOUND", { missing });
    }
    const selectedElementIds = Object.fromEntries(elementIds.map((id) => [id, true]));
    api.updateScene({ appState: { selectedElementIds, selectedGroupIds: {} } });
    return { selectedElementIds: elementIds };
  }

  async patchElements(params) {
    const patches = asArray(params.patches, "patches");
    for (const patch of patches) {
      if (
        !patch ||
        typeof patch.id !== "string" ||
        !patch.set ||
        typeof patch.set !== "object" ||
        Array.isArray(patch.set)
      ) {
        throw new BridgeError("كل تعديل يجب أن يحتوي id وset", "INVALID_ARGUMENT");
      }
    }
    const { ea } = this.getActiveContext();
    const current = new Map(
      ea
        .getViewElements()
        .filter((element) => !element.isDeleted)
        .map((element) => [element.id, element]),
    );
    const missing = patches.map((patch) => patch.id).filter((id) => !current.has(id));
    if (missing.length) {
      throw new BridgeError("بعض العناصر غير موجودة", "ELEMENT_NOT_FOUND", { missing });
    }

    const targets = patches.map((patch) => current.get(patch.id));
    ea.copyViewElementsToEAforEditing(targets, true);
    for (const patch of patches) {
      Object.assign(ea.getElement(patch.id), jsonClone(patch.set));
    }
    await ea.addElementsToView(false, true, false);
    return { updated: patches.map((patch) => patch.id) };
  }

  async deleteElements(params) {
    const elementIds = asArray(params.elementIds, "elementIds");
    const { ea } = this.getActiveContext();
    const targets = ea
      .getViewElements()
      .filter((element) => elementIds.includes(element.id) && !element.isDeleted);
    const found = new Set(targets.map((element) => element.id));
    const missing = elementIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BridgeError("بعض العناصر غير موجودة", "ELEMENT_NOT_FOUND", { missing });
    }
    ea.deleteViewElements(targets);
    await this.saveDrawing();
    return { deleted: elementIds };
  }

  getScriptFolder() {
    const plugin = this.getExcalidrawPlugin();
    return normalizePath(plugin.settings?.scriptFolderPath || "Excalidraw/Scripts");
  }

  listScripts(params) {
    const folder = this.getScriptFolder();
    const query = typeof params.query === "string" ? params.query.toLowerCase() : "";
    const scripts = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.path.startsWith(`${folder}/`) &&
          SCRIPT_EXTENSIONS.has(file.extension.toLowerCase()) &&
          (!query || file.path.toLowerCase().includes(query)),
      )
      .map((file) => ({
        path: file.path,
        name: file.basename,
        relativePath: file.path.slice(folder.length + 1),
      }));
    return { folder, scripts, count: scripts.length };
  }

  resolveScript(scriptValue) {
    if (typeof scriptValue !== "string" || !scriptValue.trim()) {
      throw new BridgeError("script مطلوب", "INVALID_ARGUMENT");
    }
    const requested = scriptValue.trim().replaceAll("\\", "/");
    const folder = this.getScriptFolder();
    const candidates = this.app.vault.getFiles().filter((file) => {
      if (!file.path.startsWith(`${folder}/`)) return false;
      if (!SCRIPT_EXTENSIONS.has(file.extension.toLowerCase())) return false;
      const relative = file.path.slice(folder.length + 1);
      const withoutExtension = relative.replace(/\.(md|js|txt)$/i, "");
      return (
        file.path === requested ||
        relative === requested ||
        withoutExtension === requested ||
        file.basename === requested
      );
    });
    if (candidates.length !== 1) {
      throw new BridgeError(
        candidates.length === 0
          ? `السكربت غير موجود: ${requested}`
          : `اسم السكربت غير فريد: ${requested}`,
        candidates.length === 0 ? "SCRIPT_NOT_FOUND" : "AMBIGUOUS_SCRIPT",
        { candidates: candidates.map((file) => file.path) },
      );
    }
    return candidates[0];
  }

  extractScriptSource(source) {
    const normalized = String(source || "").replace(/\r\n/g, "\n");
    const fenced = normalized.match(/```(?:javascript|js)(?:\s*\*\/)?\s*\n?([\s\S]*?)\n```/i);
    return fenced ? fenced[1] : normalized;
  }

  async runScript(params) {
    const plugin = this.getExcalidrawPlugin();
    if (!plugin.scriptEngine?.executeScript) {
      throw new BridgeError("محرك السكربتات غير متاح", "SCRIPT_ENGINE_NOT_READY");
    }
    const { view } = this.getActiveContext();
    if (params.elementIds) this.selectElements({ elementIds: params.elementIds });

    const file = this.resolveScript(params.script);
    const source = this.extractScriptSource(await this.app.vault.read(file));
    const responses = Array.isArray(params.responses) ? [...params.responses] : [];
    const consumed = [];
    const engineClass = plugin.scriptEngine.constructor;
    const originalInputPrompt = engineClass.inputPrompt;
    const originalSuggester = engineClass.suggester;

    const nextResponse = (kind, label, fallback) => {
      if (responses.length > 0) {
        const entry = responses.shift();
        const value =
          entry && typeof entry === "object" && Object.hasOwn(entry, "value") ? entry.value : entry;
        consumed.push({ kind, label, value });
        return value;
      }
      if (fallback !== undefined) {
        consumed.push({ kind, label, value: fallback, defaulted: true });
        return fallback;
      }
      throw new BridgeError(
        `السكربت يحتاج إجابة لـ ${kind}: ${label || "بدون عنوان"}`,
        "SCRIPT_INPUT_REQUIRED",
      );
    };

    engineClass.inputPrompt = async (_view, _plugin, _app, header, _placeholder, value) =>
      nextResponse("inputPrompt", header, value);

    engineClass.suggester = async (_app, displayItems, items, hint) => {
      const choices = Array.isArray(items) ? items : [];
      const displays = Array.isArray(displayItems) ? displayItems : [];
      const fallback = choices.length === 1 ? choices[0] : undefined;
      const response = nextResponse("suggester", hint, fallback);
      if (Number.isInteger(response) && choices[response] !== undefined) {
        return choices[response];
      }
      const displayIndex = displays.findIndex((item) => String(item) === String(response));
      if (displayIndex >= 0 && choices[displayIndex] !== undefined) {
        return choices[displayIndex];
      }
      const itemIndex = choices.findIndex((item) => String(item) === String(response));
      return itemIndex >= 0 ? choices[itemIndex] : response;
    };

    try {
      const result = await plugin.scriptEngine.executeScript(
        view,
        source,
        plugin.scriptEngine.getScriptName?.(file) || file.basename,
        file,
      );
      const scene = this.getScene();
      return {
        script: file.path,
        result: serializable(result),
        consumedResponses: consumed,
        remainingResponses: responses,
        elementCount: scene.elementCount,
        selectedElementIds: Object.keys(scene.appState.selectedElementIds || {}),
      };
    } finally {
      engineClass.inputPrompt = originalInputPrompt;
      engineClass.suggester = originalSuggester;
    }
  }

  async saveDrawing() {
    const { view } = this.getActiveContext();
    if (typeof view.save === "function") {
      await view.save(false, true);
    } else if (typeof view.forceSave === "function") {
      await view.forceSave(true);
    } else {
      throw new BridgeError("واجهة الحفظ غير متاحة", "SAVE_NOT_SUPPORTED");
    }
    return { path: view.file?.path || null, saved: true };
  }

  async exportImage(params) {
    const format = String(params.format || "png").toLowerCase();
    if (!new Set(["png", "svg"]).has(format)) {
      throw new BridgeError("format يجب أن يكون png أو svg", "INVALID_ARGUMENT");
    }
    const outputPath = safePath(params.outputPath, "outputPath");
    const { ea } = this.getActiveContext();
    const elements = ea.getViewElements().filter((element) => !element.isDeleted);
    ea.clear();
    ea.copyViewElementsToEAforEditing(elements, true);

    if (format === "png") {
      const encoded = await ea.createPNGBase64(undefined, Number(params.scale) || 1);
      const base64 = String(encoded).includes(",")
        ? String(encoded).slice(String(encoded).indexOf(",") + 1)
        : String(encoded);
      const bytes = Buffer.from(base64, "base64");
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const existing = this.app.vault.getAbstractFileByPath(outputPath);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, arrayBuffer);
      } else {
        await this.ensureParentFolder(outputPath);
        await this.app.vault.createBinary(outputPath, arrayBuffer);
      }
      return { outputPath, format, bytes: bytes.length };
    }

    const svg = await ea.createSVG();
    const text = new XMLSerializer().serializeToString(svg);
    const existing = this.app.vault.getAbstractFileByPath(outputPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, text);
    } else {
      await this.ensureParentFolder(outputPath);
      await this.app.vault.create(outputPath, text);
    }
    return { outputPath, format, bytes: Buffer.byteLength(text, "utf8") };
  }

  async ensureParentFolder(path) {
    const slash = path.lastIndexOf("/");
    if (slash < 0) return;
    const folder = path.slice(0, slash);
    const segments = folder.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}

module.exports = ObsidianExcalidrawMcpBridge;
