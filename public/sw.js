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

var CACHE = 'lughati-v2';
var urls = ['/', '/css/style.css', '/manifest.json'];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(urls); }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', function(e) {
  e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
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
