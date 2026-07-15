# تقرير المراجعة الأمنية الشاملة — منصة المُميَّز التعليمية

> **منهجية المراجعة:** اعتمد هذا التقرير **حصريًا على فحص الكود المصدري الموجود فعليًا** في المستودع (`app.js` بطول 2912 سطرًا، `firebase-admin.js`, `supabase-storage.js`, `sw.js`, قوالب `views/`, ملف `.env`، و`.gitignore`). لُم تفترض أي ثغرة دون دليل من الكود، ولم تُدرج أي نقطة إلا مع الإشارة إلى **اسم الملف ورقم السطر** ومقاطع الكود الداعمة. أي حالة تعذّر إثباتها من الكود (مثل قواعد حماية Firebase في الكونسول) وُضِعت تحت بند "يتطلب التحقق من الإعدادات الخارجية".

| البيان | القيمة |
|---|---|
| اسم المشروع | lughati-platform (منصة المُميَّز) |
| نوع التطبيق | Express 4 + EJS + JavaScript (Monolith) على Vercel Serverless |
| تاريخ المراجعة | 2026-07-13 |
| نطاق المراجعة | الكود المصدري فقط (لا يشمل إعدادات الكونسول الخارجية) |
| نتيجة التقييم الأمني الإجمالية | **3 / 10** |

---

## أولاً: تحليل البنية (Routes / APIs / Middleware / Services)

### أ.1 الـ Middleware المعرَّفة (app.js)

| الدالة | السطر | الشرط | الاستخدام |
|---|---|---|---|
| `requireAuth` | 95 | وجود `req.session.user` | حماية مسارات الطالب/الأب |
| `requireAdmin` | 100 | `role === 'admin'` | حماية كل مسارات `/admin` و`/api/admin/*` |
| `requireStudent` | 581 | `student`/`admin` | صفحات الطالب |
| `requireStudentOrGuest` | 575 | طالب/مدير/ضيف/وضع تجريبي | صفحات الدروس العامة |
| `requireParent` | 1036 | `role === 'parent'` | لوحة ولي الأمر |
| `checkSubscription` | 105 | اشتراك فعّال وإلا يُعلَّم منتهيًا | فحص الاشتراك |
| `refreshSession` | 123 | مزامنة الجلسة من DB (خنق 30s) | يُطبَّق عالميًا (`app.use` سطر 189) |

### أ.2 جدول نقاط النهاية (Representative Endpoint Table)

| Endpoint | Method | Authentication | Authorization | يستخدمه من؟ | الخطورة |
|---|---|---|---|---|---|
| `/` , `/courses`, `/subscriptions`, `/contact`, `/login`, `/register` | GET | لا شيء | عام | الجميع | منخفضة |
| `/api/auth/firebase-login` | POST | idToken Firebase | طالب/مدير | طالب/مدير | منخفضة* |
| `/api/auth/firebase-register` | POST | idToken Firebase | طالب جديد | طالب | منخفضة* |
| `/api/auth/send-verify-code`, `/verify-email` | POST | لا شيء | عام (بالبريد) | طالب | متوسطة** |
| `/api/auth/forgot-password`, `/reset-password` | POST | لا شيء | عام (بالبريد+كود) | طالب | **عالية** |
| `/login` (محلي) | POST | بريد+كلمة (نصية) | عام | مدير/ولي أمر | **عالية** |
| `/api/auth/parent-login` | POST | هاتف+كلمة (نصية) | عام | ولي أمر | **عالية** |
| `/api/parent/accept-invite` | POST | رمز دعوة + كلمة | عام (مُتحقَّق بالرمز) | ولي أمر | منخفضة |
| `/api/parent/child-progress/:childId` | GET | `requireParent` | ولي الأمر (مالك الطالب فقط) | ولي أمر | منخفضة*** |
| `/student/*` (dashboard, courses, lesson, exam, notes, pdf) | GET | `requireStudent`/`requireStudentOrGuest` | طالب/ضيف | طالب/ضيف | منخفضة |
| `/student/note-pdf/:noteId` | GET | `requireStudent` + اشتراك | طالب مشترك | طالب | منخفضة |
| `/api/student/progress`, `/apply-referral`, `/submit-payment`, `/subscribe` | POST | `requireAuth` | طالب | طالب | منخفضة |
| `/api/fcm/register` | POST | `requireAuth` | طالب (رمزه فقط) | طالب | منخفضة |
| `/api/admin/*` (77 مسارًا) | POST/PUT/DELETE/GET | `requireAdmin` | مدير فقط | مدير | منخفضة† |
| `/api/toggle-dark-mode` | POST | لا شيء | عام | الجميع | منخفضة (تجميلي) |

