const fs = require('fs');
const path = require('path');

const coursesPath = path.join(__dirname, '..', 'data', 'courses.json');
const courses = JSON.parse(fs.readFileSync(coursesPath, 'utf8'));

var migrated = 0;
courses.forEach(function(c) {
  if (!c.grade) {
    if (c.stage === 'ثانوية') {
      c.grade = 'الثالث الثانوي';
      migrated++;
    } else if (c.stage === 'إعدادية') {
      c.grade = '';
      migrated++;
    }
  }
});

fs.writeFileSync(coursesPath, JSON.stringify(courses, null, 2));
console.log('Migrated ' + migrated + ' courses. Total: ' + courses.length);
