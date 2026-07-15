(function () {
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === 's' || e.key === 'p' || e.key === 'u' || e.key === 'P')) e.preventDefault();
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) e.preventDefault();
  });

  var cfg = window.__PDF_CONFIG__ || {};
  if (!cfg.tokenUrl) return;

  var pdfDoc = null, scale = 1, pages = [], numPages = 0;
  var viewport = document.getElementById('pdf-viewport');
  var spacer = document.getElementById('pdf-spacer');
  var loadingEl = document.getElementById('pdf-loading');
  var errorEl = document.getElementById('pdf-error');
  var statusEl = document.getElementById('pdf-status');
  var pageInput = document.getElementById('pdf-page-input');
  var pageTotal = document.getElementById('pdf-page-total');
  var zoomLabel = document.getElementById('pdf-zoom-label');
  var searchBar = document.getElementById('pdf-search-bar');
  var searchInput = document.getElementById('pdf-search-input');
  var searchCount = document.getElementById('pdf-search-count');

  var pageHeight = 0, pageWidth = 0, spacerHeight = 0;
  var renderedPages = {};
  var pageCache = new Map();
  var searchResults = [];
  var searchIdx = -1;
  var rafPending = false;
  var stateKey = 'pdf_state_' + btoa(cfg.tokenUrl).slice(0, 32);
  var BUFFER = 2;
  var MAX_CACHE = 5;
  var BASE_WIDTH = 800;

  function saveState() {
    try {
      var data = { page: getCurrentPage(), scale: scale };
      localStorage.setItem(stateKey, JSON.stringify(data));
    } catch(e) {}
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(stateKey);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }

  function getCurrentPage() {
    if (!viewport || !spacerHeight || !numPages) return 1;
    var scrollTop = viewport.scrollTop;
    var idx = Math.round(scrollTop / (spacerHeight / numPages));
    return Math.max(1, Math.min(numPages, idx + 1));
  }

  function scrollToPage(num, smooth) {
    if (!spacerHeight || !numPages) return;
    num = Math.max(1, Math.min(numPages, num));
    var target = ((num - 1) / numPages) * spacerHeight;
    viewport.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateUI() {
    var cur = getCurrentPage();
    pageInput.value = cur;
    if (pageTotal) pageTotal.textContent = numPages;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    if (statusEl) statusEl.textContent = '\u0635\u0641\u062D\u0629 ' + cur + ' \u0645\u0646 ' + numPages;
  }

  function getPageHeight() {
    return Math.round(BASE_WIDTH * scale * Math.SQRT1_2);
  }

  function computeLayout() {
    if (!numPages) return;
    pageHeight = getPageHeight();
    pageWidth = Math.round(pageHeight * 0.707);
    spacerHeight = numPages * (pageHeight + 6);
    spacer.style.height = spacerHeight + 'px';
    spacer.style.width = pageWidth + 'px';
  }

  function releasePage(idx) {
    var entry = renderedPages[idx];
    if (!entry) return;
    var cvs = entry.canvas;
    if (cvs && cvs.parentNode) cvs.parentNode.removeChild(cvs);
    if (entry.textLayer && entry.textLayer.parentNode) entry.textLayer.parentNode.removeChild(entry.textLayer);
    delete renderedPages[idx];
    pageCache.delete(idx);
  }

  function renderPage(idx) {
    if (!pdfDoc || idx < 0 || idx >= numPages) return;
    if (renderedPages[idx]) return;

    var pg = pages[idx];
    if (!pg) {
      pdfDoc.getPage(idx + 1).then(function(p) {
        pages[idx] = p;
        requestRender(idx);
      });
      return;
    }

    var vp = pg.getViewport({ scale: scale * (BASE_WIDTH / pg.getViewport({ scale: 1 }).width) });
    var actualScale = vp.scale;

    var cvs = document.createElement('canvas');
    cvs.className = 'pdf-page-canvas';
    cvs.width = vp.width;
    cvs.height = vp.height;
    cvs.style.width = pageWidth + 'px';
    cvs.style.height = pageHeight + 'px';
    cvs.dataset.page = idx;

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;top:' + (idx * (pageHeight + 6)) + 'px;left:50%;transform:translateX(-50%);width:' + pageWidth + 'px;';
    wrapper.appendChild(cvs);

    var tl = document.createElement('div');
    tl.className = 'pdf-text-layer';
    wrapper.appendChild(tl);

    spacer.appendChild(wrapper);

    var task = pg.render({ canvasContext: cvs.getContext('2d'), viewport: vp });
    var entry = { canvas: cvs, textLayer: tl, wrapper: wrapper, task: task, page: pg, viewport: vp };
    renderedPages[idx] = entry;
    pageCache.set(idx, entry);

    if (pageCache.size > MAX_CACHE) {
      var oldest = pageCache.keys().next().value;
      if (oldest !== idx) releasePage(oldest);
    }

    task.promise.then(function() {
      if (!renderedPages[idx]) return;
      var div = document.createElement('div');
      pdfjsLib.renderTextLayer({ textContentSource: pg.streamTextContent(), container: tl, viewport: vp });
    });

    if (!searchInput || !searchInput.value) return;
    applySearchHighlights(idx);
  }

  function requestRender(idx) {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(function() {
        rafPending = false;
        syncViewport();
      });
    }
  }

  function syncViewport() {
    if (!numPages || !viewport) return;
    var scrollTop = viewport.scrollTop;
    var viewH = viewport.clientHeight;
    var firstIdx = Math.max(0, Math.floor(scrollTop / (pageHeight + 6)) - BUFFER);
    var lastIdx = Math.min(numPages - 1, Math.ceil((scrollTop + viewH) / (pageHeight + 6)) + BUFFER);

    var needed = {};
    for (var i = firstIdx; i <= lastIdx; i++) needed[i] = true;

    Object.keys(renderedPages).forEach(function(k) {
      k = parseInt(k);
      if (!needed[k]) releasePage(k);
    });

    for (var j = firstIdx; j <= lastIdx; j++) {
      if (!renderedPages[j]) renderPage(j);
    }

    updateUI();
  }

  function handleScroll() {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(function() {
        rafPending = false;
        syncViewport();
      });
    }
  }

  function debouncedSave() {
    clearTimeout(debouncedSave._timer);
    debouncedSave._timer = setTimeout(saveState, 800);
  }

  function zoom(newScale) {
    scale = Math.min(3, Math.max(0.3, newScale));
    computeLayout();
    Object.keys(renderedPages).forEach(releasePage);
    if (pageCache) pageCache.clear();
    syncViewport();
    updateUI();
    debouncedSave();
  }

  function applySearchHighlights(idx) {
    var entry = renderedPages[idx];
    if (!entry || !entry.textLayer || !searchInput || !searchInput.value) return;
    var q = searchInput.value.toLowerCase().trim();
    if (!q) return;
    var divs = entry.textLayer.querySelectorAll('span');
    divs.forEach(function(s) {
      var txt = s.textContent.toLowerCase();
      var html = '';
      var ci = 0;
      while (ci < txt.length) {
        var fi = txt.indexOf(q, ci);
        if (fi === -1) { html += escapeHtml(txt.slice(ci)); break; }
        html += escapeHtml(txt.slice(ci, fi));
        var matchIdx = searchResults.findIndex(function(r) { return r.page === idx && r.start === fi && r.text === s.textContent.slice(fi, fi + q.length); });
        var cls = 'highlight';
        if (matchIdx === searchIdx) cls += ' active';
        html += '<span class="' + cls + '">' + escapeHtml(txt.slice(fi, fi + q.length)) + '</span>';
        ci = fi + q.length;
      }
      s.innerHTML = html;
    });
  }

  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function buildSearchIndex() {
    searchResults = [];
    searchIdx = -1;
    var q = searchInput.value.toLowerCase().trim();
    if (!q || !pdfDoc) { clearHighlights(); updateSearchCount(); return; }

    var promises = [];
    for (var i = 1; i <= numPages; i++) {
      (function(pageIdx) {
        promises.push(pdfDoc.getPage(pageIdx + 1).then(function(p) {
          return p.getTextContent();
        }).then(function(tc) {
          var items = tc.items;
          items.forEach(function(item) {
          var txt = item.str;
          var ltxt = txt.toLowerCase();
          var ci = 0;
          while (true) {
            var fi = ltxt.indexOf(q, ci);
            if (fi === -1) break;
            searchResults.push({ page: pageIdx, start: fi, text: txt.slice(fi, fi + q.length) });
            ci = fi + 1;
          }
        });
      }));
    })(i - 1);
    }

    Promise.all(promises).then(function() {
      searchIdx = searchResults.length > 0 ? 0 : -1;
      updateSearchCount();
      Object.keys(renderedPages).forEach(function(k) { applySearchHighlights(parseInt(k)); });
      if (searchResults.length > 0) navigateToSearch(0);
    });
  }

  function navigateToSearch(idx) {
    if (idx < 0 || idx >= searchResults.length) return;
    searchIdx = idx;
    var r = searchResults[idx];
    scrollToPage(r.page + 1, true);
    updateSearchCount();
    Object.keys(renderedPages).forEach(function(k) { applySearchHighlights(parseInt(k)); });
  }

  function updateSearchCount() {
    if (searchCount) searchCount.textContent = searchResults.length > 0 ? (searchIdx + 1) + '/' + searchResults.length : '';
  }

  function clearHighlights() {
    Object.keys(renderedPages).forEach(function(k) {
      var entry = renderedPages[k];
      if (!entry || !entry.textLayer) return;
      var spans = entry.textLayer.querySelectorAll('span');
      spans.forEach(function(s) { s.innerHTML = escapeHtml(s.textContent); });
    });
  }

  fetch(cfg.tokenUrl, { credentials: 'same-origin' })
    .then(function(r) {
      if (!r.ok) throw new Error('auth');
      return r.json();
    })
    .then(function(d) {
      if (!d || !d.url) throw new Error('no-url');
      return pdfjsLib.getDocument({ url: d.url, disableAutoFetch: true, disableStream: false }).promise;
    })
    .then(function(pdf) {
      pdfDoc = pdf;
      numPages = pdf.numPages;
      pages = new Array(numPages);
      var restored = loadState();
      if (restored && restored.scale) scale = restored.scale;
      computeLayout();
      loadingEl.style.display = 'none';

      viewport.addEventListener('scroll', handleScroll, { passive: true });
      window.addEventListener('resize', function() { requestAnimationFrame(syncViewport); });

      syncViewport();

      var targetPage = restored ? restored.page : 1;
      setTimeout(function() { scrollToPage(targetPage, false); }, 50);
      setTimeout(saveState, 100);

      progressiveLoad();
    })
    .catch(function(err) {
      loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'block';
    });

  function progressiveLoad() {
    if (!pdfDoc) return;
    var loaded = 0;
    function loadNext() {
      if (loaded >= numPages) return;
      var idx = loaded;
      if (idx < numPages && !pages[idx]) {
        pdfDoc.getPage(idx + 1).then(function(p) {
          pages[idx] = p;
          loaded++;
          if (renderedPages[idx]) renderPage(idx);
          if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(loadNext, { timeout: 2000 });
          } else {
            setTimeout(loadNext, 100);
          }
        });
      } else {
        loaded++;
        loadNext();
      }
    }
    loadNext();
  }

  document.getElementById('pdf-prev').onclick = function() { scrollToPage(getCurrentPage() - 1, true); };
  document.getElementById('pdf-next').onclick = function() { scrollToPage(getCurrentPage() + 1, true); };
  document.getElementById('pdf-zoom-in').onclick = function() { zoom(scale * 1.2); };
  document.getElementById('pdf-zoom-out').onclick = function() { zoom(scale / 1.2); };
  pageInput.onchange = function() { var v = parseInt(pageInput.value); if (v > 0 && v <= numPages) scrollToPage(v, true); };

  document.addEventListener('keydown', function(e) {
    if (!pdfDoc) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); scrollToPage(getCurrentPage() - 1, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); scrollToPage(getCurrentPage() + 1, true); }
    if (e.key === '+' || e.key === '=') { if (e.ctrlKey) { e.preventDefault(); zoom(scale * 1.2); } }
    if (e.key === '-') { if (e.ctrlKey) { e.preventDefault(); zoom(scale / 1.2); } }
    if (e.key === 'f' && e.ctrlKey) { e.preventDefault(); toggleSearch(); }
  });

  viewport.addEventListener('wheel', function(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      zoom(e.deltaY > 0 ? scale / 1.1 : scale * 1.1);
    }
  }, { passive: false });

  var pinchDist = 0;
  viewport.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchDist = Math.sqrt(dx * dx + dy * dy);
    }
  }, { passive: true });
  viewport.addEventListener('touchmove', function(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var f = dist / pinchDist;
      if (f > 1.02 || f < 0.98) {
        zoom(scale * f);
        pinchDist = dist;
      }
    }
  }, { passive: false });

  var searchVisible = false;
  function toggleSearch() {
    searchVisible = !searchVisible;
    searchBar.style.display = searchVisible ? 'flex' : 'none';
    if (searchVisible) { searchInput.focus(); searchInput.select(); }
  }
  document.getElementById('pdf-search-toggle').onclick = toggleSearch;
  document.getElementById('pdf-search-close').onclick = toggleSearch;

  var searchTimer = null;
  searchInput.addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() {
      clearHighlights();
      buildSearchIndex();
    }, 300);
  });
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) { document.getElementById('pdf-search-prev').click(); }
      else { document.getElementById('pdf-search-next').click(); }
    }
  });
  document.getElementById('pdf-search-next').onclick = function() {
    if (searchResults.length === 0) return;
    navigateToSearch((searchIdx + 1) % searchResults.length);
  };
  document.getElementById('pdf-search-prev').onclick = function() {
    if (searchResults.length === 0) return;
    navigateToSearch((searchIdx - 1 + searchResults.length) % searchResults.length);
  };

  viewport.addEventListener('scroll', function() {
    clearTimeout(handleScroll._saveTimer);
    handleScroll._saveTimer = setTimeout(saveState, 1000);
  });

  window.savePDFState = saveState;
})();
