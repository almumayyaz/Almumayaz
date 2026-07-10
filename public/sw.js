importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDxUgfCxM3QReAWn-7nvS-WpPvdGVpBXZc',
  authDomain: 'mostafa-farghaly-1.firebaseapp.com',
  projectId: 'mostafa-farghaly-1',
  messagingSenderId: '67570982000',
  appId: '1:67570982000:web:8436cf227de225076328b5'
});

var CACHE = 'lughati-v1';
var urls = ['/', '/css/style.css', '/manifest.json'];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(urls); }));
});

self.addEventListener('fetch', function(e) {
  e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
});

var messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  var title = payload.notification?.title || payload.data?.title || 'المُميز';
  var body = payload.notification?.body || payload.data?.body || '';
  var icon = payload.notification?.icon || '/icon-192.png';
  var clickUrl = payload.data?.url || '/';
  self.registration.showNotification(title, {
    body: body,
    icon: icon,
    badge: '/icon-192.png',
    data: { url: clickUrl }
  });
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
