(function() {
  var completedSent = false;
  var lastSaveTime = 0;
  var hbLastPos = -1;
  var localKey = 'lughati-progress-' + courseId + '-' + lessonId;
  var players = [];

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

  function savePosition(pct, completed, pos) {
    return fetch('/api/student/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      keepalive: true,
      body: JSON.stringify({courseId: courseId, lessonId: lessonId, percentage: pct, completed: !!completed, position: pos || 0})
    }).catch(function(){});
  }

  function sendHeartbeat(p, dur, watched) {
    if (isGuest || watched <= 0) return;
    hbLastPos = Math.floor(p);
    fetch('/api/analytics/video/heartbeat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({courseId: courseId, lessonId: lessonId, position: Math.floor(p), duration: Math.floor(dur || 1), watchedSeconds: watched, forceComplete: false})
    });
  }

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
      try { p.currentTime = pos; } catch(e) {
        setTimeout(function() { try { p.currentTime = pos; } catch(e2) {} }, 1000);
      }
    });
    showResumeNotice(pos);
  }

  function showResumeNotice(pos) {
    var m = Math.floor(pos / 60);
    var s = Math.floor(pos % 60);
    players.forEach(function(p) {
      var el = document.createElement('div');
      el.textContent = '\u0627\u0633\u062A\u0643\u0645\u0627\u0644 \u0645\u0646 ' + m + ':' + String(s).padStart(2, '0');
      Object.assign(el.style, {position:'absolute',top:'18%',left:'50%',transform:'translate(-50%,-50%)',background:'rgba(0,0,0,0.7)',color:'#fff',padding:'10px 18px',borderRadius:'8px',fontSize:'13px',zIndex:'20',pointerEvents:'none',textAlign:'center',animation:'fadeOut 3s ease forwards'});
      var c = p.elements && p.elements.container;
      if (c) { c.appendChild(el); setTimeout(function() { el.remove(); }, 3000); }
    });
  }

  function markComplete() {
    completedSent = true;
    saveLocal({ position: 0, percentage: 100, completed: true });
    updateUI(100, true);
  }

  async function completeLesson() {
    if (completedSent) return;
    completedSent = true;
    saveLocal({ position: 0, percentage: 100, completed: true });
    await savePosition(100, true, 0);
    updateUI(100, true);
    fetch('/api/analytics/video/heartbeat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({courseId: courseId, lessonId: lessonId, position: 9999, duration: 10000, watchedSeconds: 0, forceComplete: true})
    });
  }

  function updateUI(pct, completed) {
    var ib = document.getElementById('lessonInfoBar');
    if (ib) ib.style.display = 'flex';
    var st = document.getElementById('watchStatus');
    if (!st) return;
    var done = completed || completedSent;
    st.innerHTML = done
      ? '<i class="fas fa-check-circle" style="color:var(--success);font-size:12px;"></i> <span style="color:var(--success);">\u0645\u0643\u062A\u0645\u0644</span>'
      : '<i class="fas fa-play-circle" style="color:var(--accent);font-size:12px;"></i> \u0642\u064A\u062F \u0627\u0644\u0645\u0634\u0627\u0647\u062F\u0629';
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'F12' || e.keyCode === 123) { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) {
      var k = (e.key || '').toLowerCase();
      if (k === 's' || k === 'p' || k === 'u') e.preventDefault();
    }
  });

  document.querySelectorAll('.plyr__video-embed').forEach(function(container) {
    var id = container.id;
    if (!id) return;
    var videoId = container.querySelector('iframe').src.match(/\/embed\/([^?]+)/);
    if (!videoId) return;
    videoId = videoId[1];

    var player = new Plyr('#' + id, {
      controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'fullscreen'],
      youtube: { noCookie: true, rel: 0, iv_load_policy: 3, modestbranding: 1, controls: 0, fs: 0, cc_load_policy: 0 },
      poster: 'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg',
      ratio: '16:9',
      resetOnEnd: true,
      clickToPlay: true,
      tooltips: { controls: true, seek: false },
      displayDuration: true,
      invertTime: false,
      toggleInvert: false
    });
    players.push(player);

    var posterEl = container.querySelector('.plyr__poster');
    var controlsEl = null;
    var hideTimer = null;
    var HIDE_DELAY = 2000;
    var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    function showControls() {
      if (controlsEl) controlsEl.classList.remove('plyr__controls--hidden');
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
    }

    function startHideTimer(delay) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function() {
        if (controlsEl && player.playing) controlsEl.classList.add('plyr__controls--hidden');
      }, delay || HIDE_DELAY);
    }

    function handleMouseMove() {
      showControls();
      if (player.playing) startHideTimer();
    }

    function handleMouseLeave() {
      if (player.playing) startHideTimer();
    }

    player.on('ready', function() {
      controlsEl = container.parentElement.querySelector('.plyr__controls');
      updateUI(0, false);
      hbLastPos = Math.floor(player.currentTime || 0);
      loadPosition();

      function forceUnmute() {
        try {
          player.muted = false;
          player.volume = 1;
          if (player.embed && player.embed.unMute) player.embed.unMute();
          if (player.embed && player.embed.setVolume) player.embed.setVolume(100);
        } catch(e) {}
      }
      forceUnmute();
      setTimeout(forceUnmute, 500);
      setTimeout(forceUnmute, 1500);

      var plyrEl = container.parentElement;
      if (plyrEl) {
        plyrEl.addEventListener('mousemove', handleMouseMove);
        plyrEl.addEventListener('mouseleave', handleMouseLeave);
        if (isTouch) {
          plyrEl.addEventListener('touchstart', function() {
            showControls();
            startHideTimer(4000);
          }, {passive: true});
        }
      }
    });

    player.on('timeupdate', function() {
      var ct = player.currentTime || 0;
      var dur = player.duration;
      var valid = dur > 1 && isFinite(dur);
      var pct = valid ? Math.min(Math.round((ct / dur) * 100), 100) : 0;

      updateUI(pct, false);

      var now = Date.now();
      if (now - lastSaveTime < 5000) return;
      lastSaveTime = now;

      var pos = Math.floor(ct);
      savePosition(pct, false, pos);
      saveLocal({ position: pos, percentage: pct });

      var watched = hbLastPos >= 0 ? pos - hbLastPos : 0;
      if (watched > 0) {
        sendHeartbeat(ct, dur, watched);
      } else if (hbLastPos < 0) {
        hbLastPos = pos;
      }
    });

    player.on('pause', function() {
      showControls();
      if (posterEl) {
        posterEl.style.display = 'block';
        posterEl.style.opacity = '1';
      }
      var ct = player.currentTime || 0;
      var dur = player.duration;
      var valid = dur > 1 && isFinite(dur);
      var pct = valid ? Math.min(Math.round((ct / dur) * 100), 100) : 0;
      updateUI(pct, false);
      var pos = Math.floor(ct);
      savePosition(pct, false, pos);
      saveLocal({ position: pos, percentage: pct });
      var watched = hbLastPos >= 0 ? pos - hbLastPos : 0;
      if (watched > 0) { sendHeartbeat(ct, dur, watched); }
      hbLastPos = pos;
    });

    player.on('play', function() {
      if (posterEl) {
        posterEl.style.display = '';
        posterEl.style.opacity = '';
      }
      document.querySelectorAll('.plyr__control--overlaid').forEach(function(btn) {
        btn.style.display = 'none';
      });
      try { player.muted = false; player.volume = 1; } catch(e) {}
      startHideTimer();
    });

    player.on('ended', function() {
      showControls();
      setTimeout(function() { player.restart(); }, 500);
      if (!lessonHasQuiz) completeLesson();
    });
  });

  window.addEventListener('beforeunload', function() {
    players.forEach(function(p) {
      var ct = p.currentTime || 0;
      var pos = Math.floor(ct);
      if (pos < 1) return;
      var watched = hbLastPos >= 0 ? pos - hbLastPos : 0;
      saveLocal({ position: pos });
      navigator.sendBeacon('/api/student/progress', JSON.stringify({courseId: courseId, lessonId: lessonId, completed: completedSent, percentage: completedSent ? 100 : 0, position: completedSent ? 0 : pos}));
      navigator.sendBeacon('/api/analytics/video/heartbeat', JSON.stringify({courseId: courseId, lessonId: lessonId, position: pos, duration: 0, watchedSeconds: Math.max(0, watched), forceComplete: completedSent}));
    });
  });
})();