\* لا تشفير لكلمات سر المدير/ولي الأمر (انظر ثانياً).
\** تعداد الحسابات عبر رموز الاستجابة (انظر ثانياً).
\*** تم التحقق من سلامة فحص الملكية (`app.js:1274` يرفض إن لم يكن الطالب ضمن `childrenIds`).
† جميع مسارات `/api/admin/*` مسبوقة بـ `requireAdmin` (77 من 77) — لا يوجد تجاوز مُثبَت.

### أ.3 الخدمات (Services) والوحدات (Controllers/Utilities)

| الوحدة | الملف | الدور | ملاحظة أمنية |
|---|---|---|---|
| `app` (كل المسارات) | `app.js` | المتحكّم الأحادي | 2912 سطرًا — صعوبة صيانة |
| `firebase-admin` | `firebase-admin.js` | وصول RTDB + مصادقة + FCM | احتياطي يُحمّل ملف `service-account.json` |
| `supabaseStorage` | `supabase-storage.js` | تخزين PDF خاص + روابط موقّعة | الحاوية `books` خاصة |
| `data-store` | `data-store.js` | مرآة JSON محلية + RTDB | الكتابة غير دائمة على Vercel |
| `sendMail` | `app.js:64` | بريد Gmail SMTP | الاعتماد على `SMTP_PASS` |
| `genEmailCode` | `app.js:72` | توليد رمز OTP | **يستخدم `Math.random()` غير آمن تشفيريًا** |
| `sessionUser` | `app.js:46` | إسقاط حقول خفيفة في الكوكي | تصميم سليم لتقليل حجم الكوكي |

---

## ثانياً: Authentication

| وجه الفحص | النتيجة | الدليل |
|---|---|---|
| Firebase Authentication (الطالب) | مُستخدم عبر التحقق من `idToken` خادميًا | `app.js:268` `fbAuth.verifyIdToken(idToken)` ✓ تصميم سليم |
| كلمات سر المدير/ولي الأمر | **مخزَّنة ومقارَنة نصيًا (Plaintext)** | `app.js:521` `u.password === password`؛ `app.js:1168`؛ `users.json` يحوي `"password":"admin123"` |
| تشفير كلمة المرور | **غائب تمامًا** (لا bcrypt/argon2) | لا يوجد أي استدعاء لتجزئة كلمات السر في الكود |
| Cookies / الجلسة | كوكي `lughati_session`، `httpOnly`, `sameSite:lax`, `secure` في الإنتاج | `app.js:22-29` ✓ |
| سر الجلسة (Session Secret) | **افتراضي ضعيف مُشفَّر في الكود** | `app.js:24` `process.env.SESSION_SECRET \|\| 'lughati-secret-key-2026'` |
| JWT | رمز Firebase `idToken` (JWT) يُتحقق منه خادميًا | `app.js:268,321,461` ✓ |
| Refresh Tokens | غير مُطبَّق (الجلسة في الكوكي 30 يومًا) | `app.js:25` |
| Password Reset | موجود؛ يضع كلمة المرور **نصيًا** | `app.js:447` `user.password = newPassword` |
| Email Verification | موجود (رمز 30 دقيقة) | `app.js:382-419` |
| هل يوجد ضعف؟ | **نعم** | نصية + لا تشفير + سر جلسة ضعيف + OTP ضعيف |
| هل يوجد تجاوز محتمل؟ | **نعم** | Reset بلا تشفير + بلا حدّ سرعة → استبدال كلمة مرور |
| هل يوجد Session Hijacking؟ | محتمل بدرجة متوسطة | إن استُخدم السر الافتراضي في الإنتاج → تزوير كوكي |
| هل يوجد Token Leakage؟ | نعم (محدود) | إعداد Firebase يُحقن في المتصفح (انظر تاسعًا) |

