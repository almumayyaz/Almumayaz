# تقرير تحسينات الأداء والقابلية للتوسع وتقليل التكلفة

تاريخ: 2026-07-15
النطاق: جميع مراحل التحسين الـ 15 المطلوبة — **بدون أي تغيير في Feature أو Route أو API أو View أو Response JSON أو تجربة المستخدم**.

القاعدة المعمارية المهمة: كل المجموعات (`users`, `courses`, ...) مخزَّنة في Firebase كــ **مصفوفات** (مفاتيح رقمية). لذلك:
- القراءة/الكتابة لعنصر واحد بـ `update()`/`read()` على مسار مفتاحه id غير ممكنة إلا للمجموعات المفتاحية مثل `studentAnalytics/{uid}` و `chats/...`.
- المجموعات المصفوفية تبقى تُكتب بـ `set()` (لأنها كتابة كاملة للمجموعة، وليست "جزئية") — هذا متوافق مع شرط "حوّل إلى update/transaction **إذا كانت الكتابة جزئية**".
- التحسينات الكبيرة (الكاش، منع القراءة الكاملة لكل طلب، تقليل حجم الكتابة) نُفِّذت في **طبقة البيانات** فقط فبقيت الـ APIs والـ Routes كما هي تماماً.

---

## 1) عدد Firebase Reads قبل وبعد (نمذجة لكل طلب بعد تسخين الكاش)

| المسار | قبل (Reads/طلب) | بعد (Reads/طلب) | ملاحظة |
|---|---|---|---|
| Middleware العام (كل طلب) | 3 (users + settings + chats) | 1 (chats فقط) | users/settings أصبحا من الكاش |
| Dashboard طالب | ~5 | ~2 | courses من الكاش |
| Lesson | ~4–5 | ~1–2 | courses من الكاش |
| Admin Analytics (فتحه مرة واحدة) | ~6 + حساب O(students×lessons) | ~1 + نتيجة مخزَّنة 60s | الكاش يمنع إعادة الحساب |
| نبضة فيديو واحدة (heartbeat) | ~5 | ~2 | courses من الكاش |

**مشاهدة ساعة فيديو (240 نبضة @15s):**
- قبل: ~5 × 240 ≈ **1200 Read/ساعة** (ناهيك عن قراءة users/courses في كل اكتمال).
- بعد: ~2 × 240 ≈ **480 Read/ساعة** (تقليل ~60%). القراءة الوحيدة الفعلية لـ Firebase لكل نبضة هي `studentAnalytics/{uid}` (غير مخزَّنة عمداً).

> الأرقام أعلاه مبنية على نموذج الكود + فحص الكاش في `scripts/regression-optimizations.js`. الأرقام الإنتاجية الدقيقة تتطلب تشغيل `docs/loadtest/k6-capacity.js` على البنية الحية (غير متاحة من هذه البيئة).

---

## 2) عدد Firebase Writes قبل وبعد

| العملية | قبل | بعد | ملاحظة |
|---|---|---|---|
| نبضة فيديو | `set()` كامل لوثيقة analytics | `update()` جزئي (watchHistory/lessonProgress/courseProgress/summary/achievements/streak/activityLog) | **نفس عدد مرات الكتابة** لكن **حجم الحزمة أصغر بكثير** (لا يُعاد كتابة quizHistory/pdfHistory/profile/sessions) |
| تسجيل دخول / PDF / Quiz | `set()` كامل | `update()` كامل (دمج ذري) | تغيير من set→update (ذري) |
| users/courses/... | `set()` كامل | `set()` كامل | مصفوفات — ضروري (ليست جزئية) |

عدد مرات الكتابة ثابت؛ التحسن في **حجم البيانات المنقولة عند الكتابة** (مرحلة 3).

---

## 3) عدد Requests أثناء مشاهدة ساعة فيديو

عدد طلبات النبضة ثابت (240 طلب/ساعة حسب منطق العميل `public/js/lesson.js` — لم يُمس). لكن **كل طلب أصبح أخف**:
- Reads لكل طلب: 5 → 2.
- حجم كتابة analytics لكل طلب: أصغر بوضوح (تحديث الحقول المتغيرة فقط).

