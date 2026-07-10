// Migrate preparatory courses to unit-based structure
// Secondary courses remain untouched

const fs = require('fs');
const path = require('path');

var coursesPath = path.join(__dirname, '..', 'data', 'courses.json');
var courses = JSON.parse(fs.readFileSync(coursesPath, 'utf8'));

var changes = 0;

courses.forEach(function(c) {
  if (c.stage === 'إعدادية') {
    // Remove sections (not used in prep)
    delete c.sections;

    // Add units field if not present
    if (!c.units) {
      // Migrate existing lessons into a default unit
      var hasLessons = c.lessons && c.lessons.length > 0;
      c.units = [];
      if (hasLessons) {
        c.units.push({
          id: 'u1',
          name: 'الوحدة الأولى',
          order: 1
        });
        c.lessons.forEach(function(l, i) {
          l.unitId = 'u1';
          l.order = i + 1;
          delete l.sectionId;
        });
      }
      changes++;
    }

    // Set grade if empty
    if (!c.grade) {
      c.grade = 'الأول الإعدادي';
      changes++;
    }
  }
});

// Ensure prep-2 and prep-3 exist
var existingIds = courses.map(function(c) { return c.id; });
if (!existingIds.includes('prep-2')) {
  courses.push({
    id: 'prep-2',
    title: 'اللغة العربية - الثاني الإعدادي',
    subtitle: 'منهج اللغة العربية',
    description: 'منهج اللغة العربية للصف الثاني الإعدادي',
    icon: 'fa-school',
    color: '#059669',
    gradient: 'linear-gradient(135deg, #059669 0%, #10B981 50%, #34D399 100%)',
    stage: 'إعدادية',
    grade: 'الثاني الإعدادي',
    units: [],
    lessons: [],
    quiz: null
  });
  changes++;
}
if (!existingIds.includes('prep-3')) {
  courses.push({
    id: 'prep-3',
    title: 'اللغة العربية - الثالث الإعدادي',
    subtitle: 'منهج اللغة العربية',
    description: 'منهج اللغة العربية للصف الثالث الإعدادي',
    icon: 'fa-school',
    color: '#059669',
    gradient: 'linear-gradient(135deg, #059669 0%, #10B981 50%, #34D399 100%)',
    stage: 'إعدادية',
    grade: 'الثالث الإعدادي',
    units: [],
    lessons: [],
    quiz: null
  });
  changes++;
}

fs.writeFileSync(coursesPath, JSON.stringify(courses, null, 2));
console.log('Migrated ' + changes + ' preparatory changes. Total courses: ' + courses.length);