**تعداد الحسابات (Account Enumeration):** مسار `register` يُرجع `409` "البريد مسجل" (`app.js:327`) ومسارات `send-verify-code`/`forgot-password` تُرجع `404` "لا يوجد حساب" (`app.js:388,427`) — فرق الاستجابة يكشف وجود البريد من عدم.

---

## ثالثاً: Authorization (Broken Access Control)

تم فحص الصلاحيات لكل مسار. النتيجة: **التحكّم في الوصول مُنفَّذ بصرامة على مستوى الخادم** للمسارات الإدارية والأبوية.

| المسار | طالب | ولي أمر | مدرّس | غير مسجّل | BAC؟ |
|---|---|---|---|---|---|
| `/admin/*` و`/api/admin/*` | ✗ (تحويل) | ✗ | ✗ (لا يوجد دور) | ✗ | **سليم** |
| `/student/*` | ✓ | ✗ | ✗ | ✗ (إلا صفحات عامة) | **سليم** |
| `/parent/dashboard` و`/api/parent/*` | ✗ | ✓ | ✗ | ✗ | **سليم** (ملكية مُتحقَّق منها) |
| `/api/parent/child-progress/:id` | ✗ | ✓ (إن كان ابنه) | ✗ | ✗ | **سليم** (`app.js:1274`) |
| `/student/note-pdf` | ✓ (مشترك) | ✗ | ✗ | ✗ | **سليم** |
| `/api/parent/accept-invite` | ✗ | ✓ (برمز) | ✗ | ✓ (برمز دعوة) | مقبول |

**استنتاج BAC:** لا يوجد تجاوز مُثبَت في الكود. الملاحظة الوحيدة: `/api/parent/accept-invite` (`app.js:1103`) **بلا middleware**، لكنه يراجع الرمز (`i.token === token && i.status==='pending'`) وكلمة ≥6 أحرف — تصميم مقبول.

> **لا يوجد دور "مدرّس" مُنفَّذ**؛ المدرّس "محمد عفيفي" مُسجّل كـ `admin`. هذا قصور وظيفي لا ثغرة أمنية مباشرة.

---

## رابعاً: APIs

| الـ API | المدخلات | المخرجات | تحقق من المدخلات؟ | Rate Limit؟ | Auth؟ | Authz؟ | قابل للاستغلال؟ |
|---|---|---|---|---|---|---|---|
| `/api/auth/firebase-login` | `idToken` | جلسة | ✓ (verifyIdToken) | ✗ | ✓ | ✓ | منخفض |
| `/api/auth/forgot-password` | `email` | كود بالبريد | جزئي | ✗ | ✗ | ✗ | **عالي** (تعداد+OTP) |
| `/api/auth/reset-password` | `email,code,newPassword` | نجاح | ✓ | ✗ | ✗ | ✗ | **عالي** |
| `/login` | `email,password` | جلسة | ✗ (مقارنة نصية) | ✗ | ✗ | ✗ | **عالي** |
| `/api/admin/upload-pdf/sign` | `folder,fileName` | `signedUrl,token,path` | ✓ (تعقيم المسار) | ✗ | ✓ | ✓ | منخفض |
| `/api/admin/courses` (POST/PUT/DELETE) | بيانات الدورة | نجاح | جزئي | ✗ | ✓ | ✓ | متوسط (CSRF) |
| `/api/student/subscribe` | `planName,transactionId,...` | طلب اشتراك | ✓ (transactionId مطلوب) | ✗ | ✓ | ✓ | منخفض |
| `/api/parent/child-progress/:id` | `childId` | تقدّم الابن | ✓ (ملكية) | ✗ | ✓ | ✓ | منخفض |
| `/api/fcm/register` | `fcmToken` | تسجيل الرمز | ✗ | ✗ | ✓ | ✓ | منخفض |