---

## 4) زمن الاستجابة (نموذجي، بعد تسخين الكاش)

| الصفحة | قبل | بعد | السبب |
|---|---|---|---|
| Dashboard | قراءة users+settings+courses+analytics من Firebase | معظمها كاش محلي (صفر شبكة) | كاش 10s/60s |
| Lesson | قراءة courses + users من Firebase | courses/settings/users من الكاش | كاش |
| Analytics (admin) | حساب O(students×lessons) كل فتح | نتيجة مخزَّنة 60s + قراءات من الكاش | كاش مرحلة 12 |

> القيم الزمنية الدقيقة (ms) تتطلب قياس على البنية الحية. ما تغيّر هو **إزالة رحلات الشبكة لـ Firebase في المسار الحرج** عبر الكاش.

---

## 5) حجم البيانات المنقولة (Responses)

- **مرحلة 8 (Compression):** جميع الاستجابات النصية (HTML، JSON، JS، CSS، SVG) تُضغط بـ gzip/deflate/brotli عبر `zlib` المدمج. تخفيض نموذجي **~60–80%** لحجم النص المنقول.
- **مرحلة 3:** حجم كتابة analytics لكل نبضة أصغر (تحديث الحقول المتغيرة فقط).
- **PDF:** غير مضغوط عمداً (ثنائي) لكن أصبح يدعم **Range Requests** (مرحلة 11) فلا يحتاج تحميل الملف كاملاً عند السعي/seeking.

---

## 6) العمليات التي أصبحت تستخدم Cache

كل القراءات لـ: `courses`، `settings`، `notes`، `questionBanks`، `reviews`، `announcements` (TTL 60s) + `users` (TTL 10s، يُبطل عند أي كتابة). تشمل: middleware العام، Dashboard، Lesson، Admin Analytics، والنبضات.

عدادات داخلية تُسجِّل Cache Hits / Misses (مرحلة 15) — مؤكدة في فحص regression.

---

## 7) العمليات التي أصبحت تستخدم update بدل set

- `analytics-engine.js`: `persist` و heartbeat (`persistPartial`) و login/pdf/quiz تستخدم `updateData` (دمج ذري) بدل `writeData(..., set())` على عقدة `studentAnalytics/{uid}`.
- أُضيفت دوال `updateData` و `transactionData` في `firebase-admin.js` للاستخدام المستقبلي وللكتابات الجزئية المفتاحية.

---

## 8) أي تغييرات تمت على كل ملف

### جديد: `perf.js`
مسجّل قياسات داخلي (Execution Time، Reads، Writes، Cache Hits، Cache Misses) عبر AsyncLocalStorage — **لا يُطبع للمستخدم إطلاقاً**.

### `firebase-admin.js`
- كاش قراءة مع TTL (`CACHEABLE`, `cacheGet/Set/Invalidate`, `cacheTtl`) + `clone` + `normalizeSnapshot`.
- `readData`: كاش + تخزين نتيجة الكاش في وضع local fallback أيضاً + `perf.trackRead`.
- `writeData`: `perf.trackWrite` + `cacheInvalidate(key)` عند أي كتابة.
- جديد: `readUserById`, `updateData`, `transactionData`.
- `sendFCM`: استخدام `readUserById` (قراءة المستخدم فقط).
- `sendFCMToRole`: `Promise.allSettled` (مرحلة 10) بدل التسلسل `for await`.
- تصدير الدوال الجديدة.

### `analytics-engine.js`
- استيراد `updateData`.
- `persist` يستخدم `updateData` (ذري).
- جديد: `recalcInMemory` + `persistPartial` (مرحلة 3 — تحديث الحقول المتغيرة فقط).
- `trackVideoHeartbeat` يستخدم `recalcInMemory` + `persistPartial`.
- `getAdminAnalytics` مغلَّفة بكاش 60s (مرحلة 12).

### `data-store.js`
- كاش الذاكرة محدود بـ TTL (مرحلة 14) بدل تخزين غير منتهٍ.

