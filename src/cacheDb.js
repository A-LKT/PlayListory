// Minimal IndexedDB helper for caching fetched data locally

const DB_NAME = 'playlistory';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

async function getRecord(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = tx(db, 'readonly').get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function putRecord(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = tx(db, 'readwrite').put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = tx(db, 'readwrite').clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Public API for playlists cache

const PLAYLISTS_KEY = 'playlistsWithTracks';

export async function savePlaylistsCache(playlists, user = null) {
  const record = {
    key: PLAYLISTS_KEY,
    data: playlists,
    user: user ? { id: user.id || null, display_name: user.display_name || null } : null,
    createdAt: Date.now(),
  };
  await putRecord(record);
  return { createdAt: record.createdAt };
}

export async function loadPlaylistsCache() {
  const record = await getRecord(PLAYLISTS_KEY);
  if (!record) return null;
  return {
    playlists: record.data,
    user: record.user || null,
    createdAt: record.createdAt,
  };
}

export async function purgeCache() {
  await clearAll();
}