**قابلية الاستدعاء المباشر:** كل الـ APIs متاحة عبر HTTP دون قيد CSRF، لكن الـ Admin/Parent/Student محميَة بجلسة. الخطر الحقيقي: **CSRF على مسارات الإدارة** (حذف طالب/دورة بمجرد زيارة صفحة خبيثة).

---

## خامساً: البيانات الحساسة

| المعلومة | المكان | الخطورة | سبب الخطورة | كيفية الإخفاء |
|---|---|---|---|---|
| `service-account.json` (مفتاح خادم Firebase) | جذر المشروع (احتياطي) | **عالية** | مفتاح كامل للوصول لـ RTDB | حذفه من شجرة العمل؛ الاعتماد حصريًا على `FIREBASE_SERVICE_ACCOUNT` (متغير بيئة) |
| `SESSION_SECRET` | `app.js:24` + `.env:9` | **عالية** | سر افتراضي ضعيف ومعروف | تعيين قيمة عشوائية 32+ بايت في متغير بيئة Vercel |
| كلمات سر المستخدمين | `data/users.json` (نصية) | **عالية** | قابلة للقراءة المباشرة | تشفير (bcrypt) + عدم تخزين النص |
| `SUPABASE_ANON_KEY` | `header.ejs:8` (يصل للمتصفح) | متوسطة | كشف غير مبرّر لمفتاح Supabase | إزالة السطر إن لم يُستخدم عميلًا |
| `SUPABASE_URL` | `header.ejs:8` | منخفضة | كشف عنوان المشروع | إزالة السطر |
| `FIREBASE_API_KEY` | `sw.js:5` + `header.ejs` | منخفضة* | مفتاح ويب ليس سريًا بالتصميم | لا إجراء (مقبول) لكن يُنصح بتقييد بـ App Check |
| `FIREBASE_DATABASE_URL` / `projectId` | `header.ejs` (fbConfig) | متوسطة | يكشف بنية DB ومعرّف المشروع | لا يُحقن في المتصفح إلا عند الحاجة |
| `FIREBASE_VAPID_KEY` | `.env:13` + `footer.ejs` | منخفضة | مفتاح إشعارات عام | مقبول |
| `SMTP_PASS` | `.env` (محلي فقط) | متوسطة | بريد المرسل | يبقى متغير بيئة (غير مُتتبَّع) |
| `INSTAPAY` / `VODAFONE_CASH` | `app.js:173` + `.env` | منخفضة | حسابات دفع | مقبول |

\* مفتاح Firebase للويب ليس سريًا بتصميم المنصة، لكن كشف `databaseURL` + تحميل `firebase-database-compat.js` عميلًا (انظر ثامنًا) قد يسمح بالوصول المباشر لـ RTDB **إن كانت قواعد الحماية متساهلة** (يتطلب التحقق من الكونسول).

---

## سادساً: Environment Variables

| المتغير | موجود في `.env`؟ | مُتتبَّع في git؟ | يُرسل للمتصفح؟ |
|---|---|---|---|
| `FIREBASE_API_KEY` | نعم (`.env:2`) | لا (متجاهل) | نعم (عبر `fbConfig`) |
| `FIREBASE_DATABASE_URL` | نعم | لا | نعم |
| `FIREBASE_PROJECT_ID` | نعم | لا | نعم |
| `SESSION_SECRET` | نعم (قيمة ضعيفة) | لا | لا |
| `SUPABASE_URL` | لا (يُحقن عميلًا من متغير البيئة مباشرة) | لا | **نعم** (`header.ejs:8`) |
| `SUPABASE_ANON_KEY` | لا (يُحقن عميلًا) | لا | **نعم** (`header.ejs:8`) |
| `SMTP_USER/PASS` | نعم | لا | لا |
| `FIREBASE_VAPID_KEY` | نعم | لا | نعم (مقبول) |
| `VODAFONE_CASH`/`INSTAPAY` | نعم | لا | لا |

