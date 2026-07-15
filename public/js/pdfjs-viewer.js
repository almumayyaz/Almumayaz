(function () {
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === 's' || e.key === 'p' || e.key === 'u' || e.key === 'P')) e.preventDefault();
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) e.preventDefault();
  });

  var tokenUrl = window.__PDF_TOKEN_URL__;
  var pdfDoc = null, pageNum = 1, scale = 1.2;
  var isTransitioning = false;

  var canvasA = document.getElementById('pdf-canvas');
  var canvasB = document.getElementById('pdf-canvas-b');
  if (!canvasA || !canvasB) return;
  var ctxA = canvasA.getContext('2d');
  var ctxB = canvasB.getContext('2d');
  var activeCanvas = canvasA, activeCtx = ctxA;
  var inactiveCanvas = canvasB, inactiveCtx = ctxB;
  var pageNumEl = document.getElementById('pdf-page-num');
  var pageCountEl = document.getElementById('pdf-page-count');
  var pageIndicatorEl = document.getElementById('pdf-page-indicator');
  var zoomLevelEl = document.getElementById('pdf-zoom-level');
  var errorEl = document.getElementById('pdf-error');
  var scrollEl = document.getElementById('pdf-scroll');

  // Common transition duration
  var T = 250;

  function setPageSize(cvs, ctx, viewport) {
    cvs.height = viewport.height;
    cvs.width = viewport.width;
  }

  function renderOn(cvs, ctx, num) {
    if (!pdfDoc) return;
    var n = Math.min(Math.max(1, num || 1), pdfDoc.numPages);
    return pdfDoc.getPage(n).then(function (page) {
      var viewport = page.getViewport({ scale: scale });
      setPageSize(cvs, ctx, viewport);
      return page.render({ canvasContext: ctx, viewport: viewport }).promise;
    });
  }

  function updateUI() {
    pageNumEl.value = pageNum;
    if (pageCountEl) pageCountEl.textContent = pdfDoc.numPages;
    if (pageIndicatorEl) pageIndicatorEl.textContent = 'الصفحة ' + pageNum + ' من ' + pdfDoc.numPages;
    if (zoomLevelEl) zoomLevelEl.textContent = Math.round(scale * 100) + '%';
  }

  function zoom(factor) {
    if (!pdfDoc || isTransitioning) return;
    scale = Math.min(3, Math.max(0.5, scale * factor));
    renderOn(activeCanvas, activeCtx, pageNum).then(updateUI);
  }

  function goToPage(num) {
    if (!pdfDoc || isTransitioning) return;
    num = Math.min(Math.max(1, num || 1), pdfDoc.numPages);
    if (num === pageNum) return;
    var dir = num > pageNum ? 1 : -1;
    pageNum = num;

    // Render on inactive canvas
    renderOn(inactiveCanvas, inactiveCtx, pageNum).then(function () {
      isTransitioning = true;
      // Position incoming page off-screen
      inactiveCanvas.style.transition = 'none';
      inactiveCanvas.style.transform = 'translateX(' + (dir * 100) + 'px)';
      inactiveCanvas.style.opacity = '0';
      inactiveCanvas.style.pointerEvents = 'none';

      // Force layout
      void inactiveCanvas.offsetHeight;

      // Animate
      activeCanvas.style.transition = 'transform ' + T + 'ms ease, opacity ' + T + 'ms ease';
      inactiveCanvas.style.transition = 'transform ' + T + 'ms ease, opacity ' + T + 'ms ease';

      activeCanvas.style.transform = 'translateX(' + (-dir * 100) + 'px)';
      activeCanvas.style.opacity = '0';
      inactiveCanvas.style.transform = 'translateX(0)';
      inactiveCanvas.style.opacity = '1';

      setTimeout(function () {
        // Reset active canvas styles
        activeCanvas.style.transition = 'none';
        activeCanvas.style.transform = '';
        activeCanvas.style.opacity = '0';
        activeCanvas.style.pointerEvents = 'none';

        inactiveCanvas.style.transition = 'none';
        inactiveCanvas.style.transform = '';
        inactiveCanvas.style.opacity = '1';
        inactiveCanvas.style.pointerEvents = '';

        // Swap active/inactive
        var tmp = activeCanvas; activeCanvas = inactiveCanvas; inactiveCanvas = tmp;
        var tmpCtx = activeCtx; activeCtx = inactiveCtx; inactiveCtx = tmpCtx;

        updateUI();
        isTransitioning = false;
      }, T);
    }).catch(function () { isTransitioning = false; if (errorEl) errorEl.style.display = 'block'; });
  }

  function nextPage() { goToPage(pageNum + 1); }
  function prevPage() { goToPage(pageNum - 1); }

  var prev = document.getElementById('pdf-prev');
  var next = document.getElementById('pdf-next');
  var zin = document.getElementById('pdf-zoom-in');
  var zout = document.getElementById('pdf-zoom-out');
  if (prev) prev.onclick = prevPage;
  if (next) next.onclick = nextPage;
  if (zin) zin.onclick = function () { zoom(1.2); };
  if (zout) zout.onclick = function () { zoom(1 / 1.2); };
  if (pageNumEl) pageNumEl.onchange = function () { goToPage(parseInt(pageNumEl.value, 10)); };

  // Keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    if (!pdfDoc || isTransitioning) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); prevPage(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); nextPage(); }
    if (e.key === '+' || e.key === '=') { if (e.ctrlKey) { e.preventDefault(); zoom(1.2); } }
    if (e.key === '-') { if (e.ctrlKey) { e.preventDefault(); zoom(1 / 1.2); } }
  });

  // Touch gestures
  if (scrollEl) {
    var ts = { startDist: 0, startY: 0, count: 0, pinching: false };
    scrollEl.addEventListener('touchstart', function (e) {
      if (isTransitioning) return;
      ts.count = e.touches.length;
      if (ts.count === 2) {
        ts.pinching = true;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        ts.startDist = Math.sqrt(dx * dx + dy * dy);
      } else if (ts.count === 1) {
        ts.pinching = false;
        ts.startY = e.touches[0].clientY;
      }
    }, { passive: true });
    scrollEl.addEventListener('touchmove', function (e) {
      if (ts.count === 2 && e.touches.length === 2) {
        e.preventDefault();
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var f = dist / ts.startDist;
        if (f > 1.03 || f < 0.97) {
          scale = Math.min(3, Math.max(0.5, scale * f));
          ts.startDist = dist;
          renderOn(activeCanvas, activeCtx, pageNum).then(updateUI);
        }
      }
    }, { passive: false });
    scrollEl.addEventListener('touchend', function (e) {
      if (!ts.pinching && ts.count === 1 && e.changedTouches.length === 1) {
        var dy = e.changedTouches[0].clientY - ts.startY;
        if (Math.abs(dy) > 50) dy < 0 ? nextPage() : prevPage();
      }
      ts.count = 0; ts.pinching = false;
    }, { passive: true });
    scrollEl.addEventListener('wheel', function (e) {
      if (isTransitioning) return;
      e.preventDefault();
      if (e.ctrlKey) {
        zoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
      } else {
        if (Math.abs(e.deltaY) > 40) e.deltaY > 0 ? nextPage() : prevPage();
      }
    }, { passive: false });
  }

  // Initial load
  fetch(tokenUrl, { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('auth'); return r.json(); })
    .then(function (d) {
      if (!d || !d.url) throw new Error('no-url');
      return pdfjsLib.getDocument(d.url).promise;
    })
    .then(function (pdf) {
      pdfDoc = pdf;
      // Hide inactive canvas initially
      inactiveCanvas.style.opacity = '0';
      inactiveCanvas.style.pointerEvents = 'none';
      activeCanvas.style.opacity = '1';
      activeCanvas.style.pointerEvents = '';
      return renderOn(activeCanvas, activeCtx, 1);
    })
    .then(updateUI)
    .catch(function () { if (errorEl) errorEl.style.display = 'block'; });
})();
