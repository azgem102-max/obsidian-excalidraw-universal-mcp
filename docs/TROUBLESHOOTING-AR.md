# استكشاف الأخطاء

## الجسر غير متصل

- افتح Obsidian وVault الصحيح.
- تأكد أن Excalidraw وExtras وUniversal MCP Bridge مفعلة.
- افتح رسم Excalidraw واحدًا ثم شغّل `doctor.mjs`.
- أعد تشغيل Obsidian والعميل بعد أي تثبيت أو تحديث للجسر.

## LaTeX أو Mermaid لا يعمل

Excalidraw Extras مفقودة أو غير مفعلة. أعد تشغيل المثبت دون `--skip-official` ثم أعد تشغيل Obsidian.

## النص العربي عاد إلى الخط القديم

مرر ملف الخط عبر `--font`. تحقق من تفعيل `Enable local font option` في إعدادات Excalidraw، ومن أن النص يستخدم `fontFamily: 4`.

## Claude لا يرى أدوات excalidraw

- Claude Code: تأكد من وجود `.mcp.json` في جذر المشروع ثم أعد فتح الجلسة.
- Claude Desktop: استخدم `--clients claude-desktop` ثم أعد تشغيل التطبيق.

إذا كان Claude Code يعمل داخل WSL وClaude Desktop على Windows، تأكد أن الريبو والـVault موجودان تحت `/mnt/c` أو قرص Windows آخر. أعد تشغيل المثبّت؛ سيكتب `node.exe` ومسارات Windows داخل إعداد Claude Desktop. لا تنسخ مسارات `/home/...` إلى ملف Claude على Windows.

إذا كانت جلسة Claude عبارة عن Linux منفصل لا يحتوي `/mnt/c`، شغّل `install-on-windows.ps1` من Windows PowerShell. لا تحاول منح الحاوية مسار `%APPDATA%` ولا تعدّل JSON يدويًا.
- لا تضع مسارًا نسبيًا للخادم في إعدادات عميل خارج الريبو؛ المثبت يكتب مسارًا مطلقًا.

## أمان البيانات

لا تفتح المنفذ 27125 على الشبكة ولا تنسخ رمز `data.json`. لا تستخدم نفقًا عامًا إلى الجهاز. أداة رابط Excalidraw المشفر هي الاتصال الخارجي الوحيد الافتراضي وتعمل عند الطلب الصريح.