**نتيجة:** `git check-ignore` يؤكد أن `.env` و`service-account.json` **متجاهلان ولا يُتتبَّعان** في git (نتيجة إيجابية). لا توجد متغيرات تبدأ بـ `NEXT_PUBLIC`/`VITE_`/`PUBLIC_` (تأكد بالبحث: لا شيء).

---

## سابعاً: Supabase

| وجه الفحص | النتيجة | الدليل |
|---|---|---|
| Storage | مُستخدم للتخزين فقط | `supabase-storage.js` |
| Bucket `books` | **خاص** (`public:false`) | `supabase-storage.js:53` |
| Signed URLs | نعم، عمر 30–60 ثانية | `supabase-storage.js:124-134` |
| Bucket Public؟ | **لا** | ✓ سليم |
| وصول للملفات بدون تسجيل؟ | **لا** (الروابط الموقّعة لا تصل للمتصفح؛ تُمرَّر خادميًا) | `app.js` دالة `makePdfStream` |
| تخمين الروابط؟ | صعب (UUID في المسار + عمر ≤60s) | `supabase-storage.js:91` يولّد `uuid()` |
| Bucket Policies / RLS | لا ينطبق (لا DB Postgres) | — |
| تعريض `ANON_KEY` | **نعم — غير مبرّر** | `header.ejs:8` |

**استنتاج:** حماية PDF جيّدة تصميميًا (حاوية خاصة + روابط قصيرة العمر تُمرَّر خادميًا + بوابة اشتراك على الملاحظات). النقص الوحيد: كشف `SUPABASE_ANON_KEY`/`URL` في المتصفح دون حاجة ظاهرة.

---

## ثامناً: Firebase

| وجه الفحص | النتيجة | الدليل / ملاحظة |
|---|---|---|
| Realtime Database Rules | **غير موجودة في المستودع** | القواعد في كونسول Firebase؛ **يتطلب التحقق منها** |
| Authentication Rules | مُستخدم عبر Admin (`verifyIdToken`) | `app.js:268` ✓ |
| Storage Rules | غير مُستخدم (Supabase للتخزين) | — |
| هل القواعد آمنة؟ | **يتطلب التحقق** | إن كانت `".read": true`/`".write": true` فالوصول مفتوح |
| تحميل DB SDK عميلًا | **نعم** | `header.ejs:24` يحمّل `firebase-database-compat.js` |
| احتياطي service-account | **نعم — خطر** | `firebase-admin.js:22-26` `require('./service-account.json')` إن غاب المتغير |

**نقطة حرجة يجب التحقق منها:** بما أن `header.ejs` يُحمّل عميل الويب لـ Realtime Database ويحقن `databaseURL`، فإن **أي تساهل في قواعد حماية RTDB (في الكونسول) يجعل قاعدة البيانات قابلة للقراءة/الكتابة من المتصفح مباشرة** باستخدام الإعداد المكشوف. هذا ليس ثغرة مُثبَتة من الكود (القواعد خارج المستودع)، لكنه **خطر تكويني عالٍ** يجب إغلاقه فورًا عبر قواعد `.read`/`.write` مقيّدة.

---

## تاسعاً: Frontend Exposure (ما يصل إلى المتصفح)

| العنصر | يصل للمتصفح؟ | التصنيف |
|---|---|---|
| `firebaseConfig` كاملاً (apiKey, authDomain, databaseURL, projectId, storageBucket, messagingSenderId, appId) | نعم (`header.ejs:27`) | **يحتاج تحسين** (يكشف بنية DB ومعرّف المشروع) |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | نعم (`header.ejs:8`) | **يحتاج تحسين** (كشف غير مبرّر) |
| `FIREBASE_VAPID_KEY` | نعم (`footer.ejs:69`) | مقبول |
| أسماء Internal Routes (مسارات `/api/admin/*`) | نعم (ظاهرة في كود العميل `views/admin/*`) | مقبول (محميّة بجلسة) |
| أسماء Buckets (`books`) | نعم (مرجع غير مباشر في `supabase-storage.js` المُحزَّم عميلًا؟ لا — لكن الاسم معروف من التدفق) | منخفض |
| Debug Information / Stack Traces | جزئيًا (`res.status(500).json({error:e.message})`) | **يحتاج تحسين** (تسريب رسائل الخطأ) |
| Source Maps | لا يوجد (Vanilla JS بلا بناء) | مقبول |
| Console Logs | نعم (كثير من `console.error`/`console.log`) | منخفض |

