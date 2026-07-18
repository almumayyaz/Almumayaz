(function() {
  var players = [];
  var isGuest = self.isGuest;
  var localKey = 'lughati-progress-' + courseId + '-' + lessonId;

  // ── Local Storage ──────────────────────────────────────────
  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(localKey) || '{}'); } catch(e) { return {}; }
  }
  function saveLocal(data) {
    try {
      var cur = loadLocal();
      Object.assign(cur, data);
      localStorage.setItem(localKey, JSON.stringify(cur));
    } catch(e) {}
  }

  // ── State ──────────────────────────────────────────────────
  var completedSent = false;
  var lastSaveTime = 0;
  var hbLastPos = -1;

  // ── Server: save current progress ──────────────────────────
  function savePosition(pct, completed, pos) {
    fetch('/api/student/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        courseId: courseId, lessonId: lessonId,
        percentage: pct, completed: !!completed, position: pos || 0
      })
    });
  }

  // ── Server: send heartbeat with watched seconds since last heartbeat ──
  function sendHeartbeat(p, dur, watched) {
    if (isGuest || watched <= 0) return;
    hbLastPos = Math.floor(p);
    fetch('/api/analytics/video/heartbeat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        courseId: courseId, lessonId: lessonId,
        position: Math.floor(p), duration: Math.floor(dur || 1),
        watchedSeconds: watched, forceComplete: false
      })
    });
  }

  // ── Server: load saved position and resume ─────────────────
  function loadPosition() {
    fetch('/api/student/progress/' + encodeURIComponent(courseId))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.success || !d.progress) { tryLocal(); return; }
        var pos = (d.progress.positions && d.progress.positions[lessonId]) || 0;
        var isComplete = (d.progress.completedLessons || []).indexOf(lessonId) !== -1;
        if (isComplete) { markComplete(); return; }
        if (pos > 1) { resumeTo(pos); return; }
        tryLocal();
      })
      .catch(function() { tryLocal(); });

    function tryLocal() {
      var data = loadLocal();
      if (data && data.position > 1) resumeTo(data.position);
    }
  }

  function resumeTo(pos) {
    hbLastPos = Math.floor(pos);
    players.forEach(function(p) {
      var done = false;
      function seek() {
        if (done) return; done = true;
        try { p.currentTime = pos; } catch(e) {
          setTimeout(function() { try { p.currentTime = pos; } catch(e2) {} }, 1000);
        }
      }
      if (p.on) p.on('canplay', seek);
      seek();
      showResumeNotice(pos);
    });
  }

  function showResumeNotice(pos) {
    var m = Math.floor(pos / 60);
    var s = Math.floor(pos % 60);
    players.forEach(function(p) {
      var el = document.createElement('div');
      el.style.cssText = 'position:absolute;top:18%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.7);color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:20;pointer-events:none;text-align:center;animation:fadeOut 3s ease forwards;';
      el.textContent = '\u0627\u0633\u062A\u0643\u0645\u0627\u0644 \u0645\u0646 ' + m + ':' + String(s).padStart(2, '0');
      var c = p.elements && p.elements.container;
      if (c) { c.appendChild(el); setTimeout(function() { el.remove(); }, 3000); }
    });
  }

  function markComplete() {
    completedSent = true;
    saveLocal({ position: 0, percentage: 100, completed: true });
    updateUI(100, true);
  }

  function completeLesson() {
    if (completedSent) return;
    completedSent = true;
    saveLocal({ position: 0, percentage: 100, completed: true });
    savePosition(100, true, 0);
    updateUI(100, true);
    // Backup: send heartbeat with forceComplete
    fetch('/api/analytics/video/heartbeat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        courseId: courseId, lessonId: lessonId,
        position: 9999, duration: 10000,
        watchedSeconds: 0, forceComplete: true
      })
    });
  }

  function updateUI(pct, completed) {
    var bar = document.getElementById('progressBar');
    var label = document.getElementById('progressPct');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = pct + '%';
    var ib = document.getElementById('lessonInfoBar');
    if (ib) ib.style.display = 'flex';
    var st = document.getElementById('watchStatus');
    if (!st) return;
    var done = completed || completedSent;
    st.innerHTML = done
      ? '<i class="fas fa-check-circle" style="color:var(--success);font-size:12px;"></i> <span style="color:var(--success);">\u0645\u0643\u062A\u0645\u0644</span>'
      : '<i class="fas fa-play-circle" style="color:var(--accent);font-size:12px;"></i> \u0642\u064A\u062F \u0627\u0644\u0645\u0634\u0627\u0647\u062F\u0629';
  }

  // ── beforeunload: last-chance save ─────────────────────────
  window.addEventListener('beforeunload', function() {
    players.forEach(function(p) {
      var ct = p.currentTime || 0;
      var pos = Math.floor(ct);
      if (pos < 1) return;
      var watched = hbLastPos >= 0 ? pos - hbLastPos : 0;
      saveLocal({ position: pos });
      navigator.sendBeacon('/api/student/progress', JSON.stringify({
        courseId: courseId, lessonId: lessonId,
        completed: false, percentage: 0, position: pos
      }));
      navigator.sendBeacon('/api/analytics/video/heartbeat', JSON.stringify({
        courseId: courseId, lessonId: lessonId,
        position: pos, duration: 0, watchedSeconds: Math.max(0, watched), forceComplete: false
      }));
    });
  });

  // ── Keyboard protection ────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F12' || e.keyCode === 123) { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) {
      var k = (e.key || '').toLowerCase();
      if (k === 's' || k === 'p' || k === 'u') e.preventDefault();
    }
  });

  // ── Plyr init ──────────────────────────────────────────────
  if (typeof Plyr === 'undefined') {
    document.querySelectorAll('.plyr-container[data-plyr-embed-id]').forEach(function(c) {
      var id = c.getAttribute('data-plyr-embed-id');
      if (!id) return;
      c.innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(id) + '?rel=0&modestbranding=1&iv_load_policy=3&controls=0" style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>';
    });
  } else {
    document.querySelectorAll('.plyr-container[data-plyr-embed-id]').forEach(function(container) {
      var videoId = container.getAttribute('data-plyr-embed-id');
      if (!videoId) return;

      var player = new Plyr(container, {
        iconUrl: '/img/plyr.svg',
        controls: ['play-large', 'play', 'progress', 'current-time', 'duration'],
        youtube: { noCookie: true, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1 },
        urls: { youtube: { api: '' } },
        keyboard: { focused: true, global: false },
        clickToPlay: true,
        hideControls: true,
        resetOnEnd: false,
        displayDuration: true
      });
      players.push(player);

      // ── Ready: load saved position ──
      player.on('ready', function() {
        updateUI(0, false);
        hbLastPos = Math.floor(player.currentTime || 0);
        loadPosition();
      });

      // ── Timeupdate: update UI immediately + save every 5s ──
      player.on('timeupdate', function() {
        var ct = player.currentTime || 0;
        var dur = player.duration;
        var valid = dur > 1 && isFinite(dur);
        var pct = valid ? Math.min(Math.round((ct / dur) * 100), 100) : 0;

        updateUI(pct, false);

        if (pct >= 95 && !completedSent && valid) {
          completeLesson();
          return;
        }

        var now = Date.now();
        if (now - lastSaveTime < 5000) return;
        lastSaveTime = now;

        var pos = Math.floor(ct);
        savePosition(pct, false, pos);
        saveLocal({ position: pos, percentage: pct });

        // Send heartbeat with watched seconds since last heartbeat
        var watched = hbLastPos >= 0 ? pos - hbLastPos : 0;
        if (watched > 0) {
          sendHeartbeat(ct, dur, watched);
        } else if (hbLastPos < 0) {
          hbLastPos = pos;
        }
      });

      // ── Pause: save immediately ──
      player.on('pause', function() {
        var ct = player.currentTime || 0;
        var dur = player.duration;
        var valid = dur > 1 && isFinite(dur);
        var pct = valid ? Math.min(Math.round((ct / dur) * 100), 100) : 0;

        updateUI(pct, false);

        if (pct >= 95 && !completedSent && valid) {
          completeLesson();
          return;
        }
        var pos = Math.floor(ct);
        savePosition(pct, false, pos);
        saveLocal({ position: pos, percentage: pct });

        // Heartbeat on pause
        var watched = hbLastPos >= 0 ? pos - hbLastPos : 0;
        if (watched > 0) { sendHeartbeat(ct, dur, watched); }
        hbLastPos = pos;
      });

      // ── Ended: mark complete ──
      player.on('ended', function() { completeLesson(); });

      // ── YouTube overlay ──
      (function setupOverlay(container, player) {
        var wrapper = container.querySelector('.plyr__video-wrapper');
        if (!wrapper) return;
        wrapper.style.position = 'relative';
        var topEl = document.createElement('div');
        topEl.className = 'plyr-youtube-overlay plyr-youtube-overlay-top';
        var botEl = document.createElement('div');
        botEl.className = 'plyr-youtube-overlay plyr-youtube-overlay-bottom';
        wrapper.appendChild(topEl);
        wrapper.appendChild(botEl);
        function show(){ topEl.classList.remove('plyr-youtube-overlay-hidden'); botEl.classList.remove('plyr-youtube-overlay-hidden'); }
        function hide(){ topEl.classList.add('plyr-youtube-overlay-hidden'); botEl.classList.add('plyr-youtube-overlay-hidden'); }
        player.on('ready', function(){ if (player.playing) hide(); else show(); });
        player.on('playing', hide);
        player.on('pause', show);
        player.on('ended', show);
      })(container, player);
    });
  }
})();
