(function () {
  var panel, bar, barFill, steps = [], progTimer = null;
  function build() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'pdfUploadPanel';
    panel.style.cssText = 'position:fixed;inset:0;background:rgba(8,11,24,0.55);z-index:999999;display:none;align-items:center;justify-content:center;';
    panel.innerHTML =
      '<div style="background:var(--card,#fff);color:var(--text,#111);min-width:300px;max-width:92vw;width:380px;border-radius:16px;padding:22px 24px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
          '<i class="fas fa-file-pdf" style="color:#ef4444;font-size:20px;"></i>' +
          '<strong style="font-size:15px;">رفع ملف PDF</strong>' +
        '</div>' +
        '<div id="upStep1" class="up-step"><i class="up-ic fas fa-circle"></i><span>اختيار الملف</span></div>' +
        '<div id="upStep2" class="up-step"><i class="up-ic fas fa-circle"></i><span>رفع الملف إلى التخزين الآمن</span></div>' +
        '<div id="upBar" style="height:7px;border-radius:6px;background:var(--bg,#eee);overflow:hidden;margin:6px 0 14px 26px;display:none;"><div id="upBarFill" style="height:100%;width:0%;background:linear-gradient(90deg,#059669,#34d399);transition:width .15s;"></div></div>' +
        '<div id="upStep3" class="up-step"><i class="up-ic fas fa-circle"></i><span>حفظ البيانات</span></div>' +
        '<div id="upError" style="display:none;margin-top:12px;font-size:13px;color:#dc2626;background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);border-radius:10px;padding:10px 12px;"></div>' +
      '</div>';
    document.body.appendChild(panel);
    var style = document.createElement('style');
    style.textContent = '.up-step{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--text-muted,#888);margin:7px 0;transition:color .2s;}.up-step.active{color:var(--accent,#059669);font-weight:700;}.up-step.done{color:#059669;}.up-ic{width:18px;text-align:center;font-size:9px;color:#cbd5e1;}.up-step.active .up-ic,.up-step.done .up-ic{color:#059669;font-size:13px;}';
    document.head.appendChild(style);
    bar = document.getElementById('upBar');
    barFill = document.getElementById('upBarFill');
    steps = [document.getElementById('upStep1'), document.getElementById('upStep2'), document.getElementById('upStep3')];
  }
  function setStep(idx, state) {
    var el = steps[idx];
    if (!el) return;
    el.className = 'up-step' + (state ? ' ' + state : '');
    var ic = el.querySelector('.up-ic');
    if (state === 'done') ic.className = 'up-ic fas fa-check-circle';
    else if (state === 'active') ic.className = 'up-ic fas fa-spinner fa-spin';
    else ic.className = 'up-ic fas fa-circle';
  }
  function reset() {
    build();
    setStep(0, 'done');
    setStep(1, '');
    setStep(2, '');
    bar.style.display = 'none';
    barFill.style.width = '0%';
    document.getElementById('upError').style.display = 'none';
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    panel.style.display = 'flex';
  }
  function hide() { if (panel) panel.style.display = 'none'; }
  function showError(msg) {
    var err = document.getElementById('upError');
    err.textContent = msg;
    err.style.display = 'block';
  }
  function startFakeProgress() {
    bar.style.display = 'block';
    barFill.style.width = '8%';
    progTimer = setInterval(function () {
      var cur = parseFloat(barFill.style.width) || 8;
      if (cur < 90) barFill.style.width = (cur + (90 - cur) * 0.18) + '%';
    }, 250);
  }
  function stopFakeProgress() {
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    barFill.style.width = '100%';
  }

  function loadSupabase() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve(window.supabase);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = function () { resolve(window.supabase); };
      s.onerror = function () { reject(new Error('تعذر تحميل مكتبة الرفع')); };
      document.head.appendChild(s);
    });
  }

  function legacyUpload(file, folder) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('file', file);
      fd.append('folder', folder);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/upload-pdf-legacy');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          var pct = Math.round((e.loaded / e.total) * 100);
          bar.style.display = 'block';
          barFill.style.width = pct + '%';
        }
      };
      xhr.onload = function () {
        var d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && d && d.success) { stopFakeProgress(); resolve(d.path); }
        else { setStep(1, ''); showError((d && d.error) || ('فشل الرفع (HTTP ' + xhr.status + ')')); reject(new Error('fail')); }
      };
      xhr.onerror = function () { setStep(1, ''); showError('خطأ في الاتصال أثناء الرفع'); reject(new Error('network')); };
      setStep(1, 'active');
      xhr.send(fd);
    });
  }

  // Direct browser -> Supabase upload (bypasses Vercel body limit).
  function directUpload(file, folder) {
    return new Promise(async function (resolve, reject) {
      try {
        setStep(1, 'active');
        startFakeProgress();
        // 1) ask server for a short-lived signed upload url
        var signRes = await fetch('/api/admin/upload-pdf/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folder, fileName: file.name })
        });
        var sign = await signRes.json().catch(function () { return {}; });
        if (!signRes.ok || !sign.path || !sign.token) {
          throw new Error(sign.error || ('فشل تجهيز الرفع (HTTP ' + signRes.status + ')'));
        }
        // 2) load supabase-js and upload the file straight to the bucket
        var SB = await loadSupabase();
        var client = SB.createClient(window.__SB_URL, window.__SB_ANON);
        var up = await client.storage.from('books').uploadToSignedUrl(
          sign.path, sign.token, file, { contentType: 'application/pdf', cacheControl: '0', upsert: true }
        );
        if (up.error) throw new Error(up.error.message || 'فشل رفع الملف إلى التخزين');
        // 3) confirm with server (verifies object exists)
        var cRes = await fetch('/api/admin/upload-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sign.path, fileName: file.name, fileSize: file.size })
        });
        var c = await cRes.json().catch(function () { return {}; });
        if (!cRes.ok || !c.success) throw new Error(c.error || ('فشل تأكيد الرفع (HTTP ' + cRes.status + ')'));
        stopFakeProgress();
        resolve(c.path);
      } catch (err) {
        stopFakeProgress();
        setStep(1, '');
        showError(err.message || 'فشل رفع الملف');
        reject(err);
      }
    });
  }

  window.uploadPdfFile = function (file, folder) {
    reset();
    if (window.__SB_URL && window.__SB_ANON) return directUpload(file, folder);
    return legacyUpload(file, folder);
  };
  window.uploadStepSave = function () { setStep(1, 'done'); setStep(2, 'active'); };
  window.uploadDone = function () {
    setStep(2, 'done');
    setTimeout(hide, 650);
  };
  window.uploadError = function (msg) {
    setStep(2, '');
    showError(msg || 'حدث خطأ');
  };
})();
