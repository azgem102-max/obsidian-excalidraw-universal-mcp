# دليل التثبيت

## المتطلبات

- Obsidian Desktop؛ الجسر محلي ولا يعمل في المتصفح.
- Node.js 18 أو أحدث.
- Vault فُتح مرة واحدة على الأقل كي يوجد مجلد `.obsidian`.
- عميل MCP محلي: Claude Code أو Claude Desktop أو Codex أو Cursor ونحوه.

## التثبيت الموصى به

### Windows من دون أوامر

1. فك ضغط المشروع.
2. اضغط مرتين على `setup-windows.cmd`.
3. اختر خزنة Obsidian من النافذة.
4. بعد النجاح، أعد تشغيل Obsidian وبرنامج الذكاء الاصطناعي مرة واحدة.

يعالج الملف سياسة تشغيل PowerShell تلقائيًا، ولا يطلب من المستخدم كتابة مسار. إذا كان Node.js غير موجود، يطلب الموافقة ثم يستخدم `winget` لتثبيت النسخة الرسمية المستقرة. إذا لم يكن `winget` متاحًا، يفتح صفحة Node.js الرسمية فقط ولا يجري تثبيتًا صامتًا.

### التثبيت من الطرفية

```bash
node install.mjs --vault "<VAULT>" --clients all --project-root "."
```

المثبت:

- ينزّل Excalidraw وExcalidraw Extras من إصدارات GitHub الرسمية المقفلة في `plugin-versions.json` إذا كانا مفقودين.
- يحافظ على إصدار رسمي مثبت مختلف افتراضيًا. استخدم `--force-plugin-versions` فقط إذا أردت التطابق الحرفي مع ملف القفل؛ يأخذ نسخة احتياطية قبل الاستبدال.
- يثبت الجسر ويفعّل الإضافات الثلاث في `community-plugins.json`.
- يثبت الحزمتين الأساسيتين والاحترافيتين والدليل العربي داخل الـVault.
- يدمج إعداد `excalidraw` داخل ملفات العملاء من دون حذف خوادم MCP الأخرى، ويأخذ نسخة `.bak` مرة واحدة.

## خيارات العملاء

- `--clients project` ينشئ `.mcp.json` في المشروع، وهو الأنسب لـClaude Code.
- `--clients codex` يحدّث `~/.codex/config.toml`.
- `--clients claude-desktop` يحدّث ملف Claude Desktop في المسار القياسي للنظام.
- `--clients all` يضبط الثلاثة.

يمكن تمرير قائمة مثل `--clients project,codex`.

## Claude داخل WSL وClaude Desktop على Windows

لا تشغّل إعداد Claude Desktop بمسارات Linux عادية. المثبّت يكتشف WSL تلقائيًا ويحوّل مسار الخادم والـVault إلى مسارات Windows، ويستخدم `node.exe` الخاص بـWindows داخل ملف Claude Desktop.

يشترط أن يكون الريبو والـVault على قرص Windows ظاهر داخل WSL، مثل `/mnt/c`. يمكن تمرير المسار بصيغة Windows أو WSL:

```bash
node install.mjs --vault "C:\Users\name\Documents\Obsidian Vault" --clients claude-desktop
```

إذا كان الريبو داخل `/home` فقط، يتوقف المثبّت قبل كتابة إعداد غير صالح ويطلب نقله إلى قرص Windows. وإذا كانت جلسة الوكيل لا تملك صلاحية الكتابة داخل `%APPDATA%\Claude`، يعرض المثبّت أمر Windows PowerShell جاهزًا ليشغله المستخدم مرة واحدة.

## جلسة Linux منفصلة عن Windows

بعض وكلاء الذكاء الاصطناعي يعملون داخل حاوية Linux لا ترى قرص Windows أصلًا. في هذه الحالة يمنع المثبّت إعداد Claude Desktop تلقائيًا، لأن أي مسار Linux سيصبح غير صالح داخل تطبيق Windows.

نزّل الريبو على Windows، ثم افتح Windows PowerShell داخل مجلده وشغّل:

```powershell
.\install-on-windows.ps1 -Clients "claude-desktop"
```

السكربت يبحث عن `node.exe` على Windows ويشغّل المثبّت بالمسارات الصحيحة. لا يحتاج المستخدم إلى فتح ملف إعداد Claude أو تعديله يدويًا.

## تثبيت دون إنترنت

إذا كانت إضافتا Excalidraw وExtras مثبتتين مسبقًا:

```bash
node install.mjs --vault "<VAULT>" --clients all --offline
```

أو استخدم `--skip-official` لعدم فحصهما نهائيًا.

## Obsidian غير مثبت

لا يثبت هذا الريبو تطبيقًا على مستوى النظام تلقائيًا لأن ذلك يحتاج إذنًا إداريًا ويختلف بين الأنظمة. على الوكيل طلب الإذن ثم استخدام صفحة [Obsidian الرسمية](https://obsidian.md/download) أو مدير الحزم الرسمي المتاح للمستخدم، وبعد فتح Vault ينفذ المثبت أعلاه.