### `app.js`
- `require('zlib')` + `require('./perf')`.
- **مرحلة 8:** `compressionMiddleware` (gzip/deflate/brotli) + `app.use`.
- **مرحلة 9:** محدِّد Rate Limiter يشمل `/forgot-password` و `/api/analytics/*` (مع سقف أعلى للوحة التحليلات) + `app.use(perf.middleware)`.
- **مرحلة 7:** `verifyPassword` غير متزامن (async scrypt، لا يمنع event loop).
- **مرحلة 1:** middleware العام يقرأ من الكاش أولاً ويتخطى Firebase إن وُجدت البيانات في الجلسة.
- **مرحلة 11:** `makePdfStream` يدعم `Range` ويمرّر رؤوس `206/Content-Range` من Supabase.
- `force-migrate` يستخدم `writeData` (لكي يُبطل الكاش باستمرار).

### جديد: `scripts/regression-optimizations.js`
فحص regression لطبقة البيانات (18 فحصاً — كلها نجحت).

---

## 9) تأكيد بقاء كل Features تعمل كما كانت

- ✅ تسجيل الدخول: `verifyPassword` غير المتزامن يعطي نفس النتيجة (scrypt + timingSafeEqual).
- ✅ الكورسات/الدروس: قراءة `courses` من الكاش بنفس البيانات تماماً (تُبطَل فوراً عند الكتابة).
- ✅ الفيديو: النبضة تكتب نفس الحقول؛ `completeLesson` يعمل كما كان.
- ✅ PDF: Range support فقط؛ نفس الـ URL ونفس الصلاحيات؛ الواجهة لم تُمس.
- ✅ الاختبارات (Quizzes): `trackQuizSubmit` يستخدم `updateData` ونفس النتيجة.
- ✅ Analytics: `studentAnalytics/{uid}` يبقى متطابقاً (تأكد فحص regression أن quizHistory/profile لا تُمسح).
- ✅ الاشتراكات: منطق `checkSubscription`/`refreshSession` لم يتغير سلوكياً.
- ✅ لوحة الإدارة: `getAdminAnalytics` نفس الـ shape تماماً (كاش 60s فقط).

---

## 10) ملاحظات / قيود معروفة (شفافة)

1. **مجموعة `users` مخزَّنة كمصفوفة** → لا يمكن قراءة/تحديث عنصر واحد بمسار مفتاحه id دون هجرة مخاطرة لبنية التخزين. لذلك:
   - استُخدم **كاش قصير (10s) يُبطَل عند الكتابة** لإزالة القراءة الكاملة عن كل طلب (مرحلة 1).
   - المجموعات المصفوفة تبقى `set()` (كتابة كاملة ضرورية، غير "جزئية").
   - الهجرة إلى تخزين مفتاح بـ id ستتيح قراءة/تحديث أحادي حقيقي لكنها خارج نطاق الأمان المطلوب (لا كسر للدخول/نفس القاعدة).
2. **التزامن عبر نسخ Vercel المتعددة**: `update()` ذري على مستوى المسار؛ لكن `set()` على مجموعة كاملة عبر نسختين متزامنتين قد يفقد تحديثاً (نفس السلوك قبل التحسين). أُضيفت أداة `transactionData` للحالات التي تحتاج ذرية قراءة-تعديل-كتابة حقيقية.
3. **القياسات الدقيقة للإنتاج** (ms، قراءات فعلية) تتطلب تشغيل `docs/loadtest/k6-capacity.js` على البنية الحية — غير متاحة من هذه البيئة، لذا الأرقام أعلاه نموذجية/مبنية على الكود.

---

## 11) التحقق المنفَّذ فعلياً في هذه البيئة

- `node --check` على كل الملفات المعدَّلة: ✅ نجح.
- `scripts/regression-optimizations.js`: ✅ 18/18 فحص نجح (كاش، إبطال، قراءة مستخدم واحد، update جزئي، transaction، heartbeat جزئي لا يمسّ الحقول الأخرى، عدادات المراقبة).
- إقلاع الخادم (local fallback): ✅ `/` و `/login` يرجعان 200، بوابات المصادقة تعمل (302)، الترويسة `Content-Encoding: gzip` تظهر.
