# تثبيت النظام لـClaude

اختر أولًا: **Claude Desktop** أم **Claude Code**؟ لكل واحد إعداد مختلف.

## Claude Desktop على Windows

1. ثبّت [Obsidian](https://obsidian.md/download)، وأنشئ Vault وافتحه مرة واحدة.
2. نزّل هذا المستودع من **Code → Download ZIP** ثم فك الضغط على قرص Windows.
3. اضغط مرتين على `setup-windows.cmd` واختر مجلد الـVault.
4. افتح Obsidian، ثم افتح أي رسم Excalidraw مرة واحدة.
5. أغلق Claude Desktop **كاملًا من أيقونته قرب الساعة** ثم افتحه من جديد.
6. داخل Claude Desktop افتح قائمة الموصلات وفعّل `excalidraw`.
7. اطلب من Claude: `تحقق من حالة excalidraw`.

الخطوة السادسة إلزامية لـClaude Desktop وحده. وجود الإعداد لا يفعّل الموصل
تلقائيًا.

### إذا كان Claude داخل حاوية أو Linux سحابي

لا تطلب منه تعديل `%APPDATA%` ولا تشغيل المثبّت بمسارات Linux. شغّل
`setup-windows.cmd` بنفسك من Windows. بعد ذلك يستطيع Claude استخدام الأدوات عبر
MCP حتى لو لم تكن طرفيته قادرة على رؤية ملفات جهازك.

## Claude Code

افتح الطرفية داخل مجلد المشروع الذي سيستخدم Claude Code ثم شغّل:

```powershell
node install.mjs --vault "C:\مسار\خزنة Obsidian" --clients project --project-root "."
```

سينشئ المثبّت `.mcp.json` داخل المشروع. أعد تشغيل جلسة Claude Code وافتح أي رسم
داخل Obsidian مرة واحدة. **Claude Code لا يحتاج زر تفعيل الموصل.**

إذا كان Claude Code يعمل عبر WSL، ضع المستودع والـVault على قرص Windows مثل
`C:` أو `/mnt/c` حتى يستطيع المثبّت تحويل المسارات بصورة صحيحة.

## رسالة جاهزة لـClaude Desktop

> اقرأ `START-HERE-AR.md`. ثبّت النظام لعميل Claude Desktop على Windows. إذا كانت
> جلستك لا ترى قرص Windows فلا تكتب مسارات Linux داخل إعداد Claude؛ اطلب مني تشغيل
> `setup-windows.cmd`. بعد التثبيت ذكّرني بإغلاق Claude كاملًا وتفعيل موصل
> `excalidraw`، ثم شغّل فحص الجاهزية إن كانت الطرفية المحلية متاحة.

## رسالة جاهزة لـClaude Code

> اقرأ `CLAUDE.md` و`START-HERE-AR.md`. ثبّت النظام لهذا المشروع باستخدام عميل
> `project`، ثم اطلب مني إعادة تشغيل Obsidian وClaude Code وفتح أي رسم مرة واحدة.
> بعد ذلك شغّل فحص الجاهزية. لا تعدّل إعداد Claude Desktop.

## علامة النجاح

من داخل مجلد المستودع:

```powershell
node doctor.mjs --vault "C:\مسار\خزنة Obsidian" --lang en
```

يجب أن ينتهي بـ:

```text
RESULT install=ready bridge=ok client=registered ready=true
```

إذا نجح الفحص ولم تظهر الأدوات في Claude Desktop، فالسبب الأغلب أن موصل
`excalidraw` لم يُفعّل أو أن التطبيق لم يُغلق كاملًا بعد تعديل الإعداد.