**ملخص التصنيف:** لا يوجد عنصر "خطر" مؤكد بذاته، لكن **Firebase Config + تحميل DB SDK عميلًا** يرفع الخطورة إلى "عالية محتملة" رهنًا بقواعد RTDB.

---

## عاشراً: الملفات (backup/old/test/debug)

- بحث عن أنماط `backup|old|test|debug|temp|dump|sql|secret|credential` في أسماء الملفات: **لا شيء وُجد**. ✓
- `express.static` محدود بـ `public/` و`/uploads/` فقط (`app.js:18-19`)؛ لا أسرار داخلها. ✓
- الملفات الحساسة (`service-account.json`, `.env`) **خارج** مجلد `public` وقابعة في الجذر ومتجاهلة git. ✓

---

## الحادي عشر: ملفات الإنتاج

| العنصر | الحالة | الدليل |
|---|---|---|
| Source Maps | **غير موجودة** | مشروع بلا خطوة بناء |
| Debug Mode | لا يوجد علم debug صريح | — |
| Development Mode | `secure:false` للكوكي خارج الإنتاج فقط | `app.js:28` (مقبول لـ Vercel) |
| Verbose Logs | **نعم — إفراط في `console.error`** | `firebase-admin.js` و`app.js` (قد يسجّل بيانات حساسة) |
| Error Stack للمستخدم | **نعم — يُعاد نص الخطأ** | `app.js:455,419,374` `res.status(500).json({error:e.message})` |

---

## الثاني عشر: OWASP Top 10 (2021)

| البند | معرّض؟ | الدرجة | السبب | المكان | الإصلاح |
|---|---|---|---|---|---|
| A01 Broken Access Control | جزئيًا | منخفضة | `/accept-invite` عام (مقبول)؛ BAC سليم غيره | `app.js:1103` | تحقق من ملكية كل مسار عمومي |
| A02 Cryptographic Failures | **نعم** | **عالية** | كلمات سر نصية، سر جلسة ضعيف، OTP بـ`Math.random` | `app.js:24,521,72` | تشفير + أسرار عشوائية + `crypto.randomBytes` |
| A03 Injection (XSS) | **نعم** | **متوسطة** | مخرجات `<%-` غير مُهرَّبة لمحتوى مستخدم/مدير | `course-detail.ejs:70,95,162`؛ `admin/courses.ejs:201,237,274` | استخدام `<%= %>` أو تهريب |
| A04 Insecure Design | نعم | متوسطة | لا CSRF، لا Rate Limit، لا MFA | عام | إضافة الحمايات |
| A05 Security Misconfiguration | **نعم** | **متوسطة** | لا Helmet/ترويسات أمان، أخطاء مفصّلة | `app.js` | تفعيل Helmet + إخفاء الأخطاء |
| A06 Vulnerable Components | لم يُقَم | — | لم يُجرَ `npm audit` ضمن هذه المراجعة | `package.json` | تشغيل `npm audit` دوريًا |
| A07 Auth Failures | **نعم** | **عالية** | لا تشفير كلمات سر، لا قفل/حد سرعة، OTP ضعيف | `app.js:521,72` | تشفير + قفل + OTP آمن |
| A08 Data Integrity Failures | لا يوجد دليل | منخفضة | لا Webhooks/توقيع التزامن مُستخدَمة | — | — |
| A09 Logging Failures | **نعم** | متوسطة | لا سجلات تدقيق؛ بيانات حساسة في السجلات/الأخطاء | `app.js`,`firebase-admin.js` | سجلات تدقيق + إخفاء الأسرار |
| A10 SSRF | لا يوجد دليل | منخفضة | لا استدعاء URL من مدخلات المستخدم | — | — |

---

## الثالث عشر: تحليل الكود (Code Smells / Dead Code)

