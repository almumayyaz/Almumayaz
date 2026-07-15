(function () {
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === 's' || e.key === 'p' || e.key === 'u' || e.key === 'P')) e.preventDefault();
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) e.preventDefault();
  });

  var cfg = window.__PDF_CONFIG__ || {};
  if (!cfg.tokenUrl) return;

  // ---- DOM refs ----
  var viewport   = document.getElementById('pdf-viewport');
  var pagesEl    = document.getElementById('pdf-pages');
  var loadingEl  = document.getElementById('pdf-loading');
  var errorEl    = document.getElementById('pdf-error');
  var statusEl   = document.getElementById('pdf-status');
  var pageInput  = document.getElementById('pdf-page-input');
  var pageTotal  = document.getElementById('pdf-page-total');
  var zoomLabel  = document.getElementById('pdf-zoom-label');
  var searchBar  = document.getElementById('pdf-search-bar');
  var searchInput= document.getElementById('pdf-search-input');
  var searchCount= document.getElementById('pdf-search-count');

  // ---- state ----
  var pdfDoc = null, numPages = 0;
  var scale = 1;                 // user zoom factor (1 = fit width)
  var fitWidth = 800;            // css px width of a page at scale=1
  var defaultDim = null;         // {w,h} fallback aspect ratio (from page 1)
  var pageDims = [];             // real {w,h} per page once known
  var pageEls = [];              // placeholder <div> per page
  var rendered = {};             // idx -> { canvas, tl, task, page }
  var visible = new Map();       // idx -> intersectionRatio
  var currentIdx = 0;
  var observer = null;
  var syncPending = false;

  var searchResults = [];
  var searchIdx = -1;

  var BUFFER = 2;                // pages to render before/after visible
  var MAX_DPR = 2;
  var stateKey = 'pdf_state_' + btoa(cfg.tokenUrl).slice(0, 32);

  // ---- persistence ----
  function saveState() {
    try { localStorage.setItem(stateKey, JSON.stringify({ page: currentIdx + 1, scale: scale })); } catch (e) {}
  }
  function loadState() {
    try { var r = localStorage.getItem(stateKey); return r ? JSON.parse(r) : null; } catch (e) { return null; }
  }
  var saveTimer = null;
  function debouncedSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 700); }

  // ---- geometry helpers ----
  function clampPage(n) { return Math.max(1, Math.min(numPages, n)); }
  function dimOf(i) { return pageDims[i] || defaultDim || { w: 595, h: 842 }; }
  function pageCssW() { return Math.round(fitWidth * scale); }

  function computeFitWidth() {
    var pad = 24;
    var w = viewport.clientWidth - pad;
    if (w > 1100) w = 1100;
    if (w < 260) w = viewport.clientWidth - 6;
    fitWidth = w;
  }

  // set the single CSS var that drives every page width (heights follow via aspect-ratio)
  function applyWidth() {
    pagesEl.style.setProperty('--pw', pageCssW() + 'px');
  }

  // ---- scroll anchor (keep reading position across zoom/resize) ----
  function getAnchor() {
    var el = pageEls[currentIdx] || pageEls[0];
    if (!el) return { idx: 0, frac: 0 };
    var h = el.offsetHeight || 1;
    return { idx: currentIdx, frac: (viewport.scrollTop - el.offsetTop) / h };
  }
  function setAnchor(a) {
    var el = pageEls[a.idx];
    if (!el) return;
    viewport.scrollTop = el.offsetTop + a.frac * el.offsetHeight;
  }

  // ---- build placeholders ----
  function buildPlaceholders() {
    var frag = document.createDocumentFragment();
    var d = defaultDim || { w: 595, h: 842 };
    for (var i = 0; i < numPages; i++) {
      var el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.idx = i;
      el.style.aspectRatio = d.w + ' / ' + d.h;
      var badge = document.createElement('div');
      badge.className = 'pdf-page-badge';
      badge.textContent = (i + 1);
      el.appendChild(badge);
      var sp = document.createElement('div');
      sp.className = 'pdf-page-spin';
      el.appendChild(sp);
      pageEls[i] = el;
      frag.appendChild(el);
    }
    pagesEl.appendChild(frag);
  }

  // ---- dims correction with scroll compensation (no jump for pages above view) ----
  function updateDims(idx, w, h) {
    if (!defaultDim) defaultDim = { w: w, h: h };
    pageDims[idx] = { w: w, h: h };
    var el = pageEls[idx];
    if (!el) return;
    var ar = w + ' / ' + h;
    if (el.style.aspectRatio === ar) return;
    var beforeTop = el.offsetTop, beforeH = el.offsetHeight;
    el.style.aspectRatio = ar;
    var afterH = el.offsetHeight;
    // only compensate when the changed page sits entirely above the viewport
    if (beforeTop + beforeH <= viewport.scrollTop && afterH !== beforeH) {
      viewport.scrollTop += (afterH - beforeH);
    }
  }

  // ---- rendering ----
  function renderPage(idx) {
    if (!pdfDoc || idx < 0 || idx >= numPages || rendered[idx]) return;
    rendered[idx] = { pending: true };
    pdfDoc.getPage(idx + 1).then(function (pg) {
      if (!rendered[idx] || !rendered[idx].pending) return; // released meanwhile
      var base = pg.getViewport({ scale: 1 });
      updateDims(idx, base.width, base.height);

      var cssW = pageCssW();
      var cssH = cssW * base.height / base.width;
      var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      var renderVp = pg.getViewport({ scale: (cssW * dpr) / base.width });

      var cvs = document.createElement('canvas');
      cvs.className = 'pdf-page-canvas';
      cvs.width = Math.floor(renderVp.width);
      cvs.height = Math.floor(renderVp.height);

      var tl = document.createElement('div');
      tl.className = 'pdf-text-layer';
      tl.style.width = cssW + 'px';
      tl.style.height = cssH + 'px';

      var el = pageEls[idx];
      el.appendChild(cvs);
      el.appendChild(tl);
      el.classList.add('rendered');

      var task = pg.render({ canvasContext: cvs.getContext('2d', { alpha: false }), viewport: renderVp });
      rendered[idx] = { canvas: cvs, tl: tl, task: task, page: pg };

      task.promise.then(function () {
        if (!rendered[idx] || rendered[idx].canvas !== cvs) return;
        var textScale = cssW / base.width;
        var textVp = pg.getViewport({ scale: textScale });
        tl.style.setProperty('--scale-factor', textScale);
        try {
          pdfjsLib.renderTextLayer({ textContentSource: pg.streamTextContent(), container: tl, viewport: textVp });
        } catch (e) {}
        if (searchInput && searchInput.value) applySearchHighlights(idx);
      }).catch(function () {});
    }).catch(function () { delete rendered[idx]; });
  }

  function releasePage(idx) {
    var e = rendered[idx];
    if (!e) return;
    if (e.task && e.task.cancel) { try { e.task.cancel(); } catch (_) {} }
    if (e.canvas && e.canvas.parentNode) e.canvas.parentNode.removeChild(e.canvas);
    if (e.tl && e.tl.parentNode) e.tl.parentNode.removeChild(e.tl);
    var el = pageEls[idx];
    if (el) el.classList.remove('rendered');
    delete rendered[idx];
  }

  // ---- sync: decide what to render based on visible set (+buffer) ----
  function scheduleSync() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(function () { syncPending = false; sync(); });
  }

  function sync() {
    if (!numPages) return;
    var idxs = Array.from(visible.keys());
    var lo, hi;
    if (idxs.length) {
      lo = Math.min.apply(null, idxs);
      hi = Math.max.apply(null, idxs);
      // current page = highest intersection ratio (tie -> smallest idx)
      var best = -1, bestR = -1;
      visible.forEach(function (r, k) { if (r > bestR + 0.001 || (Math.abs(r - bestR) <= 0.001 && (best === -1 || k < best))) { bestR = r; best = k; } });
      if (best >= 0) currentIdx = best;
    } else {
      lo = hi = currentIdx;
    }
    var from = Math.max(0, lo - BUFFER);
    var to = Math.min(numPages - 1, hi + BUFFER);

    Object.keys(rendered).forEach(function (k) {
      k = +k;
      if (k < from || k > to) releasePage(k);
    });
    for (var i = from; i <= to; i++) {
      if (!rendered[i]) renderPage(i);
    }
    updateUI();
    debouncedSave();
  }

  function updateUI() {
    if (document.activeElement !== pageInput) pageInput.value = currentIdx + 1;
    if (pageTotal) pageTotal.textContent = numPages;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    if (statusEl) statusEl.textContent = '\u0635\u0641\u062D\u0629 ' + (currentIdx + 1) + ' \u0645\u0646 ' + numPages;
  }

  // ---- navigation ----
  function scrollToPage(num, smooth) {
    var idx = clampPage(num) - 1;
    var el = pageEls[idx];
    if (!el) return;
    viewport.scrollTo({ top: el.offsetTop - 4, behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---- zoom (keeps reading position) ----
  function zoom(newScale) {
    newScale = Math.min(4, Math.max(0.3, newScale));
    if (Math.abs(newScale - scale) < 0.001) return;
    var anchor = getAnchor();
    scale = newScale;
    applyWidth();
    // release everything (canvases now wrong resolution) then re-render around anchor
    Object.keys(rendered).forEach(function (k) { releasePage(+k); });
    setAnchor(anchor);        // forces reflow, restores position
    sync();
    updateUI();
    debouncedSave();
  }

  // ---- search ----
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function applySearchHighlights(idx) {
    var entry = rendered[idx];
    if (!entry || !entry.tl || !searchInput || !searchInput.value) return;
    var q = searchInput.value.toLowerCase().trim();
    if (!q) return;
    var spans = entry.tl.querySelectorAll('span');
    spans.forEach(function (s) {
      var txt = s.textContent;
      var ltxt = txt.toLowerCase();
      var html = '', ci = 0;
      while (ci < ltxt.length) {
        var fi = ltxt.indexOf(q, ci);
        if (fi === -1) { html += escapeHtml(txt.slice(ci)); break; }
        html += escapeHtml(txt.slice(ci, fi));
        html += '<span class="highlight">' + escapeHtml(txt.slice(fi, fi + q.length)) + '</span>';
        ci = fi + q.length;
      }
      s.innerHTML = html;
    });
  }

  function clearHighlights() {
    Object.keys(rendered).forEach(function (k) {
      var e = rendered[k];
      if (!e || !e.tl) return;
      e.tl.querySelectorAll('span').forEach(function (s) { s.innerHTML = escapeHtml(s.textContent); });
    });
  }

  function buildSearchIndex() {
    searchResults = [];
    searchIdx = -1;
    var q = searchInput.value.toLowerCase().trim();
    if (!q || !pdfDoc) { clearHighlights(); updateSearchCount(); return; }

    var promises = [];
    for (var i = 0; i < numPages; i++) {
      (function (pageIdx) {
        promises.push(
          pdfDoc.getPage(pageIdx + 1)
            .then(function (p) { return p.getTextContent(); })
            .then(function (tc) {
              var joined = tc.items.map(function (it) { return it.str; }).join(' ').toLowerCase();
              var ci = 0;
              while (true) {
                var fi = joined.indexOf(q, ci);
                if (fi === -1) break;
                searchResults.push({ page: pageIdx });
                ci = fi + q.length;
              }
            })
            .catch(function () {})
        );
      })(i);
    }

    Promise.all(promises).then(function () {
      searchResults.sort(function (a, b) { return a.page - b.page; });
      searchIdx = searchResults.length ? 0 : -1;
      updateSearchCount();
      Object.keys(rendered).forEach(function (k) { applySearchHighlights(+k); });
      if (searchResults.length) navigateToSearch(0);
    });
  }

  function navigateToSearch(idx) {
    if (idx < 0 || idx >= searchResults.length) return;
    searchIdx = idx;
    scrollToPage(searchResults[idx].page + 1, true);
    updateSearchCount();
    setTimeout(function () { Object.keys(rendered).forEach(function (k) { applySearchHighlights(+k); }); }, 350);
  }

  function updateSearchCount() {
    if (searchCount) searchCount.textContent = searchResults.length ? (searchIdx + 1) + '/' + searchResults.length : '';
  }

  // ---- boot ----
  fetch(cfg.tokenUrl, { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('auth'); return r.json(); })
    .then(function (d) {
      if (!d || !d.url) throw new Error('no-url');
      return pdfjsLib.getDocument({ url: d.url, disableAutoFetch: true, disableStream: false }).promise;
    })
    .then(function (pdf) {
      pdfDoc = pdf;
      numPages = pdf.numPages;

      var restored = loadState();
      if (restored && restored.scale) scale = restored.scale;

      return pdf.getPage(1).then(function (p1) {
        var vp = p1.getViewport({ scale: 1 });
        defaultDim = { w: vp.width, h: vp.height };
        pageDims[0] = { w: vp.width, h: vp.height };

        computeFitWidth();
        applyWidth();
        buildPlaceholders();
        loadingEl.style.display = 'none';

        // IntersectionObserver drives lazy rendering
        observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            var idx = +e.target.dataset.idx;
            if (e.isIntersecting && e.intersectionRatio > 0) visible.set(idx, e.intersectionRatio);
            else visible.delete(idx);
          });
          scheduleSync();
        }, { root: viewport, rootMargin: '120px 0px', threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });

        for (var i = 0; i < pageEls.length; i++) observer.observe(pageEls[i]);

        viewport.addEventListener('scroll', scheduleSync, { passive: true });

        var resizeTimer = null;
        window.addEventListener('resize', function () {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            var a = getAnchor();
            computeFitWidth();
            applyWidth();
            Object.keys(rendered).forEach(function (k) { releasePage(+k); });
            setAnchor(a);
            sync();
          }, 150);
        });

        // restore position, then first sync
        var targetPage = restored ? restored.page : 1;
        currentIdx = clampPage(targetPage) - 1;
        requestAnimationFrame(function () {
          scrollToPage(targetPage, false);
          sync();
        });
      });
    })
    .catch(function () {
      loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'block';
    });

  // ---- toolbar ----
  document.getElementById('pdf-zoom-in').onclick = function () { zoom(scale * 1.2); };
  document.getElementById('pdf-zoom-out').onclick = function () { zoom(scale / 1.2); };
  pageInput.onchange = function () {
    var v = parseInt(pageInput.value, 10);
    if (v > 0 && v <= numPages) scrollToPage(v, true);
    else pageInput.value = currentIdx + 1;
  };
  pageInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pageInput.blur(); pageInput.onchange(); } });

  document.addEventListener('keydown', function (e) {
    if (!pdfDoc) return;
    if (e.key === '+' || e.key === '=') { if (e.ctrlKey) { e.preventDefault(); zoom(scale * 1.2); } }
    if (e.key === '-') { if (e.ctrlKey) { e.preventDefault(); zoom(scale / 1.2); } }
    if (e.key === 'f' && e.ctrlKey) { e.preventDefault(); toggleSearch(); }
  });

  // Ctrl+wheel zoom
  viewport.addEventListener('wheel', function (e) {
    if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY > 0 ? scale / 1.1 : scale * 1.1); }
  }, { passive: false });

  // pinch zoom
  var pinchDist = 0;
  viewport.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchDist = Math.sqrt(dx * dx + dy * dy);
    }
  }, { passive: true });
  viewport.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var f = dist / pinchDist;
      if (f > 1.03 || f < 0.97) { zoom(scale * f); pinchDist = dist; }
    }
  }, { passive: false });

  // ---- search UI ----
  var searchVisible = false;
  function toggleSearch() {
    searchVisible = !searchVisible;
    searchBar.style.display = searchVisible ? 'flex' : 'none';
    if (searchVisible) { searchInput.focus(); searchInput.select(); }
  }
  document.getElementById('pdf-search-toggle').onclick = toggleSearch;
  document.getElementById('pdf-search-close').onclick = toggleSearch;

  var searchTimer = null;
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { clearHighlights(); buildSearchIndex(); }, 300);
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) document.getElementById('pdf-search-prev').click();
      else document.getElementById('pdf-search-next').click();
    }
  });
  document.getElementById('pdf-search-next').onclick = function () {
    if (!searchResults.length) return;
    navigateToSearch((searchIdx + 1) % searchResults.length);
  };
  document.getElementById('pdf-search-prev').onclick = function () {
    if (!searchResults.length) return;
    navigateToSearch((searchIdx - 1 + searchResults.length) % searchResults.length);
  };

  window.addEventListener('beforeunload', saveState);
  window.savePDFState = saveState;
})();
