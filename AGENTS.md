# AGENTS.md

## FCM Push Notifications — خلاصة

### المشكلة
إشعارات FCM كانت توصل كـ toast جوه الصفحة بس، مش كـ system notification.

### السبب
استخدام **data-only** payload. على Desktop:
- `data`-only: محتاج `onBackgroundMessage` في SW (مش مضبوط)
- `notification` + `data`: Firebase SDK بيعمل **auto-display** في الخلفية من غير أي handler

### الحل
تغيير كل رسائل FCM من:
```js
{ token, data: { title, body, url } }
```
إلى:
```js
{ token, notification: { title, body }, data: { url } }
```

### التغييرات التي تمت

| الملف | التغيير |
|-------|---------|
| `firebase-admin.js` | sendFCM, sendFCMToRole: payload notification+data |
| `app.js` | كل 6 نقاط إرسال: chat push, subscribe push, send-notification, scheduled, live session, test |
| `public/sw.js` | icon → `/icon-192.png`, try/catch حول showNotification |
| `fcm-log.js` | جديد — تخزين آخر 100 عملية إرسال في الذاكرة |
| `views/admin/fcm-debug.ejs` | جديد — صفحة تشخيص شاملة |
| `app.js` | routes جديدة: `/api/fcm/debug`, `/api/fcm/test`, `/admin/fcm-debug` |

### أمان — إيه اللي ظاهر من F12 DevTools

### الحاجات اللي كانت باينة ومش مشكلة
| الحاجة | السبب |
|--------|-------|
| Firebase config (apiKey, projectId...) في `header.ejs` | أصلاً معمول إنه يبقى public client-side، والحماية في Firebase Security Rules مش في المفتاح نفسه |
| VAPID key في `footer.ejs` | مطلوب عشان push subscriptions — تصميم Web Push Protocol يخلقه public |
| Phone/Email/Social links | دي بيانات عامة للتواصل، مش secrets |

### الحاجات اللي اتصلحت
| الحاجة | التغيير |
|--------|---------|
| Firebase config hardcoded في `public/sw.js` | **اتشالت بالكامل** — السطرين بتوع import و الـ 8 أسطر بتوع `initializeApp`. Firebase SDK مش مستخدم أصلاً في الـ SW (الـ `push` handler بتاعنا هو اللي بيعمل `showNotification`). نفس المعلومة بتتاخد من `header.ejs` من الـ env vars |
| `gcm_sender_id` mismatch | اتغيرت من `103953800507` لـ `67570982000` في `manifest.json` عشان تطابق `messagingSenderId` |

### الحاجات اللي لسه ظاهرة وضرورية
| الحاجة | ليه ضروري |
|--------|-----------|
| Zoom meeting password في `zoom-embed.ejs` (سطر 46) | Zoom SDK محتاجه عشان الـ authentication. الصفحة محمية بـ `requireStudentOrGuest` (مش أي حد يوصلها). الحل الوحيد هو إن الأستاذ يغير باسورد الاجتماع لو اشتبه في تسريب |
| Parent invite token في `parent/invite.ejs` (سطر 61) | الـ token موجود في رابط الدعوة نفسه، و one-time use. مش مشكلة أمان جديدة |

### Keep in mind
- أي **service account JSON** أو **session secret** أو **cron secret** أو **Gmail password** كلها في Vercel env vars بس — مش في الكود ولا في الـ client-side
- لو عايز تزود أمان Zoom: غيّر meeting password لكل حصة يدويًا من Zoom (مش من الموقع) عشان الكود ياخد الباسورد الجديد

## Security Hardening — التحديث الشامل

### الإصلاحات التي تمت في `app.js` (19 Fix)

| # | الثغرة | الخطورة | الإصلاح |
|---|--------|---------|---------|
| 1 | Cron bypass — `x-vercel-cron` header قابل للتزوير | 🔴 حرج | أتشاف: بقى يتطلب `CRON_SECRET` بس |
| 2 | Zoom OAuth CSRF — الـ state مش بيتحقق | 🔴 حرج | `crypto.randomBytes(16)` + session verification |
| 3 | Zoom reflected XSS — `req.query.error` في `res.send()` | 🔴 حرج | أتشاف الخطأ (من غير user input) |
| 4 | `GET /api/debug/test-email` من غير auth | 🔴 حرج | أتضاف `requireAdmin` |
| 5 | `upload-note-file` بيقبل أي امتداد (`.html`, `.js`...) | 🔴 حرج | Whitelist للمتددات المسموحة |
| 6 | Firebase path injection — chat + attendance | 🔴 حرج | Regex validation على params |
| 7 | `PUT /api/student/profile` يرجع password hash | 🔴 حرج | Safe fields whitelist في الاستجابة |
| 8 | `Object.assign` بلا whitelist (users, courses, settings, codes) | 🔴 حرج | Allowed fields arrays |
| 9 | Account enumeration — 6 endpoints يورّجوا وجود الإيميل | 🔴 حرج | كل رسايل الخطأ بقت generic |
| 10 | CSRF bypass — مقارنة `origin.host === host` | 🟠 عالي | `allowedHosts` array + `APP_URL` env var |
| 11 | Session fixation — مفيش `regenerate()` على login | 🟠 عالي | `req.session.regenerate()` في Firebase + form login |
| 12 | `Math.random()` للتوكينز — ضعيف | 🟠 عالي | `crypto.randomBytes()` في referral, invite, charge codes |
| 13 | `scrypt N=16384` — أقل من الموصى به | 🟠 عالي | تغير لـ 131072 (OWASP recommendation) |
| 14 | Rate limiter in-memory — ضعيف على Vercel | 🟠 عالي | أتحسن: `x-forwarded-for`, أضيفت endpoints جديدة |
| 15 | `multer` بيقبل أي MIME type | 🟠 عالي | `fileFilter` يسمح بالصور والـ PDF والـ doc بس |
| 16 | `validateReceiptImage` بيفحص الـ header string بس | 🟠 عالي | Magic bytes check (JPEG, PNG, WebP) |
| 17 | `/api/student/redeem-code` مفيش rate limit | 🟠 عالي | أتضاف لـ AUTH_LIMIT |
| 18 | `/api/student/apply-referral` مفيش rate limit | 🟠 عالي | أتضاف لـ AUTH_LIMIT |
| 19 | إرجاع `e.message` في Zoom callback | 🟠 عالي | Generic error message |

