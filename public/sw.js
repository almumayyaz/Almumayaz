var CACHE = 'lughati-v7';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }).then(function() { return clients.claim(); })
  );
});

self.addEventListener('push', function(event) {
  var title = 'المُميز', body = '', clickUrl = '/';
  try {
    if (event.data) {
      var raw = event.data.json();
      if (raw.notification) { title = raw.notification.title || 'المُميز'; body = raw.notification.body || ''; }
      var d = raw.data || {};
      clickUrl = d.url || '/';
      if (!raw.notification) { title = d.title || title; body = d.body || body; }
    }
  } catch (e) { console.error('SW push parse error:', e); }
  event.waitUntil(
    (async () => {
      try { await self.registration.showNotification(title, { body: body, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: clickUrl }, tag: 'lughati-notif', requireInteraction: true }); }
      catch (e) { console.error('showNotification error:', e); }
    })()
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf(url) !== -1 && 'focus' in clientList[i]) return clientList[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('message', function(event) {
  var data = event.data || {};
  if (data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(data.title || 'المُميز', {
      body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
      data: { url: data.url || '/' }, tag: 'lughati-notif', requireInteraction: false
    });
  }
});
