// Keeps synthesized sentences in IndexedDB, so a document read once plays at once the next time.
// Every call fails soft: without IndexedDB (for example in a private window) the reader only loses the cache.

export interface CachedAudio {
  pcm: Int16Array
  sampleRate: number
}

interface CacheRecord {
  key: string
  pcm: ArrayBuffer
  sampleRate: number
  bytes: number
  /** Last time the sentence was written or played, for pruning the oldest first. */
  at: number
}

const DB_NAME = 'hiyori-reader'
const STORE = 'audio'
/** About 50 minutes of 24 kHz speech. */
const MAX_BYTES = 300 * 1024 * 1024
const PRUNE_EVERY = 40

let dbPromise: Promise<IDBDatabase | null> | null = null
let writes = 0

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const open = indexedDB.open(DB_NAME, 1)
        open.onupgradeneeded = () => {
          const store = open.result.createObjectStore(STORE, { keyPath: 'key' })
          store.createIndex('at', 'at')
        }
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => resolve(null)
        open.onblocked = () => resolve(null)
      }
      catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

export async function cacheAvailable() {
  return (await openDb()) !== null
}

/** A stable key for one sentence in one voice. */
export async function cacheKey(voice: string, text: string) {
  const data = new TextEncoder().encode(`${voice}\u0000${text}`)
  return hex(await crypto.subtle.digest('SHA-256', data))
}

export async function hashBlob(blob: Blob) {
  return hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function readCached(key: string): Promise<CachedAudio | null> {
  const db = await openDb()
  if (!db)
    return null
  let record: CacheRecord | undefined
  try {
    record = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(key)) as CacheRecord | undefined
  }
  catch {
    return null
  }
  if (!record)
    return null
  try {
    // Marks the sentence as recently used, so pruning keeps it.
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ ...record, at: Date.now() })
  }
  catch {
    // Only the pruning order is affected.
  }
  return { pcm: new Int16Array(record.pcm), sampleRate: record.sampleRate }
}

/** Returns which of the keys are cached, without reading the audio. */
export async function whichCached(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  const db = await openDb()
  if (!db || !keys.length)
    return found
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    await Promise.all(keys.map(async (key) => {
      if (await request(store.getKey(key)) !== undefined)
        found.add(key)
    }))
  }
  catch {
    // Treated as not cached.
  }
  return found
}

export async function writeCached(key: string, audio: CachedAudio) {
  const db = await openDb()
  if (!db)
    return
  try {
    const pcm = audio.pcm.slice().buffer as ArrayBuffer
    const record: CacheRecord = { key, pcm, sampleRate: audio.sampleRate, bytes: pcm.byteLength, at: Date.now() }
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record))
    writes += 1
    if (writes % PRUNE_EVERY === 0)
      await prune(db)
  }
  catch {
    // A full disk only means this sentence is synthesized again next time.
  }
}

/** Deletes the least recently used sentences once the cache is over MAX_BYTES. */
async function prune(db: IDBDatabase) {
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
  const index = store.index('at')
  let total = 0
  await new Promise<void>((resolve, reject) => {
    // Newest first: everything after the budget is used up is deleted.
    const cursorRequest = index.openCursor(null, 'prev')
    cursorRequest.onerror = () => reject(cursorRequest.error)
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor)
        return resolve()
      total += (cursor.value as CacheRecord).bytes
      if (total > MAX_BYTES)
        cursor.delete()
      cursor.continue()
    }
  })
}
