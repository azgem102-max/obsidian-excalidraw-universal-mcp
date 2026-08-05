# تثبيت النظام لـCodex وChatGPT

## قبل أن تبدأ

الدعم المباشر هنا هو **Codex على جهازك** أو أي تطبيق ChatGPT يدعم خادم MCP
محليًا. موقع ChatGPT داخل المتصفح لا يستطيع وحده فتح خزنة Obsidian الموجودة على
جهازك؛ استخدم Codex أو عميلًا محليًا يدعم MCP.

## Windows — الطريقة الأسهل

1. ثبّت [Obsidian](https://obsidian.md/download)، وأنشئ Vault وافتحه مرة واحدة.
2. نزّل هذا المستودع من **Code → Download ZIP** ثم فك الضغط.
3. اضغط مرتين على `setup-windows.cmd` واختر مجلد الـVault.
4. افتح Obsidian، ثم افتح أي رسم Excalidraw مرة واحدة.
5. أغلق Codex وافتحه من جديد.
6. اطلب من Codex: `تحقق من حالة excalidraw`.

لا تبحث عن زر موصل داخل Codex؛ هذا الزر يخص Claude Desktop فقط. المثبّت يسجّل
الخادم باسم `excalidraw` في إعداد Codex تلقائيًا.

## التثبيت بالأمر

استخدمه إذا كنت تفضّل الطرفية:

```powershell
node install.mjs --vault "C:\مسار\خزنة Obsidian" --clients codex
```

ثم أعد تشغيل Obsidian وCodex، وافتح أي رسم مرة واحدة.

## رسالة جاهزة لـCodex

> اقرأ `AGENTS.md` و`START-HERE-AR.md`. ثبّت النظام لعميل Codex فقط، وابحث عن
> خزنة Obsidian أو اسألني عن مسارها. بعد التثبيت اطلب مني إعادة تشغيل Obsidian
> وCodex وفتح أي رسم مرة واحدة، ثم شغّل `doctor.mjs`. لا تعدّل إعداد Claude.

## علامة النجاح

من داخل مجلد المستودع:

```powershell
node doctor.mjs --vault "C:\مسار\خزنة Obsidian" --lang en
```

يجب أن ينتهي بـ:

```text
RESULT install=ready bridge=ok client=registered ready=true
```

إذا لم يظهر `excalidraw` بعد نجاح الفحص، أغلق جلسة Codex وافتح جلسة جديدة.
