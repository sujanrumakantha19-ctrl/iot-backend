const cache = new Map()

module.exports = {
  get(key) {
    const entry = cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      cache.delete(key)
      return null
    }
    return entry.value
  },
  set(key, value, ttlMs = 300000) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs })
  },
  invalidate(pattern) {
    for (const key of cache.keys()) {
      if (key.startsWith(pattern)) cache.delete(key)
    }
  },
  flush() {
    cache.clear()
  },
  clear() {
    cache.clear()
  }
}
