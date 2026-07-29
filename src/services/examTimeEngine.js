const { readData, writeData } = require('../../prisma-bridge');

/**
 * ExamTimeEngine — محرك إدارة وقت الامتحانات
 *
 * مسؤول عن:
 * - حساب وقت النهاية بناءً على timeSettings
 * - إنشاء وإدارة محاولات الامتحان
 * - المزامنة مع الخادم
 * - التسليم التلقائي
 *
 * يمكن استخدامه في:
 * - الاختبار الشامل
 * - بنك الأسئلة
 * - أي نوع اختبار مستقبلي
 */

class ExamTimeEngine {

  /**
   * حساب وقت النهاية الحقيقي بناءً على الإعدادات ووقت البدء
   * realEndTime = min(startedAt + duration, availableTo)
   *
   * @param {Object|null} timeSettings
   * @param {string} startedAt - ISO timestamp
   * @returns {string|null} ISO timestamp or null if no timer
   */
  static calculateRealEndTime(timeSettings, startedAt) {
    if (!timeSettings) return null;
    const start = new Date(startedAt).getTime();
    const ends = [];

    if (timeSettings.enableDuration && timeSettings.durationMinutes) {
      ends.push(start + timeSettings.durationMinutes * 60 * 1000);
    }

    if (timeSettings.enableAvailability && timeSettings.availableTo) {
      const to = new Date(timeSettings.availableTo).getTime();
      if (!isNaN(to)) ends.push(to);
    }

    if (ends.length === 0) return null;
    return new Date(Math.min(...ends)).toISOString();
  }

  /**
   * التحقق من نافذة الإتاحة
   * @param {Object|null} timeSettings
   * @returns {{ allowed: boolean, reason?: string }}
   */
  static checkAvailability(timeSettings) {
    if (!timeSettings || !timeSettings.enableAvailability) {
      return { allowed: true };
    }
    const now = Date.now();

    if (timeSettings.availableFrom) {
      const from = new Date(timeSettings.availableFrom).getTime();
      if (!isNaN(from) && now < from) {
        return { allowed: false, reason: 'الامتحان لم يبدأ بعد.' };
      }
    }

    if (timeSettings.availableTo) {
      const to = new Date(timeSettings.availableTo).getTime();
      if (!isNaN(to) && now > to) {
        return { allowed: false, reason: 'انتهت فترة إتاحة الامتحان.' };
      }
    }

    return { allowed: true };
  }

  /**
   * إنشاء محاولة جديدة أو استرجاع المحاولة النشطة الحالية
   * @param {string} userId
   * @param {string} examId
   * @param {string} examType - 'course' | 'questionBank'
   * @param {string} courseId
   * @param {Object|null} timeSettings
   * @returns {Promise<Object>} attempt object
   */
  static async getOrCreateAttempt(userId, examId, examType, courseId, timeSettings) {
    const attempts = (await readData('examAttempts')) || [];

    // البحث عن محاولة نشطة حالية (دعم الأجهزة المتعددة)
    let attempt = attempts.find(a =>
      a.userId === userId && a.examId === examId && a.status === 'active'
    );
    if (attempt) return attempt;

    // التحقق من نافذة الإتاحة قبل الإنشاء
    const availability = this.checkAvailability(timeSettings);
    if (!availability.allowed) {
      const err = new Error(availability.reason);
      err.code = 'AVAILABILITY';
      throw err;
    }

    const startedAt = new Date().toISOString();
    const realEndTime = this.calculateRealEndTime(timeSettings, startedAt);

    attempt = {
      id: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      userId,
      examId,
      examType,
      courseId,
      startedAt,
      realEndTime,
      submittedAt: null,
      status: 'active',
      answers: {},
      score: null,
      total: null,
      timeSettings: timeSettings || null
    };

    attempts.push(attempt);
    await writeData('examAttempts', attempts);
    return attempt;
  }

  /**
   * حساب الوقت المتبقي بالمللي ثانية
   * @param {string|null} realEndTime - ISO timestamp
   * @returns {number|null} remaining ms or null if no timer
   */
  static calculateRemaining(realEndTime) {
    if (!realEndTime) return null;
    return Math.max(0, new Date(realEndTime).getTime() - Date.now());
  }

  /**
   * حفظ الإجابات في المحاولة
   * @param {string} attemptId
   * @param {string} userId
   * @param {Object} answers - { questionIndex: selectedOption }
   * @returns {Promise<Object>}
   */
  static async saveAnswers(attemptId, userId, answers) {
    const attempts = (await readData('examAttempts')) || [];
    const idx = attempts.findIndex(a => a.id === attemptId && a.userId === userId);
    if (idx === -1) throw new Error('المحاولة غير موجودة');
    if (attempts[idx].status !== 'active') throw new Error('تم تسليم الامتحان مسبقاً');

    attempts[idx].answers = Object.assign({}, answers);
    await writeData('examAttempts', attempts);
    return attempts[idx];
  }

  /**
   * تسليم المحاولة (يدوي أو تلقائي)
   * @param {string} attemptId
   * @param {string} userId
   * @param {Object} answers - final answers snapshot
   * @param {boolean} force - force submit even if already submitted
   * @returns {Promise<Object>} submitted attempt
   */
  static async submitAttempt(attemptId, userId, answers, force) {
    const attempts = (await readData('examAttempts')) || [];
    const idx = attempts.findIndex(a => a.id === attemptId && a.userId === userId);
    if (idx === -1) throw new Error('المحاولة غير موجودة');

    if (attempts[idx].status !== 'active') {
      if (!force) throw new Error('تم تسليم هذا الامتحان مسبقاً');
    }

    const remaining = this.calculateRemaining(attempts[idx].realEndTime);
    if (remaining !== null && remaining <= 0) {
      attempts[idx].status = 'auto-submitted';
    } else {
      attempts[idx].status = 'submitted';
    }

    attempts[idx].submittedAt = new Date().toISOString();
    if (answers) attempts[idx].answers = Object.assign({}, answers);

    await writeData('examAttempts', attempts);
    return attempts[idx];
  }

  /**
   * حساب النتيجة بناءً على الإجابات
   * @param {Object} attempt
   * @param {Array} questions - [{ correct: number }]
   * @returns {{ score: number, total: number, percentage: number }}
   */
  static gradeAttempt(attempt, questions) {
    const answers = attempt.answers || {};
    let score = 0;
    const total = questions.length;

    questions.forEach((q, idx) => {
      if (answers[idx] !== undefined && parseInt(answers[idx]) === q.correct) {
        score++;
      }
    });

    return { score, total, percentage: total > 0 ? Math.round((score / total) * 100) : 0 };
  }

  /**
   * تحديث نتيجة المحاولة وحفظها
   * @param {string} attemptId
   * @param {string} userId
   * @param {number} score
   * @param {number} total
   * @returns {Promise<Object>}
   */
  static async saveGrade(attemptId, userId, score, total) {
    const attempts = (await readData('examAttempts')) || [];
    const idx = attempts.findIndex(a => a.id === attemptId && a.userId === userId);
    if (idx === -1) throw new Error('المحاولة غير موجودة');

    attempts[idx].score = score;
    attempts[idx].total = total;
    await writeData('examAttempts', attempts);
    return attempts[idx];
  }
}

module.exports = ExamTimeEngine;