| النوع | المكان | التفصيل |
|---|---|---|
| Dead Code | `package.json` | `express-session` مثبّتة **غير مُستخدَمة** (يُستخدم `cookie-session` فقط) |
| Dead Code | `package.json` | `docx` مثبّتة **غير مُستخدَمة** (لا توليد Word) |
| Dead Code | `react-components/` | مجلد `.ts`/`.tsx` **مهجور تمامًا** (مصدر الالتباس حول "React") |
| Dead Code | `plyr` (npm) | غير مُستخدَم وقت التشغيل (يُحمّل Plyr من CDN) |
| Hardcoded Value | `app.js:24` | `SESSION_SECRET` افتراضي `'lughati-secret-key-2026'` |
| Hardcoded Value | `sw.js:5-11` | Firebase `apiKey` و`appId` محفوران في الكود |
| Duplicated Code | `app.js` | منطق المقارنة النصية مكرّر (`/login`, `parent-login`, `reset`) |
| Code Smell | `app.js` (2912 سطرًا) | متحكّم أحادي ضخم — صعوبة صيانة ومراجعة أمنية |

---

## الرابع عشر: أسرار المشروع المكشوفة للمستخدم النهائي

المعلومات التالية تصل لأي زائر وتساعد المهاجم على فهم النظام:

1. **بنية قاعدة البيانات:** `firebaseConfig.databaseURL` يكشف عنوان RTDB ومساره.
2. **اسم الـ Bucket:** `books` (معروف من تدفّق التخزين).
3. **معرّف المشروع Firebase:** `mostafa-farghaly-1` (`projectId`, `storageBucket`, `authDomain`).
4. **مسارات الإدارة:** كل مسارات `/api/admin/*` و`/admin/*` ظاهرة في قوالب `views/admin/*` المحزومة عميلًا.
5. **أسماء الخدمات والدوال:** `firebase-admin`, `supabaseStorage`, `sendFCM`, `genEmailCode` — ظاهرة في الكود المحزوم.
6. **هيكل كائنات المستخدم:** الحقول (`id, uid, role, subscriptionStatus, childrenIds, referralCode`...) واضحة من منطق `sessionUser` والقوالب.
7. **مسارات داخلية:** `/api/parent/accept-invite`, `/api/fcm/register`, `/api/toggle-dark-mode` ظاهرة.

> هذه المعلومات "معلومات بنية" (Fingerprinting) وليست ثغرات بذاتها، لكنها تُسهّل هندسة الهجمات عند اقترانها بأي ثغرة من الثغرات أعلاه.

---

## الخامس عشر: التقرير النهائي

### ج.1 جدول الثغرات

| الثغرة | المكان | الخطورة | إمكانية الاستغلال | طريقة الإصلاح |
|---|---|---|---|---|
| كلمات سر مخزَّنة ومقارَنة نصيًا (Plaintext) | `app.js:521,1168,447,1138`؛ `users.json` | **عالية** | سهلة (قراءة الملف/السرقة) | تجزئة bcrypt/argon2 عند التسجيل والحفظ |
| سر جلسة افتراضي ضعيف | `app.js:24` + `.env:9` | **عالية** | متوسطة (تزوير كوكي إن استُخدم بالإنتاج) | `SESSION_SECRET` عشوائي 32+ بايت في Vercel |
| OTP مولَّد بـ `Math.random()` | `app.js:72` | **عالية** | متوسطة–عالية (تعداد + بلا حد سرعة) | `crypto.randomBytes` + حد سرعة |
| لا حدّ للسرعة / حماية Brute-force | عام (`grep`: لا شيء) | **متوسطة** | عالية | `express-rate-limit` على مسارات المصادقة |
| لا حماية CSRF | عام (`grep`: لا شيء) | **متوسطة** | متوسطة (هجوم على الإدارة) | رمز CSRF (أو SameSite صارم + تحقق Origin) |
| لا ترويسات أمان (Helmet/CSP/X-Frame) | `app.js` | **متوسطة** | متوسطة (Clickjacking/MIME) | تفعيل `helmet` |
| تعريض `SUPABASE_ANON_KEY`+`URL` عميلًا | `header.ejs:8` | متوسطة | منخفضة–متوسطة | إزالة السطر إن لم يُستخدم |
| تعريض Firebase Config + DB SDK عميلًا | `header.ejs:24,27` | متوسطة* | رهن قواعد RTDB | عدم تحميل DB SDK عميلًا + App Check |
| XSS مُخزَّن عبر `<%-` | `course-detail.ejs:70,95,162`؛ `admin/courses.ejs` | متوسطة | متوسطة | `<%= %>` أو تهريب المحتوى |
| احتياطي `service-account.json` | `firebase-admin.js:22-26` | متوسطة | منخفضة–متوسطة | حذف الملف؛ الاعتماد على متغير البيئة |
| رسائل خطأ مفصّلة للمستخدم | `app.js:455,419,374` | منخفضة | منخفضة | رسائل عامة + سجلات خادم |
| حماية PDF قائمة على تخبيب الواجهة فقط | `pdf-viewer.ejs` | منخفضة | منخفضة | (الحماية الخادمية سليمة فعلًا) |
| فيديوهات YouTube بلا حماية | `lesson.ejs` | متوسطة | متوسطة | قفل مجال يوتيوب/Vimeo |

