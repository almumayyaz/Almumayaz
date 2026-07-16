(function() {
  var players = [];
  var savedSecond = 0;
  var lastServerPos = 0;
  var autoCompleteSent = false;
  var heartbeatInterval = null;
  var lastHeartbeatPosition = 0;

  function sendHeartbeat(pos, dur, forceComplete) {
    if (isGuest) { return; }
    var watchedSinceLast = Math.max(0, Math.floor(pos) - lastHeartbeatPosition);
    if (watchedSinceLast < 1 && !forceComplete) { return; }
    lastHeartbeatPosition = Math.floor(pos);
    fetch('/api/analytics/video/heartbeat', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ courseId: courseId, lessonId: lessonId, position: Math.floor(pos || 0), duration: Math.floor(dur || 1), watchedSeconds: forceComplete ? 0 : watchedSinceLast, forceComplete: !!forceComplete })
    }).then(function(r) { return r.json(); });
  }

  var storageKey = 'lughati-progress-' + courseId + '-' + lessonId;
  function loadLocalProgress() {
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      savedSecond = saved.lastSecond || 0;
      return saved;
    } catch(e) { return {}; }
  }
  function saveLocalProgress(lastSecond, pct, completed) {
    try {
      var data = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (lastSecond !== undefined) data.lastSecond = lastSecond;
      if (pct !== undefined) data.percentage = pct;
      if (completed !== undefined) data.completed = completed;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch(e) {}
  }

  function loadServerProgress() {
    fetch('/api/student/progress/' + encodeURIComponent(courseId))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success && d.progress) {
          var pct = d.progress.percentage || 0;
          var completed = (d.progress.completedLessons || []).includes(lessonId);
          // Prefer per-lesson position, fall back to course-level position
          var resumePos = (d.progress.positions && d.progress.positions[lessonId]) || d.progress.position || 0;
          updateUI(pct, completed);
          if (completed) {
            saveLocalProgress(undefined, pct, true);
            updateInfoBar(true);
          }
          if (resumePos > 1 && !completed) {
            savedSecond = resumePos;
            saveLocalProgress(resumePos, pct, false);
            players.forEach(function(p) {
              try { p.currentTime = resumePos; } catch(e) {}
              var notice = document.createElement('div');
              notice.style.cssText = 'position:absolute;top:18%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.7);color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:20;pointer-events:none;text-align:center;animation:fadeOut 3s ease forwards;';
              notice.textContent = 'استكمال من ' + Math.floor(resumePos / 60) + ':' + String(Math.floor(resumePos % 60)).padStart(2, '0');
              var container = p.elements && p.elements.container;
              if (container) { container.appendChild(notice); setTimeout(function () { notice.remove(); }, 3000); }
            });
          } else {
            loadLocalProgress();
          }
        } else {
          loadLocalProgress();
        }
      }).catch(function() { loadLocalProgress(); });
  }

  function saveServerProgress(pct, completed, pos) {
    fetch('/api/student/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ courseId: courseId, lessonId: lessonId, completed: completed || false, percentage: pct, position: (pos !== undefined ? pos : Math.floor(savedSecond || 0)) })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.success && completed) {
        updateUI(100, true);
      }
    });
  }

  function updateUI(pct, completed) {
    var bar = document.getElementById('progressBar');
    var label = document.getElementById('progressPct');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = pct + '%';
    updateInfoBar(completed);
  }

  function updateInfoBar(completed) {
    var bar = document.getElementById('lessonInfoBar');
    if (!bar) return;
    bar.style.display = 'flex';
    var status = document.getElementById('watchStatus');
    if (!status) return;
    if (completed) {
      status.innerHTML = '<i class="fas fa-check-circle" style="color:var(--success);font-size:12px;"></i> <span style="color:var(--success);">مكتمل</span>';
    } else {
      status.innerHTML = '<i class="fas fa-play-circle" style="color:var(--accent);font-size:12px;"></i> قيد المشاهدة';
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'F12' || e.keyCode === 123) { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) {
      var k = (e.key || '').toLowerCase();
      if (k === 's' || k === 'p' || k === 'u') e.preventDefault();
    }
  });

  function embedFallback(container) {
    var id = container.getAttribute('data-plyr-embed-id');
    if (!id) return;
    var src = 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?rel=0&modestbranding=1&iv_load_policy=3&controls=0';
    container.innerHTML = '<iframe src="' + src + '" style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>';
  }

  function setupYoutubeOverlay(container, player) {
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
  }

  if (typeof Plyr === 'undefined') {
    document.querySelectorAll('.plyr-container[data-plyr-embed-id]').forEach(embedFallback);
  } else {
    document.querySelectorAll('.plyr-container[data-plyr-embed-id]').forEach(function (container) {
      var videoId = container.getAttribute('data-plyr-embed-id');
      if (!videoId) { return; }

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

      player.on('ready', function () {
        updateInfoBar(false);
        updateUI(0, false);
        loadServerProgress();
      });

      player.on('timeupdate', function () {
        var ct = player.currentTime || 0;
        var dur = player.duration || 1;
        var pct = Math.min(Math.round((ct / dur) * 100), 100);
        if (pct >= 95 && !autoCompleteSent) {
          autoCompleteSent = true;
          saveLocalProgress(0, 100, true);
          saveServerProgress(100, true, Math.floor(ct));
          updateUI(100, true);
          sendHeartbeat(ct, dur, true);
        }
        if (Math.floor(ct) !== Math.floor(savedSecond)) {
          savedSecond = Math.floor(ct);
          saveLocalProgress(savedSecond, pct, false);
          updateUI(pct, false);
        }
        // Persist current position to server continuously (so resume works after refresh/close)
        if (Math.floor(ct) !== Math.floor(lastServerPos)) {
          lastServerPos = Math.floor(ct);
          saveServerProgress(pct, false, Math.floor(ct));
        }
      });

      player.on('pause', function () {
        var ct = player.currentTime || 0;
        var dur = player.duration || 1;
        var pct = Math.min(Math.round((ct / dur) * 100), 100);
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
        if (pct >= 95 && !autoCompleteSent) {
          autoCompleteSent = true;
          saveLocalProgress(0, 100, true);
          saveServerProgress(100, true, Math.floor(ct));
          updateUI(100, true);
          return;
        }
        saveLocalProgress(Math.floor(ct), pct, false);
        saveServerProgress(pct, false, Math.floor(ct));
        if (Math.floor(ct) !== lastHeartbeatPosition) {
          sendHeartbeat(ct, dur, false);
          lastHeartbeatPosition = Math.floor(ct);
        }
      });

      player.on('play', function () {
        var ct = player.currentTime || 0;
        updateInfoBar(false);
        lastHeartbeatPosition = Math.floor(ct);
        if (heartbeatInterval) { clearInterval(heartbeatInterval); }
        heartbeatInterval = setInterval(function() {
          var ct2 = player.currentTime || 0;
          if (Math.floor(ct2) !== lastHeartbeatPosition) {
            sendHeartbeat(ct2, player.duration || 1, false);
            lastHeartbeatPosition = Math.floor(ct2);
          }
        }, 15000);
      });

      player.on('ended', function () {
        saveLocalProgress(0, 100, true);
        saveServerProgress(100, true, Math.floor(player.currentTime || 0));
        updateUI(100, true);
      });

      setupYoutubeOverlay(container, player);
    });
  }

  setInterval(function() {
    if (players.length > 0) {
      players.forEach(function(p, i) {
        try {
          var ct = p.currentTime || 0;
          var dur = p.duration || 0;
        } catch(e) {}
      });
    }
  }, 1000);

  window.addEventListener('beforeunload', function() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    players.forEach(function(p) {
      var ct = p.currentTime || 0;
      var dur = p.duration || 1;
      var pct = Math.min(Math.round((ct / dur) * 100), 100);
      saveLocalProgress(Math.floor(ct), pct, false);
      if (!isGuest && ct > 0) {
        navigator.sendBeacon('/api/analytics/video/heartbeat', JSON.stringify({ courseId: courseId, lessonId: lessonId, position: Math.floor(ct), duration: Math.floor(dur), watchedSeconds: 0, forceComplete: false }));
      }
    });
  });

  loadServerProgress();
})();
