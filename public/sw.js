const CACHE = 'tam-workhub-v6'
const APP_SHELL = ['./', './manifest.webmanifest', './tam-logo.jpg']
const NAVIGATION_TIMEOUT_MS = 4000

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(request, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function offlineShell() {
  return new Response(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#13140c"><title>Т.А.М.</title><body style="margin:0;background:#13140c;color:#f6f6f3;font:18px Arial,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center"><main><b style="font-size:32px">Т·А·М</b><p>Нет соединения с интернетом.</p><button onclick="location.reload()" style="font:inherit;padding:10px 16px">Повторить</button></main></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE).then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))),
      self.skipWaiting(),
    ]),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
      self.clients.claim(),
    ]),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== self.location.origin) return

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      try {
        const response = await fetchWithTimeout(event.request, NAVIGATION_TIMEOUT_MS)
        if (response.ok) await cache.put('./', response.clone())
        return response
      } catch {
        return await cache.match(event.request, { ignoreSearch: true }) || await cache.match('./') || offlineShell()
      }
    })())
    return
  }

  // Stream media normally instead of adding it to the app-shell cache.
  if (event.request.destination === 'video' || event.request.destination === 'audio') return
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request)
        if (response.ok) {
          const cache = await caches.open(CACHE)
          await cache.put(event.request, response.clone())
        }
        return response
      } catch {
        return await caches.match(event.request) || Response.error()
      }
    })(),
  )
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'Т.А.М.', body: event.data?.text() || 'Новое уведомление' }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Т.А.М.', {
      body: payload.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: payload.tag || 'tam-workhub',
      data: { url: payload.url || './' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || './', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((client) => client.url.startsWith(self.location.origin))
      if (existing) {
        await existing.navigate(targetUrl)
        return existing.focus()
      }
      return self.clients.openWindow(targetUrl)
    }),
  )
})
