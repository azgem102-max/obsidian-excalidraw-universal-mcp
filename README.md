# Excalidraw Universal MCP

تطوير موسّع لخادم Excalidraw MCP يجعل أي عميل يدعم MCP — مثل Codex وClaude Code وClaude Desktop وCursor — يتعامل مع رسومات Excalidraw الأصلية داخل Obsidian من مجموعة أدوات واحدة.

> للمستخدم الجديد أو لوكيل AI: ابدأ بملف **[START-HERE-AR.md](./START-HERE-AR.md)**. يشرح أمر التثبيت الواحد وما يجب على Claude أو Codex فعله دون تشغيل اختبارات التطوير.

الحزمة قابلة للنشر كريبو مستقل، وتحتوي `CLAUDE.md` و`AGENTS.md` وسياقًا مشتركًا مختصرًا كي يستطيع وكيل جديد متابعة الإعداد والصيانة دون معرفة مسبقة بجهاز المؤلف.

الهدف ليس إنشاء «إضافة أدوات منفصلة» يجب على الذكاء الاصطناعي تعلمها، بل الحفاظ على أسماء وصيغ أدوات Excalidraw MCP المألوفة وجعلها تعمل مباشرة على الرسم المفتوح داخل Obsidian. أما اختلافات ملفات الـVault ومحرك السكربتات والتصدير فيعالجها الخادم داخليًا.

## التجربة النهائية

```text
أي AI يدعم MCP
        │
        ▼
خادم واحد باسم excalidraw
        │
        ├── أدوات Excalidraw القياسية
        ├── الرسم المفتوح داخل Obsidian
        ├── ملفات ورسومات الـVault
        ├── ExcalidrawAutomate
        └── Script Engine وكل السكربتات المثبتة
```

بعد التثبيت لا يرى العميل خادمين منفصلين لـExcalidraw وObsidian؛ يرى خادمًا واحدًا باسم `excalidraw`.

## التوافق مع MCP الحالي

يوفر الخادم الأدوات الـ26 المعروفة في `mcp-excalidraw-server` وبصيغ إدخال متوافقة:

- إنشاء العناصر وقراءتها وتعديلها وحذفها والبحث عنها ونسخها.
- الإنشاء الدفعي مع النصوص وربط الأسهم عبر `startElementId` و`endElementId`.
- المحاذاة والتوزيع والتجميع وفك التجميع والقفل.
- وصف المشهد والتقاط صورة يعاينها الـAI مباشرة.
- استيراد المشهد وتصديره، وتصدير PNG وSVG، وإنشاء رابط Excalidraw مشفر اختياريًا.
- مسح اللوحة واللقطات المؤقتة والاستعادة والتحكم في الكاميرا.
- تحويل Mermaid إلى عناصر Excalidraw حقيقية.
- قراءة المكتبة والسمة والعناصر ودليل جودة الرسم.

هذه الأدوات تعمل على رسم Obsidian Excalidraw النشط بدل لوحة مؤقتة في الذاكرة، لذلك يبقى الرسم محفوظًا كجزء من الـVault.

## قدرات Obsidian والكتابة وScript Engine

تضاف فوق الأدوات المتوافقة قدرات أصلية لا يوفرها MCP العادي:

- `status` — حالة Obsidian وExcalidraw والرسم النشط.
- `list_drawings` و`open_drawing` و`create_drawing` — إدارة رسومات الـVault.
- `list_notes` و`read_note` و`create_note` و`update_note` — كتابة الملاحظات وخصائصها وقراءتها.
- `move_note` و`trash_note` — تنظيم الملفات مع حذف قابل للاستعادة.
- `search_notes` و`get_backlinks` و`get_vault_structure` — البحث وفهم الروابط وبنية قاعدة المعرفة.
- `select_elements` — تجهيز تحديد برمجي لسكربت يعتمد على العناصر المحددة.
- `list_scripts` و`run_script` — اكتشاف السكربتات وتشغيلها داخل Script Engine الحقيقي.
- `save_drawing` — حفظ ملف الرسم الأصلي.
- `add_image` — إدراج صور مع ملفات Excalidraw المضمنة الصحيحة.
- `add_latex` — تحويل LaTeX إلى عنصر رسومي.
- `add_embeddable` — تضمين رابط أو ملاحظة Obsidian تفاعلية.
- `add_frame` — إنشاء إطار حقيقي لتنظيم المشهد أو العرض.
- `set_z_order` و`apply_style_to_elements` — ترتيب الطبقات وتطبيق نمط موحّد.
- `create_drop_shadow` — إنشاء ظل مهني قابل للتحرير بطريقة Excalidraw الأصلية.
- `set_pen` مع نوع `freedraw` — الأقلام المخصصة والهايلايتر والرسم الحر البرمجي.
- `save_elements_to_library` و`search_library` و`insert_library_item` و`search_vault_images` — إنشاء مكوّنات قابلة لإعادة الاستخدام والبحث في الأصول والمكتبات وإدراجها مباشرة.
- `create_obsidian_link` و`create_transclusion` و`set_drawing_frontmatter` — روابط Obsidian والمراجع الجزئية وخصائص الرسم.
- `inspect_visual_quality` — فحص هندسي مبدئي قبل الصورة والمراجعة البصرية.

المجموع الحالي 59 أداة في خادم واحد.

