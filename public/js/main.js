document.addEventListener('DOMContentLoaded', function () {

  /* ===== ANIMATIONS ===== */
  const animateElements = document.querySelectorAll('.animate-in');
  if (animateElements.length > 0) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add('visible');
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    animateElements.forEach(el => observer.observe(el));
  }

  /* ===== SMOOTH SCROLL ===== */
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  /* ===== FORM VALIDATION ===== */
  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', function (e) {
      const required = this.querySelectorAll('[required]');
      let valid = true;
      required.forEach(input => {
        if (!input.value.trim()) { input.style.borderColor = '#DC2626'; valid = false; }
        else input.style.borderColor = '';
      });
      if (!valid) { e.preventDefault(); this.querySelector('[style*="border-color: rgb(220, 38, 38)"]')?.focus(); }
    });
    form.querySelectorAll('input, select, textarea').forEach(input => {
      input.addEventListener('input', function () { if (this.value.trim()) this.style.borderColor = ''; });
      input.addEventListener('focus', function () { this.parentElement.querySelector('label')?.style.setProperty('color', 'var(--accent)'); });
      input.addEventListener('blur', function () { this.parentElement.querySelector('label')?.style.setProperty('color', ''); });
    });
  });

  /* ===== QUIZ OPTIONS ===== */
  document.querySelectorAll('.quiz-option').forEach(option => {
    option.addEventListener('click', function () {
      const container = this.closest('.quiz-options');
      const radio = this.querySelector('input[type="radio"]');
      if (radio) {
        radio.checked = true;
        container.querySelectorAll('.quiz-option').forEach(o => {
          o.style.borderColor = ''; o.style.background = '';
        });
        this.style.borderColor = 'var(--accent)';
        this.style.background = 'rgba(212, 160, 23, 0.06)';
      }
    });
  });

  /* ===== QUIZ SUBMIT ===== */
  document.querySelectorAll('.btn-submit-quiz').forEach(btn => {
    btn.addEventListener('click', function () {
      const quiz = this.closest('.quiz-section, .qb-exam-mode');
      if (!quiz) return;
      const questions = quiz.querySelectorAll('.quiz-question');
      let score = 0, total = questions.length, allAnswered = true;
      let results = '';

      questions.forEach((q, idx) => {
        const selected = q.querySelector('input[type="radio"]:checked');
        const options = q.querySelectorAll('.quiz-option');
        const correct = parseInt(q.dataset.correct);

        if (!selected) { allAnswered = false; return; }

        const selIdx = parseInt(selected.value);
        options.forEach((o, oi) => {
          o.style.borderColor = oi === correct ? '#059669' : '';
          o.style.background = oi === correct ? 'rgba(5,150,105,0.08)' : '';
        });
        if (selIdx === correct) { score++; }
        else { selected.closest('.quiz-option').style.borderColor = '#DC2626'; }
      });

      if (!allAnswered) { alert('يرجى الإجابة على جميع الأسئلة أولاً'); return; }

      const pct = Math.round((score / total) * 100);
      let grade = 'ضعيف', gradeClr = '#DC2626';
      if (pct >= 90) { grade = 'ممتاز'; gradeClr = '#059669'; }
      else if (pct >= 75) { grade = 'جيد جداً'; gradeClr = '#16a34a'; }
      else if (pct >= 60) { grade = 'جيد'; gradeClr = '#ca8a04'; }
      else if (pct >= 45) { grade = 'مقبول'; gradeClr = '#ea580c'; }

      results = `
        <div class="quiz-results" style="margin-top:20px;padding:24px;background:var(--card);border-radius:12px;border:1px solid var(--border);">
          <div style="text-align:center;padding:24px;background:linear-gradient(135deg,var(--primary),var(--primary-light));border-radius:12px;color:#fff;margin-bottom:16px;">
            <div style="font-size:48px;font-weight:900;line-height:1;">${score}/${total}</div>
            <div style="font-size:20px;opacity:0.85;">${pct}%</div>
            <div style="font-size:26px;font-weight:700;color:var(--accent);margin-top:8px;">${grade}</div>
          </div>
        </div>`;

      this.style.display = 'none';
      quiz.querySelector('.quiz-results')?.remove();
      quiz.insertAdjacentHTML('beforeend', results);
    });
  });

  /* ===== QUESTION BANK CATEGORIES ===== */
  document.querySelectorAll('.qb-cat').forEach(cat => {
    cat.addEventListener('click', function () {
      const target = this.dataset.target;
      document.querySelectorAll('.qb-cat').forEach(c => {
        c.style.borderColor = ''; c.style.boxShadow = '';
      });
      this.style.borderColor = 'var(--accent)';
      this.style.boxShadow = '0 0 0 3px rgba(212,160,23,0.15)';
      document.querySelectorAll('.qb-exam-mode').forEach(e => {
        e.style.display = e.id === target ? 'block' : 'none';
      });
    });
  });

  const firstCat = document.querySelector('.qb-cat');
  if (firstCat) {
    firstCat.style.borderColor = 'var(--accent)';
    firstCat.style.boxShadow = '0 0 0 3px rgba(212,160,23,0.15)';
    document.querySelectorAll('.qb-exam-mode').forEach(e => {
      e.style.display = e.id === firstCat.dataset.target ? 'block' : 'none';
    });
  }

  /* ===== BACK TO TOP ===== */
  const backToTop = document.createElement('button');
  backToTop.innerHTML = '<i class="fas fa-arrow-up"></i>';
  backToTop.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:999;width:48px;height:48px;
    border-radius:50%;background:var(--accent);color:var(--primary);
    border:none;font-size:18px;cursor:pointer;
    box-shadow:0 4px 15px rgba(212,160,23,0.3);
    transition:all 0.3s ease;opacity:0;transform:translateY(20px);
    pointer-events:none;display:flex;align-items:center;justify-content:center;
  `;
  backToTop.onmouseenter = function () { this.style.transform = 'translateY(-3px)'; };
  backToTop.onmouseleave = function () { this.style.transform = ''; };
  backToTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.appendChild(backToTop);

  window.addEventListener('scroll', () => {
    if (window.scrollY > 400) {
      backToTop.style.opacity = '1'; backToTop.style.transform = 'translateY(0)';
      backToTop.style.pointerEvents = 'auto';
    } else {
      backToTop.style.opacity = '0'; backToTop.style.transform = 'translateY(20px)';
      backToTop.style.pointerEvents = 'none';
    }
  });

  /* ===== LESSON SAVE ===== */
  document.querySelectorAll('.btn-save-lesson').forEach(btn => {
    btn.addEventListener('click', function () {
      const icon = this.querySelector('i');
      icon.classList.toggle('fas');
      icon.classList.toggle('far');
      this.style.background = icon.classList.contains('fas') ? 'rgba(212,160,23,0.1)' : '';
      alert(icon.classList.contains('fas') ? '✅ تم حفظ المحاضرة' : 'تم إزالتها من المحفوظات');
    });
  });

  /* ===== COUNTER ===== */
  document.querySelectorAll('.stat-card-value, .admin-stat-card .value').forEach(el => {
    const target = parseInt(el.textContent);
    if (target && target < 1000 && target > 0) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            let cur = 0;
            const step = Math.ceil(target / 30);
            const t = setInterval(() => {
              cur += step;
              if (cur >= target) { cur = target; clearInterval(t); }
              el.textContent = cur;
            }, 40);
            obs.unobserve(el);
          }
        });
      }, { threshold: 0.5 });
      obs.observe(el);
    }
  });
});
