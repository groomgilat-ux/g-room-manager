importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');
firebase.initializeApp({ apiKey: "AIzaSyBvayS247KEOVqZloFrNWV3svg4DSiNG08", authDomain: "g-room-escape-room-management.firebaseapp.com", projectId: "g-room-escape-room-management", storageBucket: "g-room-escape-room-management.firebasestorage.app", messagingSenderId: "361117379721", appId: "1:361117379721:web:3019eaeb30f4fe188caa58" });
firebase.messaging();
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});
