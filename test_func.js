var __output = "";
function __append(s) { if (s !== undefined && s !== null) __output += s }
with (locals || {}) {
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
}
return __output;