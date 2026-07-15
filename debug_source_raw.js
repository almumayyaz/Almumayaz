    ; __append( include('../partials/header', { title: title, navPageTitle: lesson.title, bodyClass: 'student-body' }) )
    ; __append("\r\n")
    ; __append( include('../partials/student-sidebar') )
    ; __append("\r\n<main class=\"main-content\">\r\n  <div class=\"page-header\">\r\n    <div>\r\n      <a href=\"/student/course/")
    ; __append(escapeFn( course.id ))
    ; __append("\" style=\"color:var(--accent);font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;margin-bottom:8px;transition:all 0.3s;\">\r\n        <i class=\"fas fa-chevron-right\"></i> العودة إلى ")
    ; __append(escapeFn( course.title ))
    ; __append("\r\n      </a>\r\n      <h1>")
    ; __append(escapeFn( lesson.title ))
    ; __append("</h1>\r\n      <p style=\"display:flex;align-items:center;gap:12px;flex-wrap:wrap;\">\r\n        <span><i class=\"fas fa-book\" style=\"color:var(--accent);\"></i> ")
    ; __append(escapeFn( course.title ))
    ; __append("</span>\r\n        <span><i class=\"fas fa-clock\" style=\"color:var(--accent);\"></i> ")
    ; __append(escapeFn( lesson.duration ))
    ; __append("</span>\r\n        ")
    ;  if (lesson.isFree) { 
    ; __append("<span class=\"bab-free-badge\">درس مجاني</span>")
    ;  } 
    ; __append("\r\n      </p>\r\n    </div>\r\n  </div>\r\n\r\n  <!-- Plyr Video Player -->\r\n  ")
    ;  if (lesson.videos && lesson.videos.length > 0) { 
    ; __append("\r\n    ")
    ;  if (lesson.videos.length === 1) { 
    ; __append("\r\n    <div class=\"plyr-container\" data-plyr-provider=\"youtube\" data-plyr-embed-id=\"")
    ; __append(escapeFn( (ytId(lesson.videos[0].url) || '') ))
    ; __append("\" oncontextmenu=\"return false;\"></div>\r\n    ")
    ;  } else { 
    ; __append("\r\n    <div style=\"display:flex;flex-direction:column;gap:20px;margin-bottom:28px;\">\r\n      ")
    ;  lesson.videos.forEach(function(video, vi) { 
    ; __append("\r\n      <div>\r\n        <div style=\"display:flex;align-items:center;gap:8px;margin-bottom:8px;\">\r\n          <span style=\"background:var(--accent);color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;\">")
    ; __append(escapeFn( vi + 1 ))
    ; __append("</span>\r\n          <span style=\"font-weight:600;font-size:14px;\">")
    ; __append(escapeFn( video.title || ('الجزء ' + (vi + 1)) ))
    ; __append("</span>\r\n        </div>\r\n        <div class=\"plyr-container\" data-plyr-provider=\"youtube\" data-plyr-embed-id=\"")
    ; __append(escapeFn( (ytId(video.url) || '') ))
    ; __append("\" oncontextmenu=\"return false;\"></div>\r\n      </div>\r\n      ")
    ;  }) 
    ; __append("\r\n    </div>\r\n    ")
    ;  } 
    ; __append("\r\n  ")
    ;  } else if (lesson.videoUrl) { 
    ; __append("\r\n    <div class=\"plyr-container\" data-plyr-provider=\"youtube\" data-plyr-embed-id=\"")
    ; __append(escapeFn( (ytId(lesson.videoUrl) || '') ))
    ; __append("\" oncontextmenu=\"return false;\"></div>\r\n  ")
    ;  } else { 
    ; __append("\r\n    <div style=\"text-align:center;padding:40px;background:var(--glass-bg);border-radius:var(--radius-xl);margin-bottom:28px;border:1px solid var(--border);\">\r\n      <i class=\"fas fa-video-slash\" style=\"font-size:36px;color:var(--border);display:block;margin-bottom:12px;\"></i>\r\n      <p style=\"color:var(--text-muted);\">لا يوجد فيديو لهذا الدرس بعد</p>\r\n  </div>\n\r\n  <!-- Lesson Info Bar (below player) -->\r\n  ")
    ;  if (lesson.videos || lesson.videoUrl) { 
    ; __append("\r\n  <div id=\"lessonInfoBar\" style=\"display:none;align-items:center;gap:12px;padding:12px 16px;background:var(--card);border-radius:var(--radius-lg);border:1px solid var(--border);margin-bottom:20px;flex-wrap:wrap;\">\r\n    ")
    ;  if (lesson.pdfFiles && lesson.pdfFiles.length > 0) { 
    ; __append("\r\n    <a href=\"#pdfSection\" style=\"display:flex;align-items:center;gap:6px;font-size:13px;color:var(--danger);text-decoration:none;font-weight:600;padding:6px 10px;background:rgba(239,68,68,0.05);border-radius:8px;\">\r\n      <i class=\"fas fa-file-pdf\"></i> ")
    ; __append(escapeFn( lesson.pdfFiles.length ))
    ; __append(" ملف")
    ; __append(escapeFn( lesson.pdfFiles.length > 1 ? 'ات' : '' ))
    ; __append(" PDF\r\n    </a>\r\n    ")
    ;  } 
    ; __append("\r\n    <div style=\"margin-right:auto;display:flex;align-items:center;gap:8px;\">\r\n      <span id=\"watchStatus\" style=\"font-size:12px;color:var(--text-muted);\">\r\n        <i class=\"fas fa-circle\" style=\"color:var(--text-muted);font-size:8px;\"></i> لم تشاهد بعد\r\n      </span>\r\n    </div>\r\n  </div>\r\n  ")
    ;  } 
    ; __append("\r\n\r\n  <div class=\"lesson-content\">\r\n    <h1>")
    ; __append(escapeFn( lesson.title ))
    ; __append("</h1>\r\n    <p>")
    ; __append(escapeFn( lesson.description ))
    ; __append("</p>\r\n\r\n    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px;padding:16px;background:var(--bg);border-radius:8px;\">\r\n      <div><span style=\"font-weight:600;color:var(--primary);\">المادة:</span> <span style=\"color:var(--text-light);\">")
    ; __append(escapeFn( course.title ))
    ; __append("</span></div>\r\n      <div><span style=\"font-weight:600;color:var(--primary);\">عدد الدروس:</span> <span style=\"color:var(--text-light);\">")
    ; __append(escapeFn( (course.lessons||[]).length ))
    ; __append("</span></div>\r\n      ")
    ;  if (lesson.videos) { 
    ; __append("<div><span style=\"font-weight:600;color:var(--primary);\">عدد المقاطع:</span> <span style=\"color:var(--text-light);\">")
    ; __append(escapeFn( lesson.videos.length ))
    ; __append("</span></div>")
    ;  } 
    ; __append("\r\n    </div>\r\n\r\n    <!-- PDF Files -->\r\n    ")
    ;  if (lesson.pdfFiles && lesson.pdfFiles.length > 0) { 
    ; __append("\r\n    <div id=\"pdfSection\" style=\"margin-bottom:24px;\">\r\n      <h3 style=\"font-size:16px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px;\">\r\n        <i class=\"fas fa-file-pdf\" style=\"color:var(--accent);\"></i> المذكرات\r\n      </h3>\r\n      <div style=\"display:flex;flex-direction:column;gap:8px;\">\r\n        ")
    ;  lesson.pdfFiles.forEach(function(pdf, pi) { 
    ; __append("\r\n        <div style=\"display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg);border-radius:var(--radius-sm);border:1px solid var(--border);\">\r\n          <i class=\"fas fa-file-pdf\" style=\"color:var(--danger);font-size:20px;\"></i>\r\n          <span style=\"flex:1;font-size:14px;font-weight:500;\">")
    ; __append(escapeFn( pdf.title || ('ملف ' + (pi + 1)) ))
    ; __append("</span>\r\n          <a href=\"/student/view-pdf/")
    ; __append(escapeFn( course.id ))
    ; __append("/")
    ; __append(escapeFn( lesson.id ))
    ; __append("/")
    ; __append(escapeFn( pi ))
    ; __append("\" class=\"btn btn-sm\" style=\"background:var(--primary);color:#fff;\">\r\n            <i class=\"fas fa-eye\"></i> عرض\r\n          </a>\r\n        </div>\r\n        ")
    ;  }) 
    ; __append("\r\n      </div>\r\n    </div>\r\n    ")
    ;  } 
    ; __append("\r\n\r\n    <!-- Progress Tracking -->\r\n    <div style=\"margin-bottom:20px;\">\r\n      <div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;\">\r\n        <span style=\"font-size:13px;font-weight:600;\">التقدم</span>\r\n        <span style=\"font-size:13px;color:var(--text-light);\" id=\"progressPct\">0%</span>\r\n      </div>\r\n      <div style=\"width:100%;height:8px;background:var(--bg);border-radius:4px;overflow:hidden;\">\r\n        <div id=\"progressBar\" style=\"width:0%;height:100%;background:var(--gold-gradient);border-radius:4px;transition:width 0.5s ease;\"></div>\r\n      </div>\r\n    </div>\r\n  </div>\r\n\r\n  <div style=\"margin-top:20px;display:flex;flex-direction:column;gap:12px;\">\r\n    ")
    ;  if (lesson.quiz && lesson.quiz.enabled && !isGuest) { 
    ; __append("\r\n    <div class=\"welcome-banner\" style=\"padding:12px 16px;\">\r\n      <div style=\"display:flex;align-items:center;gap:8px;margin-bottom:8px;\">\r\n        <i class=\"fas fa-question-circle\" style=\"color:var(--accent);font-size:14px;\"></i>\r\n        <span style=\"font-size:13px;font-weight:700;color:var(--accent);\">اختبار الدرس</span>\r\n      </div>\r\n      <div style=\"display:flex;align-items:center;justify-content:space-between;gap:12px;\">\r\n        <p style=\"font-size:13px;color:var(--text-light);margin:0;\">")
    ; __append(escapeFn( (lesson.quiz.questions||[]).length ))
    ; __append(" أسئلة</p>\r\n        <a href=\"/student/lesson-quiz/")
    ; __append(escapeFn( course.id ))
    ; __append("/")
    ; __append(escapeFn( lesson.id ))
    ; __append("\" class=\"btn btn-primary btn-sm\" style=\"cursor:pointer;z-index:999;position:relative;\">\r\n          <i class=\"fas fa-pen\"></i> ابدأ اختبار الدرس\r\n        </a>\r\n      </div>\r\n    </div>\r\n    ")
    ;  } 
    ; __append("\r\n    ")
    ;  if (course.quiz && !isGuest) { 
    ; __append("\r\n    <a href=\"/student/exam/")
    ; __append(escapeFn( course.id ))
    ; __append("\" class=\"welcome-banner\" style=\"padding:12px 16px;display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;\">\r\n      <div style=\"display:flex;align-items:center;gap:8px;flex:1;\">\r\n        <i class=\"fas fa-question-circle\" style=\"color:var(--accent);font-size:14px;\"></i>\r\n        <span style=\"font-size:13px;font-weight:700;color:var(--accent);\">الاختبار الشامل</span>\r\n        <span style=\"font-size:12px;color:var(--text-light);\">(")
    ; __append(escapeFn( (course.quiz.questions||[]).length ))
    ; __append(" أسئلة)</span>\r\n      </div>\r\n      <i class=\"fas fa-chevron-left\" style=\"color:var(--text-light);font-size:12px;\"></i>\r\n    </a>\r\n    ")
    ;  } 
    ; __append("\r\n  </div>\r\n\r\n</main>\r\n\r\n<script src=\"/js/plyr.js\"></script>\r\n<script>\r\nvar courseId = '")
    ; __append(escapeFn( course.id ))
    ; __append("';\r\nvar lessonId = '")
    ; __append(escapeFn( lesson.id ))
    ; __append("';\r\nvar isGuest = ")
    ; __append(escapeFn( isGuest ? 'true' : 'false' ))
    ; __append(";\r\n</script>\r\n<script src=\"/js/lesson.js\"></script>\r\n\r\n</body>\r\n</html>")