لا تعني هذه الأدوات أن كل تدفق احترافي أصبح مكتملًا بعد. توجد [مصفوفة قدرات وخطة وصول إلى الأتمتة الكاملة](./CAPABILITY-MATRIX.md) تميّز بوضوح بين الجاهز، وما يعمل عبر السكربتات، وما يحتاج أداة MCP أصلية جديدة.

## السكربتات دون إعداد يدوي

لا يعرّف الخادم أداة ثابتة لكل سكربت. يقرأ `list_scripts` مجلد Script Engine المضبوط داخل إضافة Excalidraw في كل مرة، لذلك:

- تظهر الحزمة المثبتة حاليًا تلقائيًا.
- يظهر أي سكربت يضاف لاحقًا دون تحديث MCP.
- يشغّل `run_script` السكربت داخل محرك Excalidraw الأصلي، وليس محاكاة خارجية.
- يمكن تمرير العناصر المحددة وإجابات `suggester` و`inputPrompt` برمجيًا كي لا تتوقف العملية على نافذة يدوية.

مثال:

```json
{
  "script": "أدوات التخطيط/Set Text Alignment",
  "elementIds": ["phase-2-body"],
  "responses": ["right"]
}
```

## الأمان

- الإضافة تستمع على `127.0.0.1` فقط ولا تكون متاحة لأجهزة الشبكة.
- تنشئ رمز وصول عشوائيًا عند أول تشغيل ويحفظ داخل إعدادات الإضافة في الـVault.
- كل طلب تعديل يمر عبر رمز الوصول وطابور عمليات متسلسل.
- لكل عملية مهلة حماية؛ تعطل سكربت واحد لا يجمد بقية الأدوات إلى ما لا نهاية.
- لا يوجد اتصال خارجي افتراضيًا. أداة `export_to_excalidraw_url` وحدها ترفع نسخة مشفرة عند استدعائها صراحة.
- تشغيل السكربتات مقصور على الملفات الموجودة داخل مجلد Script Engine المثبت.

## التثبيت

المتطلبات الوحيدة قبل المثبت هي Obsidian Desktop وNode.js 18+ وVault فُتح مرة واحدة. يثبت الأمر التالي الإضافتين الرسميتين والجسر والسكربتات، ثم يضبط Claude وCodex وإعداد المشروع:

```bash
node install.mjs --vault "<Obsidian Vault>" --clients all --project-root "."
```

الإصدارات الرسمية المقفلة موثقة في `plugin-versions.json`. يحفظ المثبت نسخة احتياطية من إعداد MCP، ويدمج تعريفًا واحدًا باسم `excalidraw` دون حذف الخوادم الأخرى. يمكن إضافة خط محلي يملكه المستخدم عبر `--font`؛ لا يوزع الريبو خط ثمانية.

بعد التثبيت يجب إعادة تشغيل Obsidian وعميل MCP مرة واحدة، ثم تشغيل الفحص السريع:

```bash
node doctor.mjs --vault "<Obsidian Vault>"
```

التفاصيل وخيارات offline والعملاء في [دليل التثبيت](./docs/INSTALLATION-AR.md)، وخطوات إنشاء المستودع العام أو الخاص في [دليل النشر](./docs/PUBLISHING-AR.md).

## الاختبار

آخر قبول مثبت للإصدار `0.5.3`: فحوص الحزمة 19/19، جولتا قبول حي 53/53 لكل جولة، وتغطية الأدوات المكملة 11/11. شُغلت 4 سكربتات احترافية قابلة للأتمتة، أما السكربتات التي تحتاج واجهة أو أصول المستخدم فموثقة بصفتها تفاعلية في [مصفوفة القبول](./ACCEPTANCE-TEST-MATRIX.md).

```powershell
node --check tools/obsidian-excalidraw-mcp/obsidian-plugin/main.js
node --check tools/obsidian-excalidraw-mcp/server.mjs
node --test tools/obsidian-excalidraw-mcp/tests/*.test.mjs
node tools/obsidian-excalidraw-mcp/server.mjs --self-test
```

المستخدم النهائي لا يحتاج اختبارات التطوير؛ يكفي `doctor.mjs`. للمساهمين فقط، بعد إعادة تشغيل Obsidian يمكن تشغيل اختبار القبول الحي. ينشئ ملفات داخل `مختبر القبول MCP` فقط ويحفظ التقرير والصور في مجلد الإخراج:

```powershell
node tools/obsidian-excalidraw-mcp/tests/live-acceptance.mjs --vault "C:\Users\name\Documents\Obsidian Vault" --output ".tmp\obsidian-excalidraw-acceptance"
```

الاختبار يغطي الكتابة والخصائص والروابط الخلفية، أنواع العناصر والأساليب والظلال والطبقات، اللقطات والاستعادة، الصور وLaTeX والتضمينات وMermaid، دورة المكتبة، الحفظ والتصدير، والحزمة الأساسية ذات 17 سكربتًا.

## المصدر الذي بُني عليه التوافق

- خادم MCP الحالي: [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)
- إضافة Obsidian Excalidraw وواجهة ExcalidrawAutomate: [zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)

تراخيص المصادر تختلف: خادم MCP المرجعي وExcalidraw core بترخيص MIT، وإضافتا Obsidian الرسميتان بترخيص AGPL-3.0. انظر [إشعارات الطرف الثالث](./THIRD_PARTY_NOTICES.md). هذا التطوير ليس مشروعًا رسميًا تابعًا لفريق Excalidraw.
