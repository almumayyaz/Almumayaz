(function() {
  'use strict';

  var BAR_ID = 'annBar';
  var INNER_ID = 'annBarInner';
  var CONFIG = { interval: 3000 };
  var container, inner;
  var items = [];
  var current = 0;
  var timer = null;
  var paused = false;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function init() {
    container = document.getElementById(BAR_ID);
    if (!container) return;
    inner = document.getElementById(INNER_ID);
    if (!inner) return;
    injectStyles();
    addEventListeners();
    loadInitialData();
    connectRTDB();
  }

  function loadInitialData() {
    try {
      var script = document.getElementById('annBarData');
      if (!script || !script.textContent) return;
      var list = JSON.parse(script.textContent);
      if (!Array.isArray(list) || !list.length) return;
      list.sort(function(a, b) {
        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });
      render(list);
    } catch (e) {
      console.warn('annBar: failed to parse initial data', e);
    }
  }

  function esc(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function render(list) {
    items = list;
    current = 0;

    if (!items.length) {
      container.style.display = 'none';
      return;
    }

    container.style.display = '';
    inner.innerHTML = '';

    items.forEach(function(a, i) {
      var link = a.link || '';
      var title = esc(a.title || '');
      var content = esc(a.content || '');
      var icon = esc(a.icon || '📢');
      var important = a.important;

      var div = document.createElement('div');
      div.className = 'annBar-item' + (i === 0 ? ' annBar-item--active' : '');
      div.setAttribute('data-index', i);
      if (i !== 0) div.setAttribute('aria-hidden', 'true');
      if (link) div.setAttribute('data-link', link);
      div.setAttribute('tabindex', '0');
      div.setAttribute('role', 'button');

      var row = document.createElement('div');
      row.className = 'annBar-row';

      var iconSpan = document.createElement('span');
      iconSpan.className = 'annBar-icon';
      iconSpan.textContent = icon;

      var textWrap = document.createElement('div');
      textWrap.className = 'annBar-text-wrap';

      if (title) {
        var titleSpan = document.createElement('span');
        titleSpan.className = 'annBar-title';
        titleSpan.textContent = title;
        if (important) titleSpan.className += ' annBar-title--important';
        textWrap.appendChild(titleSpan);
      }

      if (content) {
        var contSpan = document.createElement('span');
        contSpan.className = 'annBar-content';
        contSpan.textContent = content;
        textWrap.appendChild(contSpan);
      }

      if (!title && !content) {
        var fallback = document.createElement('span');
        fallback.className = 'annBar-title';
        fallback.textContent = '📢';
        textWrap.appendChild(fallback);
      }

      row.appendChild(iconSpan);
      row.appendChild(textWrap);
      div.appendChild(row);
      inner.appendChild(div);
    });

    updateAriaLabel();
    if (items.length > 1 && !reduced) startRotation();
  }

  function goTo(index) {
    if (index < 0 || index >= items.length) return;
    var prev = inner.querySelector('.annBar-item--active');
    var next = inner.querySelector('.annBar-item[data-index="' + index + '"]');
    if (!next || next === prev) return;

    if (prev) {
      prev.classList.remove('annBar-item--active');
      prev.setAttribute('aria-hidden', 'true');
    }
    next.classList.add('annBar-item--active');
    next.removeAttribute('aria-hidden');
    current = index;
    updateAriaLabel();
  }

  function updateAriaLabel() {
    var active = inner.querySelector('.annBar-item--active');
    if (active) {
      var txt = active.querySelector('.annBar-title');
      container.setAttribute('aria-label', (txt ? txt.textContent : '') + ' — ' + (current + 1) + ' / ' + items.length);
    }
  }

  function startRotation() {
    stopRotation();
    if (reduced || items.length <= 1) return;
    timer = setInterval(function() {
      if (paused) return;
      goTo((current + 1) % items.length);
    }, CONFIG.interval);
  }

  function stopRotation() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function addEventListeners() {
    var rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    rmq.addEventListener('change', function(e) {
      reduced = e.matches;
      if (reduced) { stopRotation(); goTo(0); }
      else if (items.length > 1) startRotation();
    });

    container.addEventListener('mouseenter', function() { paused = true; });
    container.addEventListener('mouseleave', function() { paused = false; });
    container.addEventListener('focusin', function() { paused = true; });
    container.addEventListener('focusout', function() { paused = false; });

    container.addEventListener('click', function(e) {
      var item = e.target.closest('.annBar-item');
      if (!item) return;
      var link = item.getAttribute('data-link');
      if (link) window.location.href = link;
    });

    container.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var item = e.target.closest('.annBar-item');
        if (item) {
          var link = item.getAttribute('data-link');
          if (link) window.location.href = link;
        }
      }
    });

    window.addEventListener('scroll', function() {
      var rect = container.getBoundingClientRect();
      if (rect.top < 0) container.classList.add('annBar--scrolled');
      else container.classList.remove('annBar--scrolled');
    }, { passive: true });
  }

  function connectRTDB() {
    if (typeof firebase === 'undefined' || typeof firebase.database === 'undefined') {
      var s = document.createElement('script');
      s.src = 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database-compat.js';
      s.async = true;
      s.onload = listenRTDB;
      s.onerror = function() {};
      document.head.appendChild(s);
      return;
    }
    listenRTDB();
  }

  function listenRTDB() {
    if (typeof firebase === 'undefined' || typeof firebase.database === 'undefined') return;
    try {
      firebase.database().ref('announcements').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        var list = Object.keys(val).map(function(k) { var d = val[k]; d._key = k; return d; });
        list = list.filter(function(a) { return a.active !== false; });
        list.sort(function(a, b) {
          if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
          return (Number(b.id) || 0) - (Number(a.id) || 0);
        });
        render(list);
      });
    } catch (e) {
      console.error('annBar: RTDB error', e);
    }
  }

  function injectStyles() {
    if (document.getElementById('annBar-style')) return;
    var css = document.createElement('style');
    css.id = 'annBar-style';
    css.textContent =
      '#annBar{' +
        'position:sticky;' +
        'top:0;' +
        'z-index:99;' +
        'width:100%;' +
        'margin-bottom:8px;' +
        'border-radius:var(--ann-bar-radius);' +
        'background:var(--ann-bar-bg);' +
        'backdrop-filter:blur(var(--ann-bar-blur));' +
        '-webkit-backdrop-filter:blur(var(--ann-bar-blur));' +
        'border:1px solid var(--ann-bar-border);' +
        'box-shadow:var(--ann-bar-shadow);' +
        'overflow:hidden;' +
        'cursor:default;' +
        'direction:rtl;' +
      '}' +
      '#annBar.annBar--scrolled{' +
        'border-radius:0;' +
        'margin-bottom:0;' +
        'box-shadow:var(--ann-bar-shadow-scrolled);' +
      '}' +
      '.annBar-inner{' +
        'position:relative;' +
        'min-height:56px;' +
        'display:flex;' +
        'align-items:center;' +
      '}' +
      '.annBar-item{' +
        'display:none;' +
        'width:100%;' +
        'box-sizing:border-box;' +
        'animation:annBarFadeIn 0.45s ease forwards;' +
      '}' +
      '.annBar-item--active{display:block}' +
      '.annBar-row{' +
        'display:flex;' +
        'align-items:flex-start;' +
        'gap:12px;' +
        'padding:12px 16px;' +
      '}' +
      '.annBar-icon{' +
        'flex-shrink:0;' +
        'font-size:var(--ann-bar-icon-size);' +
        'line-height:1.6;' +
        'margin-top:2px;' +
      '}' +
      '.annBar-text-wrap{' +
        'flex:1;' +
        'min-width:0;' +
        'display:flex;' +
        'flex-direction:column;' +
        'gap:3px;' +
      '}' +
      '.annBar-title{' +
        'font-size:var(--ann-bar-title-size);' +
        'font-weight:700;' +
        'color:var(--ann-bar-title-color);' +
        'line-height:1.5;' +
      '}' +
      '.annBar-title--important{' +
        'color:var(--ann-bar-important-color);' +
      '}' +
      '.annBar-content{' +
        'font-size:var(--ann-bar-content-size);' +
        'font-weight:500;' +
        'color:var(--ann-bar-content-color);' +
        'line-height:1.6;' +
        'display:-webkit-box;' +
        '-webkit-line-clamp:var(--ann-bar-content-lines);' +
        '-webkit-box-orient:vertical;' +
        'overflow:hidden;' +
      '}' +
      '[data-link] .annBar-title{' +
        'color:var(--ann-bar-link-color);' +
        'text-decoration:underline;' +
        'text-underline-offset:2px;' +
        'text-decoration-color:color-mix(in srgb,var(--ann-bar-link-color) 40%,transparent);' +
      '}' +
      '.annBar-item:focus-visible{' +
        'outline:2px solid var(--ann-bar-focus-color);' +
        'outline-offset:-2px;' +
        'border-radius:12px;' +
      '}' +
      '@keyframes annBarFadeIn{' +
        'from{opacity:0;transform:translateY(-8px)}' +
        'to{opacity:1;transform:translateY(0)}' +
      '}' +
      '@media(prefers-reduced-motion:reduce){' +
        '.annBar-item{animation:none}' +
      '}';
    document.head.appendChild(css);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
