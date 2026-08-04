# Obsidian وExcalidraw مع Claude وCodex

هذا المشروع يجهّز Claude أو Codex أو أي مساعد يدعم MCP لكي يقرأ ويكتب ملاحظاتك، ويفتح رسومات Excalidraw ويعدّلها من داخل Obsidian.

بدل أن تنقل المحتوى بين البرامج أو ترسم كل شيء يدويًا، اطلب ما تريده بالكلام العادي:

> رتّب هذه الأفكار في خريطة ذهنية، وارسمها داخل Obsidian، ثم احفظها في مجلد المشروع.

## أهم ميزة: دعم السكربتات

المشروع لا يكتفي برسم المربعات والأسهم. يستطيع تشغيل سكربتات Excalidraw الحقيقية من داخل Script Engine، لذلك يمكن للذكاء الاصطناعي استخدام الأدوات التي يستعملها مستخدمو الإضافة المحترفون.

تأتي الحزمة مع 32 سكربتًا جاهزًا، منها:

- بناء الخرائط الذهنية وترتيب العناصر تلقائيًا.
- إنشاء العروض والصفحات القابلة للطباعة.
- المعادلات الرياضية وإخفاء أجزاء الصور للمذاكرة.
- التحكم في الألوان والظلال والأحجام والمسافات.
- ربط العناصر، عكس الأسهم، وإنشاء مسارات منظمة.
- إضافة الروابط والملفات وملاحظات Obsidian داخل الرسم.

وإذا أضفت سكربتًا جديدًا لاحقًا، يستطيع النظام اكتشافه وتشغيله دون تعديل الخادم.

هذا العمل مبني ليتكامل مع مشروع [Excalidraw for Obsidian من @zsviczian](https://github.com/zsviczian/obsidian-excalidraw-plugin)، ويستفيد من [مكتبة السكربتات المعروفة للمشروع](https://github.com/zsviczian/obsidian-excalidraw-plugin/wiki/Excalidraw-Script-Engine-scripts-library).

## المشاريع والإضافات المستخدمة

النتيجة الموجودة هنا تعتمد على هذه المشاريع، ولكل واحد منها دور مهم:

- [Obsidian](https://obsidian.md/) — البرنامج الذي تُحفظ داخله الملاحظات والرسومات.
- [Excalidraw for Obsidian من @zsviczian](https://github.com/zsviczian/obsidian-excalidraw-plugin) — إضافة الرسم الأساسية ومحرك تشغيل السكربتات.
- [Excalidraw Extras من @zsviczian](https://github.com/zsviczian/obsidian-excalidraw-extras) — يضيف ميزات الرسم المتقدمة مثل Mermaid والمعادلات.
- [مكتبة سكربتات Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin/wiki/Excalidraw-Script-Engine-scripts-library) — مصدر السكربتات المعروفة التي توسّع إمكانات الرسم والتنظيم.
- [Excalidraw](https://github.com/excalidraw/excalidraw) — محرك الرسم المفتوح الذي تقوم عليه التجربة.
- [mcp_excalidraw من @yctimlin](https://github.com/yctimlin/mcp_excalidraw) — المشروع المرجعي الذي بُني عليه توافق أدوات MCP.

هذا المشروع يجمع هذه الأجزاء ويجهّزها لتعمل مع Claude وCodex بطريقة أبسط، ولا ينسب تطويرها الأصلي لنفسه.

## ماذا يستطيع أن يفعل؟

- كتابة الملاحظات وتنظيمها والبحث فيها.
- إنشاء رسومات Excalidraw وتعديلها وحفظها.
- تشغيل السكربتات على الرسم المفتوح.
- إنشاء خرائط ذهنية ومخططات عمل ورسومات شرح.
- إضافة الصور والروابط والمعادلات والملاحظات داخل الرسم.
- استخدام مكتبة العناصر وإعادة استعمال المكونات.
- تصدير الرسم بصيغة PNG أو SVG.
- مراجعة ترتيب الرسم قبل تسليمه.

## الاستخدام السريع

### 1. جهّز البرامج

ثبّت:

- [Obsidian](https://obsidian.md/)
- [Node.js](https://nodejs.org/) إصدار 18 أو أحدث

بعدها أنشئ خزنة Obsidian وافتحها مرة واحدة.

### 2. حمّل المشروع

```bash
git clone https://github.com/azgem102-max/obsidian-excalidraw-universal-mcp.git
cd obsidian-excalidraw-universal-mcp
```

يمكنك أيضًا تنزيله من زر **Code ثم Download ZIP** في GitHub.

### 3. شغّل المثبّت

على Windows:

```powershell
node install.mjs --vault "C:\مسار\خزنة Obsidian" --clients all --project-root "."
```

على macOS أو Linux:

```bash
node install.mjs --vault "$HOME/Documents/Obsidian Vault" --clients all --project-root "."
```

المثبّت يضيف Excalidraw وملحقاته والسكربتات، ثم يجهّز الاتصال مع Claude وCodex دون حذف إعداداتك الحالية.

### 4. أعد التشغيل

أغلق وافتح من جديد:

- Obsidian
- Claude أو Codex أو البرنامج الذي ستستخدمه

ثم افتح أي رسم Excalidraw داخل Obsidian.

### 5. تأكد أن كل شيء جاهز

```powershell
node doctor.mjs --vault "C:\مسار\خزنة Obsidian"
```

إذا ظهرت عبارة **جاهز للاستخدام** فقد انتهيت.

## الطريقة الأسهل: اترك الذكاء الاصطناعي يجهّزه

بعد تنزيل المشروع، افتح Claude أو Codex داخل مجلد المشروع وأرسل له:

> اقرأ `AGENTS.md` و`START-HERE-AR.md`. جهّز Obsidian وExcalidraw على هذا الجهاز، شغّل المثبّت لخزنتي، ثم اطلب مني إعادة التشغيل وبعدها شغّل فحص الجاهزية.

سيقرأ المساعد التعليمات الموجودة في المشروع وينفذ الإعداد خطوة بخطوة.

## الخط العربي

الخطوط المدفوعة أو الخاصة لا تُنشر داخل المشروع. إذا كنت تملك خطًا عربيًا بصيغة WOFF2، أضفه أثناء التثبيت:

```powershell
node install.mjs --vault "C:\مسار\الخزنة" --clients all --font "C:\مسار\الخط.woff2"
```

## إذا احتجت تفاصيل أكثر

- [ابدأ من هنا](./START-HERE-AR.md)
- [دليل السكربتات](./SCRIPT-CATALOG-AR.md)
- [الاستخدام مع الذكاء الاصطناعي](./docs/AI-USAGE-AR.md)
- [حل المشكلات](./docs/TROUBLESHOOTING-AR.md)

المشروع تطوير مستقل وليس إصدارًا رسميًا من فريق Excalidraw. تراخيص المصادر مذكورة في [إشعارات الطرف الثالث](./THIRD_PARTY_NOTICES.md).
