const { getPrisma } = require('../database');

const ACTIONS = {
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGOUT: 'USER_LOGOUT',
  USER_REGISTER: 'USER_REGISTER',
  USER_UPDATE: 'USER_UPDATE',
  USER_DELETE: 'USER_DELETE',
  SUBSCRIPTION_CREATE: 'SUBSCRIPTION_CREATE',
  SUBSCRIPTION_APPROVE: 'SUBSCRIPTION_APPROVE',
  SUBSCRIPTION_REJECT: 'SUBSCRIPTION_REJECT',
  PAYMENT_CREATE: 'PAYMENT_CREATE',
  PAYMENT_APPROVE: 'PAYMENT_APPROVE',
  PAYMENT_REJECT: 'PAYMENT_REJECT',
  COURSE_CREATE: 'COURSE_CREATE',
  COURSE_UPDATE: 'COURSE_UPDATE',
  COURSE_DELETE: 'COURSE_DELETE',
  LESSON_CREATE: 'LESSON_CREATE',
  LESSON_UPDATE: 'LESSON_UPDATE',
  LESSON_DELETE: 'LESSON_DELETE',
  EXAM_SUBMIT: 'EXAM_SUBMIT',
  EXAM_GRADE: 'EXAM_GRADE',
  CONTENT_PUBLISH: 'CONTENT_PUBLISH',
  CONTENT_UNPUBLISH: 'CONTENT_UNPUBLISH',
  CHARGE_CODE_CREATE: 'CHARGE_CODE_CREATE',
  CHAT_SESSION_CLOSE: 'CHAT_SESSION_CLOSE',
  TICKET_UPDATE: 'TICKET_UPDATE',
  SETTINGS_UPDATE: 'SETTINGS_UPDATE',
  ZOOM_CREDENTIAL_UPDATE: 'ZOOM_CREDENTIAL_UPDATE',
};

async function recordAuditLog({ actorId, action, entity, entityId, metadata, ip, userAgent }) {
  try {
    const prisma = getPrisma();
    await prisma.auditLog.create({
      data: {
        actorId: actorId || null,
        action,
        entity,
        entityId: entityId || null,
        metadata: metadata || null,
        ip: ip || null,
        userAgent: userAgent || null,
      }
    });
  } catch (e) {
    console.error('[auditLog] failed:', e.message);
  }
}

function auditMiddleware(action, entity, getEntityId) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400) {
        const entityId = typeof getEntityId === 'function' ? getEntityId(req, body) : getEntityId;
        recordAuditLog({
          actorId: req.user?.id || req.session?.user?.id,
          action,
          entity,
          entityId,
          ip: req.headers['x-forwarded-for'] || req.ip,
          userAgent: req.headers['user-agent'],
        }).catch(() => {});
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = { ACTIONS, recordAuditLog, auditMiddleware };
