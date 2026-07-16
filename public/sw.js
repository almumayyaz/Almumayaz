importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDxUgfCxM3QReAWn-7nvS-WpPvdGVpBXZc',
  authDomain: 'mostafa-farghaly-1.firebaseapp.com',
  projectId: 'mostafa-farghaly-1',
  storageBucket: 'mostafa-farghaly-1.firebasestorage.app',
  messagingSenderId: '67570982000',
  appId: '1:67570982000:web:8436cf227de225076328b5'
});

// NOTE: This service worker does NOT intercept or cache any network requests.
// The browser handles all asset loads normally (respecting the server's
// no-cache headers), so resources are always fresh and are never blocked
// by a stale service worker — including on mobile. Its only job is to
// receive Firebase Cloud Messaging push notifications in the background.
var CACHE = 'lughati-v7';

// Note: skipWaiting intentionally omitted to prevent Chrome's
// "This site has been updated in the background" notification.
// SW will activate on next page load instead.
self.addEventListener('install', function(e) {
  // SW installed — will activate after all pages using old SW are closed
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }).then(function() { return clients.claim(); })
  );
});

firebase.messaging().onBackgroundMessage(function(payload) {
  var title = payload.data?.title || payload.notification?.title || 'المُميز';
  var body = payload.data?.body || payload.notification?.body || '';
  var icon = payload.notification?.icon || '/icon.png';
  var clickUrl = payload.data?.url || '/';
  self.registration.showNotification(title, {
    body: body,
    icon: icon,
    badge: '/icon.png',
    data: { url: clickUrl },
    vibrate: [200, 100, 200],
    requireInteraction: true,
    tag: 'lughati-notif'
  });
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf(url) !== -1 && 'focus' in clientList[i]) return clientList[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Show a real OS notification while the page is open in the foreground
self.addEventListener('message', function(event) {
  var data = event.data || {};
  if (data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(data.title || 'المُميز', {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url || '/' },
      tag: 'lughati-notif',
      requireInteraction: false
    });
  }
});
