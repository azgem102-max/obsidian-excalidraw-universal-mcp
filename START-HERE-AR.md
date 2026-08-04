# ابدأ من هنا — Obsidian وExcalidraw لأي وكيل AI

هذا هو الملف الوحيد الذي يحتاجه المستخدم في البداية. أعطِ الريبو إلى Claude Code أو Codex أو أي وكيل محلي قادر على تشغيل الأوامر وقل له:

> اقرأ `CLAUDE.md` أو `AGENTS.md`، ثم جهّز هذا الجهاز لاستخدام Obsidian وExcalidraw عبر MCP. ابحث عن الـVault إن أمكن، وإن وجدت أكثر من واحد فاسألني أيها أختار. نفّذ المثبت، اطلب مني إعادة تشغيل Obsidian والعميل مرة واحدة، ثم شغّل فحص الجاهزية فقط. لا تشغّل اختبارات التطوير الطويلة.

## ما الذي سيُثبت؟

1. **Obsidian** — التطبيق المضيف. إذا لم يكن مثبتًا يطلب الوكيل إذن المستخدم ثم يثبته من المصدر الرسمي أو يفتح صفحة التنزيل.
2. **Excalidraw 2.25.3** — الرسم الأصلي داخل Obsidian.
3. **Excalidraw Extras 0.0.15** — Mermaid وMathJax/LaTeX والطباعة والمكونات الثقيلة.
4. **Excalidraw Universal MCP Bridge 0.5.3** — القراءة والكتابة والرسم والسكربتات من Claude وCodex.
5. **32 سكربتًا** — 17 أداة تخطيط أساسية و15 سكربتًا احترافيًا.
6. إعداد MCP محلي باسم `excalidraw` للعميل المختار.

## الطريقة الأسهل على Windows

بعد فك ضغط المشروع، اضغط مرتين على:

`setup-windows.cmd`

ستظهر نافذة لاختيار خزنة Obsidian، ثم يُثبّت كل شيء ويضبط Claude وCodex تلقائيًا. لا يحتاج المستخدم إلى معرفة المسار أو تعديل أي ملف. وإذا كان Node.js مفقودًا، يطلب الملف الموافقة قبل تثبيت النسخة الرسمية المستقرة.

## أمر التثبيت الموحد

يتطلب Node.js 18 أو أحدث وObsidian Vault موجودًا مرة واحدة على الأقل:

```powershell
node install.mjs --vault "C:\Users\name\Documents\Obsidian Vault" --clients all --project-root "."
```

إذا كان الوكيل يعمل داخل Linux منفصل عن Windows، يشغّل المستخدم من Windows PowerShell داخل مجلد الريبو:

```powershell
.\install-on-windows.ps1 -Clients "claude-desktop"
```

على macOS أو Linux يتغير مسار الـVault فقط:

```bash
node install.mjs --vault "$HOME/Documents/Obsidian Vault" --clients all --project-root "."
```

لإضافة خط عربي محلي يملكه المستخدم:

```powershell
node install.mjs --vault "C:\path\to\Vault" --clients all --font "C:\path\to\arabic-font.woff2"
```

لا يوزع الريبو خط «ثمانية» لأن صفحة التنزيل الرسمية تتطلب الحصول عليه من صاحبه مباشرة. يدعم المثبت أي ملف `otf` أو `ttf` أو `woff` أو `woff2` يملكه المستخدم، ويجعله الخط الرابع داخل Excalidraw تلقائيًا.

## بعد التثبيت

1. أغلق Obsidian وافتحه مرة واحدة.
2. أغلق Claude/Codex/العميل وافتحه مرة واحدة.
3. افتح أي رسم Excalidraw داخل Obsidian.
4. نفّذ فحصًا سريعًا غير هدّام:

```powershell
node doctor.mjs --vault "C:\path\to\Vault"
```

ظهور `جاهز للاستخدام` يعني أن الوكيل يستطيع قراءة الملاحظات وكتابتها وإنشاء الرسومات وتعديلها وتشغيل السكربتات.

## أول طلب عملي

> افتح ملاحظة جديدة باسم «تجربة النظام»، اكتب فيها ملخصًا عربيًا، ثم أنشئ رسم Excalidraw منظمًا يوضح الفكرة. استخدم خط العائلة الرابعة، التقط صورة للرسم، أصلح أي تداخل، ثم احفظه.

لا يحتاج المستخدم النهائي إلى تشغيل `live-acceptance.mjs`. هذا اختبار تطوير وصيانة، أما `doctor.mjs` فهو فحص الجاهزية اليومي.
