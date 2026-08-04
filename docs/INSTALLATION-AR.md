# دليل التثبيت

## المتطلبات

- Obsidian Desktop؛ الجسر محلي ولا يعمل في المتصفح.
- Node.js 18 أو أحدث.
- Vault فُتح مرة واحدة على الأقل كي يوجد مجلد `.obsidian`.
- عميل MCP محلي: Claude Code أو Claude Desktop أو Codex أو Cursor ونحوه.

## التثبيت الموصى به

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

## تثبيت دون إنترنت

إذا كانت إضافتا Excalidraw وExtras مثبتتين مسبقًا:

```bash
node install.mjs --vault "<VAULT>" --clients all --offline
```

أو استخدم `--skip-official` لعدم فحصهما نهائيًا.

## Obsidian غير مثبت

لا يثبت هذا الريبو تطبيقًا على مستوى النظام تلقائيًا لأن ذلك يحتاج إذنًا إداريًا ويختلف بين الأنظمة. على الوكيل طلب الإذن ثم استخدام صفحة [Obsidian الرسمية](https://obsidian.md/download) أو مدير الحزم الرسمي المتاح للمستخدم، وبعد فتح Vault ينفذ المثبت أعلاه.

