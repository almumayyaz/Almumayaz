(function() {
  var ERROR_MAP = {
    'auth/invalid-credential': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    'auth/user-not-found': 'لا يوجد حساب بهذا البريد الإلكتروني.',
    'auth/wrong-password': 'كلمة المرور غير صحيحة.',
    'auth/invalid-email': 'البريد الإلكتروني غير صحيح.',
    'auth/email-already-in-use': 'هذا البريد الإلكتروني مستخدم بالفعل.',
    'auth/weak-password': 'كلمة المرور ضعيفة، استخدم كلمة مرور أقوى (6 أحرف على الأقل).',
    'auth/network-request-failed': 'تعذر الاتصال بالإنترنت. تحقق من اتصالك ثم حاول مرة أخرى.',
    'auth/too-many-requests': 'تم إجراء محاولات كثيرة. يرجى الانتظار قليلاً ثم إعادة المحاولة.',
    'auth/user-disabled': 'تم إيقاف هذا الحساب. يرجى التواصل مع إدارة المنصة.',
    'auth/requires-recent-login': 'لأسباب أمنية، يرجى تسجيل الدخول مرة أخرى.',
    'auth/expired-action-code': 'انتهت صلاحية رمز أو رابط التحقق.',
    'auth/invalid-action-code': 'رمز التحقق غير صالح.',
    'auth/account-exists-with-different-credential': 'هذا البريد الإلكتروني مرتبط بطريقة تسجيل دخول أخرى.',
    'auth/popup-closed-by-user': 'تم إلغاء عملية تسجيل الدخول.',
    'auth/cancelled-popup-request': 'تم إلغاء العملية.',
    'auth/operation-not-allowed': 'هذه الطريقة غير متاحة حالياً.',
    'auth/invalid-verification-code': 'رمز التحقق غير صالح.',
    'auth/invalid-verification-id': 'معرّف التحقق غير صالح.',
    'auth/missing-phone-number': 'يرجى إدخال رقم الهاتف.',
    'auth/invalid-phone-number': 'رقم الهاتف غير صالح.',
    'auth/quota-exceeded': 'تم تجاوز الحد المسموح للتحقق. حاول لاحقاً.',
    'auth/session-expired': 'انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى.',
    'auth/unauthorized-continue-uri': 'رابط التحقق غير مصرح به.',
    'auth/user-mismatch': 'بيانات المستخدم غير متطابقة.',
    'auth/credential-already-in-use': 'بيانات الدخول مستخدمة بالفعل لحساب آخر.',
    'auth/provider-already-linked': 'طريقة الدخول هذه مرتبطة بالفعل بحسابك.',
    'auth/no-such-provider': 'طريقة الدخول غير موجودة.',
    'auth/invalid-provider-id': 'معرّف مزود الدخول غير صالح.',
    'auth/invalid-photo-url': 'رابط الصورة الشخصية غير صالح.',
    'auth/invalid-password': 'كلمة المرور غير صالحة.',
    'auth/invalid-display-name': 'الاسم غير صالح.',
    'auth/missing-email': 'يرجى إدخال البريد الإلكتروني.',
    'auth/missing-password': 'يرجى إدخال كلمة المرور.',
    'auth/invalid-api-key': 'خطأ في إعدادات المصادقة. تواصل مع الدعم الفني.',
    'auth/app-not-authorized': 'التطبيق غير مصرح به. تواصل مع الدعم الفني.',
    'auth/argument-error': 'خطأ في البيانات المدخلة. حاول مرة أخرى.',
    'auth/internal-error': 'حدث خطأ داخلي في المصادقة. حاول مرة أخرى.',
    'auth/web-context-cancelled': 'تم إلغاء العملية.',
    'auth/web-storage-unsupported': 'المتصفح لا يدعم التخزين المحلي المطلوب لتسجيل الدخول.'
  };
  var UNKNOWN_ERROR = 'حدث خطأ غير متوقع، يرجى المحاولة مرة أخرى. إذا استمرت المشكلة تواصل مع الدعم الفني.';
  window.getFirebaseErrorMessage = function(error) {
    if (!error) return UNKNOWN_ERROR;
    var code = error.code || '';
    if (code && ERROR_MAP[code]) {
      console.error('[Firebase Error]', code, error.message || error);
      return ERROR_MAP[code];
    }
    var msg = error.message || '';
    if (msg && (msg.indexOf('Firebase') !== -1 || msg.indexOf('auth/') !== -1)) {
      console.error('[Firebase Error Raw]', msg);
      return UNKNOWN_ERROR;
    }
    console.error('[Error]', msg || error);
    return UNKNOWN_ERROR;
  };
})();