\* رهن التحقق من قواعد RTDB في الكونسول.

### ج.2 Critical

- **لا يوجد بند مصنّف "Critical" مؤكد بذاته**، لكن الثغرات الثلاث (كلمات سر نصية، سر جلسة ضعيف، OTP ضعيف) **مجتمعة ترقى إلى مستوى حرج عمليًا** لأنها تسمح باختراق كامل للحسابات والجلسات.

### ج.3 High

1. كلمات سر مخزَّنة نصيًا (Plaintext) — `app.js:521`.
2. سر جلسة افتراضي ضعيف — `app.js:24`.
3. توليد OTP غير آمن تشفيريًا — `app.js:72`.

### ج.4 Medium

1. لا Rate Limiting.
2. لا CSRF.
3. لا Helmet / ترويسات أمان.
4. تعريض `SUPABASE_ANON_KEY`.
5. تعريض Firebase Config + DB SDK عميلًا (رهن قواعد RTDB).
6. XSS مُخزَّن (`<%-`).
7. احتياطي `service-account.json`.
8. فيديوهات بلا حماية.

### ج.5 Low

1. رسائل خطأ مفصّلة للمستخدم.
2. تخبيب واجهة عارض PDF (الحماية الخادمية سليمة).
3. إفراط في Console Logs.

### ج.6 درجة التقييم الأمني

**Security Score: 3 / 10**

> المبرّر: غياب التشفير (كلمات سر + جلسات + OTP)، وغياب الطبقات الدفاعية الأساسية (CSRF/Rate-Limit/Helmet)، مع تصميم حماية PDF وصول الإدارة سليمَين. التقييم قابل للتحسّن السريع عبر المعالجات المقترحة.

### ج.7 قائمة ما يجب ألّا يصل إلى Frontend ولكنه يصل حاليًا

1. `firebaseConfig` كاملاً (يتضمّن `databaseURL`, `projectId`) — `header.ejs:27`.
2. `SUPABASE_URL` + `SUPABASE_ANON_KEY` — `header.ejs:8`.
3. نصوص أخطاء الخادم (`e.message`) — استجابات `500` في `app.js`.
4. مخرجات `console.error` الحساسة (بريد/رموز) — `firebase-admin.js`, `app.js`.
5. (مشروط) وصول مباشر محتمل لـ RTDB إن كانت القواعد متساهلة — عبر DB SDK المحمّل في `header.ejs:24`.

---

> **ختام:** هذا التقرير مبني على الكود فقط بتاريخ 2026-07-13. البندان "قواعد RTDB" و"قواعد Supabase RLS" خارجان نطاق المستودع ويجب التحقق منهما في لوحات التحكّم الخاصة بالخدمات السحابية. لا توجد ثغرة أُدرجت دون دليل من الكود.