### الإصلاحات في الـ EJS Templates (9 Fix)

| # | الثغرة | الملف | الإصلاح |
|---|--------|-------|---------|
| 20 | Stored XSS — avatar في `innerHTML` | `admin/students.ejs` | `escHtml(s.avatar)` |
| 21 | Stored XSS — رسالة شات في `innerHTML` | `admin/chat-list.ejs` | `escHtml(c.lastText)` |
| 22 | `escHtml()` بتفوت الـ single quote | `admin/students.ejs` | أتضاف `.replace(/'/g,'&#039;')` |
| 23 | Lesson titles `<%-` من غير escape | `student/course-detail.ejs` | Inline escaping |
| 24 | `v2.error` في `innerHTML` | `admin/analytics.ejs` | `textContent` + `escHtml()` على كل dynamic data |
| 25 | `d.error` في `innerHTML` | `admin/sub-requests.ejs` | `textContent` + `escHtml()` |
| 26 | API errors في `innerHTML` | `admin/fcm-debug.ejs` | `textContent` + `escHtml()` |
| 27 | API errors في `innerHTML` | `admin/send-notification.ejs` | `textContent` + `escHtml()` |
| 28 | Exception في `innerHTML` | `admin/student-progress.ejs`, `student/profile.ejs` | `textContent` |

## ملاحظات مهمة
- على Desktop: الـ push notification **مش بتشتغل** لو المتصفح مقفول خالص — دا تصميم Chrome
- بتشتغل لو المتصفح minimized أو في خلفية
- أيقونة `/icon.png` حجمها 262KB — اتغيرت لـ `/icon-192.png` (42KB)

## Cache — مشكلة تعديلات الأدمن مش بتتطبق على الطالب

| المشكلة | الإصلاح |
|---------|---------|
| الـ `_cache` في `firebase-admin.js` per-instance (كل Vercel instance ليها cache بتاعها)، التعديل بينمسح على الـ instance اللي كتبت من بس | `settings` اتمسح من `CACHEABLE` (بقى يتقرأ من Firebase مباشرة، حجمه صغير). الـ TTL نزل من 60s لـ 20s للباقي |

## Quiz → Next Lesson + Remove Progress Bar

### التغييرات

| الملف | التغيير |
|-------|---------|
| `app.js` (سطر 1244) | تمرير `nextLesson` لصفحة الاختبار عشان يظهر زر الانتقال للدرس التالي |
| `views/student/lesson-quiz.ejs` | بعد النجاح في الاختبار: استدعاء `POST /api/student/progress` لإكمال الدرس + زر "الانتقال للدرس التالي" |
| `views/student/lesson.ejs` | إزالة شريط تقدم الفيديو (progressBar + progressPct) |
| `public/js/lesson.js` | تبسيط `updateUI` — إزالة تحديث شريط التقدم، بقى بس watchStatus |

### منطق لوحة المدرس — شرح

- **زمن المشاهدة**: بيتم إرساله كل 5 ثواني عبر heartbeat (`POST /api/analytics/video/heartbeat`) ويتراكم في `user.progress[courseId].lessons[lessonId].watchTime`
- **المدرس بيشوفه في**: `/admin/student-progress?sid=xxx` تحت عنوان "وقت المشاهدة لكل درس"
- **التحليلات**: `analytics-engine.js` بتقرأ من `users[]` مباشرة (بتعمل `readData('users', true)` عشان تتخطى الـ cache)

### أمان للمستقبل
- لو عايز تقفل وصول الطالب للدرس من غير ما يفتحه أصلاً: الـ `computeLessonStatuses` بتمنع الدخول لو `isUnlocked === false`
- أي تعديل في ترتيب الدروس (`order`) لازم يكون كلesson ليها `order` unique عشان السلسلة تشتغل صح

### أخطاء متبقية
- `header.ejs` السطر 45: كود PWA install banner بيحاول `document.body.appendChild` قبل `<body>` — مش مربوط بـ FCM

### أوامر التشغيل
```bash
npm run dev
npx vercel deploy --prod
```
