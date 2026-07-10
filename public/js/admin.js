document.addEventListener('DOMContentLoaded', function() {
  const deleteButtons = document.querySelectorAll('.admin-actions .delete');
  deleteButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      if (!confirm('هل أنت متأكد من حذف هذا العنصر؟')) {
        e.preventDefault();
      }
    });
  });

  const adminRows = document.querySelectorAll('.admin-table tbody tr');
  adminRows.forEach(row => {
    row.addEventListener('click', function(e) {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'I') return;
    });
  });
});
