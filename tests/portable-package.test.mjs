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
  const clientNode = path.join(temporary, "Portable Node", "node.exe");
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(root, "install.mjs"), "--vault", vault, "--clients", "project",
      "--project-root", project, "--node", clientNode, "--skip-official", "--offline",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.bridge.version, "0.6.0");
    assert.equal(result.content.baseFileCount, 34);
    assert.equal(result.content.professionalFileCount, 15);
    const config = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8"));
    assert.equal(config.mcpServers.excalidraw.command, clientNode);
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
  assert.match(helper, /--node/);
  assert.match(helper, /install\.mjs/);
  assert.doesNotMatch(helper, /[^\x00-\x7F]/);
});

test("package, bridge, and MCP server publish one coherent version", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const bridgeManifest = JSON.parse(await fs.readFile(path.join(root, "obsidian-plugin", "manifest.json"), "utf8"));
  const server = await fs.readFile(path.join(root, "server.mjs"), "utf8");
  assert.equal(packageJson.version, "0.6.0");
  assert.equal(bridgeManifest.version, packageJson.version);
  assert.match(server, new RegExp(`SERVER_VERSION = "${packageJson.version.replaceAll(".", "\\.")}"`));
});

test("WSL setup discovers the active Windows Claude config instead of assuming the classic path", async () => {
  const installer = await fs.readFile(path.join(root, "install.mjs"), "utf8");
  assert.match(installer, /resolveWslWindowsClaudeConfig/);
  assert.match(installer, /LOCALAPPDATA[\s\S]*Packages[\s\S]*LocalCache/);
  assert.match(installer, /mcpServers/);
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

test("doctor separates installation readiness from a stale live bridge", async () => {
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
      ["obsidian-excalidraw-mcp-bridge", "0.6.0"],
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

    // العقد الجديد: جاهزية التثبيت منفصلة عن الاتصال الحيّ. جسر قديم لا يعني أن
    // التثبيت معطوب، فرمز الخروج يبقى صفرًا — لكن liveReady false والرسالة تطلب
    // إعادة تشغيل Obsidian. ومع --require-live يفشل، فيصلح للـCI.
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(root, "doctor.mjs"), "--vault", vault, "--json",
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.installReady, true);
    assert.equal(report.liveReady, false);
    assert.equal(report.bridgeState, "version-mismatch");
    assert.match(report.bridge.message, /أعد تشغيل Obsidian/);

    let strictFailure;
    try {
      await execFileAsync(process.execPath, [
        path.join(root, "doctor.mjs"), "--vault", vault, "--json", "--require-live",
      ]);
    } catch (error) {
      strictFailure = error;
    }
    assert.ok(strictFailure, "--require-live should exit non-zero for a stale bridge");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

// «استخدم fontFamily: 4 عندما يكون الخط مفعّلًا» شرطٌ كان على الوكيل أن يخمّنه.
// الطبيب يقرأه من إعدادات Excalidraw على القرص، فيعمل بلا Obsidian مفتوح — وهو
// معلومة لا شرط: الخط اختياري ويملكه المستخدم، فلا يؤثر في رمز الخروج.
test("doctor reports the Arabic font state without making it a requirement", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-font-"));
  const vault = path.join(temporary, "Vault");
  const settings = path.join(vault, ".obsidian", "plugins", "obsidian-excalidraw-plugin");
  const fontRelative = "Excalidraw/Custom Fonts/user-owned.woff2";
  try {
    await fs.mkdir(settings, { recursive: true });
    await fs.mkdir(path.join(vault, "Excalidraw", "Custom Fonts"), { recursive: true });
    // خزنة مكتملة التثبيت، وإلا كان installReady دائمًا false فلا يُثبت شيئًا.
    for (const id of ["obsidian-excalidraw-plugin", "excalidraw-extras", "obsidian-excalidraw-mcp-bridge"]) {
      await fs.mkdir(path.join(vault, ".obsidian", "plugins", id), { recursive: true });
      await fs.writeFile(
        path.join(vault, ".obsidian", "plugins", id, "manifest.json"),
        JSON.stringify({ id, version: id === "obsidian-excalidraw-plugin" ? "2.25.3" : id === "excalidraw-extras" ? "0.0.15" : "0.6.0" }),
      );
    }
    await fs.writeFile(
      path.join(vault, ".obsidian", "community-plugins.json"),
      JSON.stringify(["obsidian-excalidraw-plugin", "excalidraw-extras", "obsidian-excalidraw-mcp-bridge"]),
    );
    for (const [folder, count] of [["أدوات التخطيط", 17], ["الحزمة الاحترافية", 15]]) {
      const directory = path.join(vault, "Excalidraw", "Scripts", folder);
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(Array.from({ length: count }, (_, index) => fs.writeFile(path.join(directory, `${index}.md`), "")));
    }

    const run = async (data) => {
      await fs.writeFile(path.join(settings, "data.json"), data);
      const result = await execFileAsync(process.execPath, [
        path.join(root, "doctor.mjs"), "--vault", vault, "--json", "--skip-live",
      ]).then((ok) => ({ ...ok, code: 0 }), (error) => ({ stdout: error.stdout, code: error.code ?? 1 }));
      return { ...JSON.parse(result.stdout), exitCode: result.code };
    };
    const registered = JSON.stringify({ experimentalEnableFourthFont: true, experimantalFourthFont: fontRelative });
    const disabled = JSON.stringify({ experimentalEnableFourthFont: false, experimantalFourthFont: fontRelative });
    const fontFile = path.join(vault, ...fontRelative.split("/"));

    // 1) لا خط: null تعني «لا تمرّر fontFamily إطلاقًا».
    const absent = await run("{}");
    assert.deepEqual(absent.font, { enabled: false, vaultPath: null, fileFound: false, arabicFontFamily: null });

    // 2) مسجَّل وملفه مفقود: لا جاهزية كاذبة.
    const missing = await run(registered);
    assert.equal(missing.font.fileFound, false);
    assert.equal(missing.font.arabicFontFamily, null);

    // 3) الملف موجود والخيار مطفأ: يميّزها عن «غير مثبَّت» ولا يعيد 4.
    await fs.writeFile(fontFile, "font");
    const off = await run(disabled);
    assert.equal(off.font.fileFound, true, "يجب أن يرى الملف");
    assert.equal(off.font.enabled, false);
    assert.equal(off.font.arabicFontFamily, null, "خيار مطفأ لا يعني جاهزية");

    // 4) مفعَّل وملفه موجود: 4.
    const ready = await run(registered);
    assert.equal(ready.font.arabicFontFamily, 4);

    // 5) مجلد بمسار الخط ليس خطًا.
    await fs.rm(fontFile);
    await fs.mkdir(fontFile, { recursive: true });
    const folder = await run(registered);
    assert.equal(folder.font.fileFound, false, "مجلد لا يجوز أن يُعدّ خطًا");
    assert.equal(folder.font.arabicFontFamily, null);
    await fs.rm(fontFile, { recursive: true });

    // 6) مسار خارج الخزنة لا يُعدّ جاهزًا.
    const escape = await run(JSON.stringify({
      experimentalEnableFourthFont: true, experimantalFourthFont: "../../../etc/passwd",
    }));
    assert.equal(escape.font.vaultPath, null, "مسار صاعد يُعدّ غير مسجَّل");
    assert.equal(escape.font.arabicFontFamily, null);

    // العقد: الخط معلومة لا شرط. حالة الخط لا تحرّك installReady ولا رمز الخروج،
    // ولا تظهر بين فحوص التثبيت. تُفحص على خزنة مكتملة، وإلا كان التأكيد فراغًا.
    await fs.writeFile(fontFile, "font");
    const states = [await run("{}"), await run(disabled), await run(registered)];
    for (const state of states) {
      assert.equal(state.installReady, true, "الخط لا يجوز أن يُسقط جاهزية التثبيت");
      assert.equal(state.exitCode, 0, "الخط لا يجوز أن يغيّر رمز الخروج");
      assert.ok(!state.installChecks.some((check) => check.name.includes("font")));
    }
    assert.deepEqual(states.map((state) => state.font.arabicFontFamily), [null, null, 4],
      "ومع ذلك يُبلَّغ عن الحالة الحقيقية في الحالات الثلاث");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

// مسار Codex ليس مسار Claude Desktop: مفتاح الموصل إلزامي في الثاني فقط، وسكوت
// الوثيقة عن الفرق كان يجعل مستخدمًا يتبع خطوات عميل آخر ثم يظن الحزمة معطوبة.
test("entrypoints document all three clients and isolate the connector step", async () => {
  const start = await fs.readFile(path.join(root, "START-HERE-AR.md"), "utf8");
  for (const marker of ["~/.codex/config.toml", "[mcp_servers.excalidraw]", ".mcp.json", "--clients codex", "--clients claude-desktop"]) {
    assert.ok(start.includes(marker), `START-HERE-AR.md يجب أن يذكر ${marker}`);
  }
  // خطوة الموصل يجب أن تكون محصورة بـClaude Desktop نصًّا، لا مطلقة.
  assert.match(start, /فعّل موصل `excalidraw` بالزر — \*\*Claude Desktop فقط\*\*/);
  assert.match(start, /Codex وClaude Code لا يحتاجان هذه الخطوة/);

  const claude = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.match(claude, /AGENTS\.md/, "CLAUDE.md يجب أن يحيل إلى AGENTS.md لا أن ينسخه");

  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /fonts\.arabicFontFamily/, "AGENTS.md يجب أن يوجّه الوكيل لقراءة الخط من status");
  assert.match(agents, /OPERATION_TIMEOUT/, "قاعدة عدم إعادة المحاولة يجب أن تكون في ملف يقرأه الوكيل");
  assert.match(agents, /describe_scene/);
});

// وثيقة تأمر الوكيل بترقيم الخط بيده تُبطل القاعدة كلها، ولو كانت القاعدة مكتوبة
// في ملف آخر. الطلب الجاهز في START-HERE هو ما يُلصق فعلًا، فهو الأخطر.
test("no shipped document tells the agent to hard-code font family 4", async () => {
  const files = ["START-HERE-AR.md", "AGENTS.md", "PROFESSIONAL-GUIDE-AR.md", "README.md"];
  for (const name of files) {
    const text = await fs.readFile(path.join(root, name), "utf8").catch(() => "");
    for (const [index, line] of text.split("\n").entries()) {
      const claimsFour = /fontFamily: 4|العائلة الرابعة|الخط الرابع/.test(line);
      if (!claimsFour) continue;
      const conditional = /إن |إذا |status|لا تفترض|اقرأ|قد |تلقائيًا|مفعّل/.test(line);
      assert.ok(conditional, `${name}:${index + 1} يذكر العائلة الرابعة بلا شرط — الوكيل سيفرض 4 على خزنة بلا خط:\n${line}`);
    }
  }
});

// أداة معلَنة بلا منفّذ تنجح في `tools/list` وتفشل عند أول نداء — والفحص الساكن
// القائم كان يعدّ الأدوات ولا يتحقّق من أن لكل واحدة منفّذًا على الجهة الأخرى.
test("every declared tool has an implementation on the other side", async () => {
  const server = await fs.readFile(path.join(root, "server.mjs"), "utf8");
  const bridge = await fs.readFile(path.join(root, "obsidian-plugin", "main.js"), "utf8");
  const uniq = (list) => [...new Set(list)];

  const declaredRaw = [...server.matchAll(/^\s*name: "([a-z_0-9]+)",\s*$/gm)].map((m) => m[1]);
  const dispatchedRaw = [...bridge.matchAll(/case "([a-z_0-9]+)":/g)].map((m) => m[1]);
  const declared = uniq(declaredRaw);
  const dispatched = uniq(dispatchedRaw);
  // أدوات يعالجها الخادم محليًا ولا تُرسل إلى الجسر إطلاقًا.
  const serverLocal = uniq([...server.matchAll(/name === "([a-z_0-9]+)"/g)].map((m) => m[1]));
  const rpcCalled = uniq([...server.matchAll(/bridgeCall\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]));

  assert.equal(declared.length, 59, "عدد الأدوات المعلَنة");
  assert.deepEqual(
    declared.filter((tool) => !dispatched.includes(tool) && !serverLocal.includes(tool)),
    [], "أداة معلَنة لا ينفّذها الجسر ولا الخادم",
  );
  assert.deepEqual(
    rpcCalled.filter((method) => !dispatched.includes(method)),
    [], "الخادم ينادي طريقة RPC لا يوزّعها الجسر",
  );
  assert.deepEqual(uniq(declaredRaw.filter((t, i) => declaredRaw.indexOf(t) !== i)), [], "اسم أداة مكرَّر");
  assert.deepEqual(uniq(dispatchedRaw.filter((t, i) => dispatchedRaw.indexOf(t) !== i)), [], "case مكرَّر");

  // كل معالج مُنادى في dispatch معرَّف فعلًا: الظهور الوحيد يعني نداءً بلا تعريف.
  const dispatchBlock = bridge.slice(bridge.indexOf("async dispatch("), bridge.indexOf("  status() {"));
  const handlers = uniq([...dispatchBlock.matchAll(/this\.([A-Za-z0-9_]+)\(/g)].map((m) => m[1]));
  assert.deepEqual(
    handlers.filter((h) => [...bridge.matchAll(new RegExp(`(?:async )?${h}\\s*\\(`, "g"))].length <= 1),
    [], "معالج مُنادى بلا تعريف",
  );

  // كل أداة لها مخطط دخل ووصف غير فارغ.
  const blocks = server.split(/\n\s*\{\s*\n\s*name: "/).slice(1).map((b) => [b.slice(0, b.indexOf('"')), b]);
  assert.deepEqual(blocks.filter(([, b]) => !b.includes("inputSchema")).map(([n]) => n), [], "أداة بلا inputSchema");
  assert.deepEqual(blocks.filter(([, b]) => !/description:/.test(b)).map(([n]) => n), [], "أداة بلا وصف");
});

// حرس معمَّم: أي قاعدة تخصّ عميلًا واحدًا يجب أن تُذكر مقيَّدة به. حرسي الأول كان
// يمسح ذكر العائلة الرابعة وحدها، فمرّت خطوة «فعّل الموصل» مطلقةً في AGENTS.md —
// وهو أول ملف يقرأه الوكيل — فيُرسَل مستخدم Codex إلى زر لا وجود له.
test("no client-specific rule is stated unconditionally in agent-facing docs", async () => {
  // التشكيل يُجرَّد قبل المطابقة: «مفعَّل» و«مفعّل» كلمة واحدة، والاختبار لا يجوز أن
  // يسقط على فرق حركة.
  const bare = (text) => text.replace(/[\u064B-\u0652\u0670\u0640]/g, "");
  const guarded = [
    { name: "الموصل", pattern: /موصل|connector/i, qualifiers: /Claude Desktop|لا يحتاج|فقط|بحسب عميله|الزامي في|وحده/ },
    { name: "العائلة الرابعة", pattern: /fontFamily: 4|العائلة الرابعة|الخط الرابع/, qualifiers: /ان |اذا |status|لا تفترض|اقرا|قد |تلقائيا|مفعل|مثبت|بحسب/ },
    { name: "الإغلاق الكامل", pattern: /إغلاق كامل|أغلق التطبيق كاملًا|أيقونة شريط المهام/, qualifiers: /Claude Desktop|بحسب عميله|فقط/ },
  ];
  for (const name of ["AGENTS.md", "START-HERE-AR.md", "README.md", "docs/TROUBLESHOOTING-AR.md"]) {
    const text = await fs.readFile(path.join(root, ...name.split("/")), "utf8").catch(() => "");
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const rule of guarded) {
        if (!rule.pattern.test(bare(line))) continue;
        // السياق: العنوان الذي تحته السطر، وجاره، وترويسة الجدول إن كان صفًا فيه —
        // فالتقييد في الجدول يعيش في عمود الترويسة لا في الصف نفسه.
        const heading = lines.slice(0, index + 1).reverse().find((l) => l.startsWith("#")) || "";
        let tableHeader = "";
        if (line.trimStart().startsWith("|")) {
          for (let scan = index; scan >= 0 && lines[scan].trimStart().startsWith("|"); scan -= 1) {
            if (/^\s*\|[\s|:-]+\|\s*$/.test(lines[scan])) { tableHeader = lines[scan - 1] || ""; break; }
          }
        }
        const context = `${heading}\n${tableHeader}\n${lines[index - 1] || ""}\n${line}\n${lines[index + 1] || ""}`;
        assert.ok(
          rule.qualifiers.test(bare(context)),
          `${name}:${index + 1} يذكر «${rule.name}» بلا تقييد بالعميل:\n${line}`,
        );
      }
    }
  }
});

// معيار النجاح كان عبارة مترجَمة، والوثائق نفسها توصي بـ--lang en فلا تظهر.
test("the readiness criterion is language-independent and documented", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-result-"));
  try {
    await fs.mkdir(path.join(temporary, ".obsidian"), { recursive: true });
    const run = async (lang) => {
      const result = await execFileAsync(process.execPath, [
        path.join(root, "doctor.mjs"), "--vault", temporary, "--lang", lang, "--skip-live",
      ]).catch((error) => ({ stdout: error.stdout }));
      return result.stdout.trim().split("\n").at(-1).trim();
    };
    const [ar, en] = [await run("ar"), await run("en")];
    assert.equal(ar, en, "سطر النتيجة يجب أن يكون نفسه في اللغتين");
    assert.match(ar, /^RESULT install=(ready|incomplete) bridge=\S+ ready=(true|false)$/);

    // والوثائق تحيل إليه لا إلى عبارة واجهة.
    for (const name of ["AGENTS.md", "START-HERE-AR.md", "README.md"]) {
      const text = await fs.readFile(path.join(root, name), "utf8");
      assert.match(text, /RESULT install=/, `${name} يجب أن يذكر سطر النتيجة الثابت`);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

// الجملة الآمرة الوحيدة في وثيقة الدخول كانت تفشل قبل تثبيت أي شيء على Linux.
test("a cross-host client is skipped, not fatal to the whole install", async () => {
  const install = await fs.readFile(path.join(root, "install.mjs"), "utf8");
  assert.match(install, /selectedClients\.delete\("claude-desktop"\)/, "يُستثنى العميل المتعذّر وحده");
  assert.match(install, /skippedClients\.push\(/);
  assert.match(install, /if \(!selectedClients\.size\)/, "الفشل صحيح فقط إن لم يبقَ عميل");
  // اسم عميل مجهول كان يمرّ بلا أثر ويخرج المثبّت كأنه نجح.
  assert.match(install, /عميل غير معروف/);
  assert.match(install, /const KNOWN_CLIENTS = \["project", "codex", "claude-desktop"\]/);
  // معيار نجاح واحد قابل للقراءة برمجيًا بدل `installed: true` الدائم.
  assert.match(install, /const ok = manualSteps\.length === 0/);
  assert.match(install, /if \(!ok\) process\.exitCode = 3/);

  const { shouldBlockCrossHostClaudeDesktop } = await import(path.join(root, "platform-paths.mjs"));
  assert.equal(shouldBlockCrossHostClaudeDesktop({ platform: "linux", wsl: false, claudeDesktopSelected: true }), true);
  assert.equal(shouldBlockCrossHostClaudeDesktop({ platform: "linux", wsl: true, claudeDesktopSelected: true }), false);
  assert.equal(shouldBlockCrossHostClaudeDesktop({ platform: "linux", wsl: false, claudeDesktopSelected: false }), false);
});

// AGENTS.md كان يخلط بروتوكول المساهم ببروتوكول الإعداد، ولا يأمر بسؤال عن العميل.
test("AGENTS.md separates the setup audience and states the unknowns to ask", async () => {
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /جمهوران/, "يجب أن يفصل جمهور الإعداد من جمهور المساهمة");
  assert.match(agents, /أي عميل MCP تستخدم/, "يجب أن يأمر بسؤال المستخدم عن عميله");
  assert.match(agents, /--node/, "قيمة --node يجب أن تكون موثّقة");
  assert.match(agents, /where\.exe node/, "وطريقة معرفتها");
  assert.match(agents, /EXCALIDRAW_RPC_TIMEOUT_MS/);
  assert.match(agents, /\[mcp_servers\.excalidraw\.env\]/, "وموضع المتغيّر في كل عميل");
  // بروتوكول السياق للمساهم لا للمُعِدّ، فيجب أن يأتي بعد قسم الإعداد.
  assert.ok(
    agents.indexOf("## بروتوكول المساهم") > agents.indexOf("## إذا طلب المستخدم الإعداد"),
    "بروتوكول المساهم يجب أن يكون بعد بروتوكول الإعداد لا قبله",
  );
  assert.match(agents, /استبعد|node_modules/, "بحث الخزنة يجب أن يذكر ما يُستبعد");
  assert.match(agents, /صفر خزنات/, "وحالة انعدام الخزنة");
});
