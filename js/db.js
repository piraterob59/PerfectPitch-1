// Local storage layer, built on IndexedDB. Same promise-wrapping pattern as
// TimeTracker-II's db.js: songs/stems/pitchTimelines/meta object stores,
// a lazily-opened single connection, and a shared Store singleton.

const DB_NAME = 'perfectpitch';
const DB_VERSION = 3; // bump this + add an onupgradeneeded branch if the schema ever changes

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) {
        const store = db.createObjectStore('songs', { keyPath: 'id' });
        store.createIndex('status', 'status');
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('stems')) {
        // id = `${songId}:${kind}` so a song's stems can't collide and are
        // trivially addressable without a compound key.
        const store = db.createObjectStore('stems', { keyPath: 'id' });
        store.createIndex('songId', 'songId');
      }
      if (!db.objectStoreNames.contains('pitchTimelines')) {
        // One row per song (keyPath IS the songId, no separate id needed).
        db.createObjectStore('pitchTimelines', { keyPath: 'songId' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('lyricCues')) {
        // User-entered { songId, timeSec, text } markers, since we can't
        // (and, for copyrighted lyrics, shouldn't) transcribe vocals
        // automatically — added by tapping "add cue" during playback.
        const store = db.createObjectStore('lyricCues', { keyPath: 'id' });
        store.createIndex('songId', 'songId');
      }
      if (!db.objectStoreNames.contains('attempts')) {
        // One row per "Start Singing" -> "Stop Singing" cycle: when it
        // happened, the accuracy score reached, and the full video+audio
        // recording (see js/recorder.js) as a Blob.
        const store = db.createObjectStore('attempts', { keyPath: 'id' });
        store.createIndex('songId', 'songId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t, result) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export function uuid() {
  return crypto.randomUUID();
}

class Store {
  constructor() {
    this._db = null;
  }

  async db() {
    if (!this._db) this._db = await openDB();
    return this._db;
  }

  async getAllSongs() {
    const db = await this.db();
    const t = tx(db, 'songs', 'readonly');
    return reqToPromise(t.objectStore('songs').getAll());
  }

  async getSong(id) {
    const db = await this.db();
    const t = tx(db, 'songs', 'readonly');
    return reqToPromise(t.objectStore('songs').get(id));
  }

  async putSong(song) {
    const db = await this.db();
    const t = tx(db, 'songs', 'readwrite');
    t.objectStore('songs').put(song);
    return txDone(t, song);
  }

  // Deletes a song and cascades to its stems + pitch timeline + lyric cues
  // + recorded attempts.
  async deleteSong(id) {
    const db = await this.db();
    const t = tx(db, ['songs', 'stems', 'pitchTimelines', 'lyricCues', 'attempts'], 'readwrite');
    t.objectStore('songs').delete(id);
    t.objectStore('pitchTimelines').delete(id);
    const range = IDBKeyRange.only(id);
    const cascadeBySongId = (storeName) => {
      const idx = t.objectStore(storeName).index('songId');
      idx.openCursor(range).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    };
    cascadeBySongId('stems');
    cascadeBySongId('lyricCues');
    cascadeBySongId('attempts');
    return txDone(t);
  }

  async putStem({ songId, kind, blob, mimeType }) {
    const db = await this.db();
    const t = tx(db, 'stems', 'readwrite');
    const entry = { id: `${songId}:${kind}`, songId, kind, blob, mimeType, createdAt: Date.now() };
    t.objectStore('stems').put(entry);
    return txDone(t, entry);
  }

  async getStem(songId, kind) {
    const db = await this.db();
    const t = tx(db, 'stems', 'readonly');
    return reqToPromise(t.objectStore('stems').get(`${songId}:${kind}`));
  }

  async getStemsForSong(songId) {
    const db = await this.db();
    const t = tx(db, 'stems', 'readonly');
    const idx = t.objectStore('stems').index('songId');
    return reqToPromise(idx.getAll(IDBKeyRange.only(songId)));
  }

  async putPitchTimeline(songId, points, hopSec) {
    const db = await this.db();
    const t = tx(db, 'pitchTimelines', 'readwrite');
    const entry = { songId, hopSec, points, createdAt: Date.now() };
    t.objectStore('pitchTimelines').put(entry);
    return txDone(t, entry);
  }

  async getPitchTimeline(songId) {
    const db = await this.db();
    const t = tx(db, 'pitchTimelines', 'readonly');
    return reqToPromise(t.objectStore('pitchTimelines').get(songId));
  }

  async getMeta(key) {
    const db = await this.db();
    const t = tx(db, 'meta', 'readonly');
    const row = await reqToPromise(t.objectStore('meta').get(key));
    return row ? row.value : undefined;
  }

  async setMeta(key, value) {
    const db = await this.db();
    const t = tx(db, 'meta', 'readwrite');
    t.objectStore('meta').put({ key, value });
    return txDone(t, value);
  }

  async deleteMeta(key) {
    const db = await this.db();
    const t = tx(db, 'meta', 'readwrite');
    t.objectStore('meta').delete(key);
    return txDone(t);
  }

  async addLyricCue({ songId, timeSec, text }) {
    const db = await this.db();
    const t = tx(db, 'lyricCues', 'readwrite');
    const entry = { id: uuid(), songId, timeSec, text, createdAt: Date.now() };
    t.objectStore('lyricCues').put(entry);
    return txDone(t, entry);
  }

  async getLyricCuesForSong(songId) {
    const db = await this.db();
    const t = tx(db, 'lyricCues', 'readonly');
    const idx = t.objectStore('lyricCues').index('songId');
    const cues = await reqToPromise(idx.getAll(IDBKeyRange.only(songId)));
    return cues.sort((a, b) => a.timeSec - b.timeSec);
  }

  async deleteLyricCue(id) {
    const db = await this.db();
    const t = tx(db, 'lyricCues', 'readwrite');
    t.objectStore('lyricCues').delete(id);
    return txDone(t);
  }

  async updateLyricCueText(id, text) {
    const db = await this.db();
    const t = tx(db, 'lyricCues', 'readwrite');
    const store = t.objectStore('lyricCues');
    const existing = await reqToPromise(store.get(id));
    if (existing) {
      existing.text = text;
      store.put(existing);
    }
    return txDone(t, existing);
  }

  async addAttempt({ songId, startedAt, durationSec, accuracyPct, videoBlob, mimeType }) {
    const db = await this.db();
    const t = tx(db, 'attempts', 'readwrite');
    const entry = { id: uuid(), songId, startedAt, durationSec, accuracyPct, videoBlob, mimeType, createdAt: Date.now() };
    t.objectStore('attempts').put(entry);
    return txDone(t, entry);
  }

  async getAttemptsForSong(songId) {
    const db = await this.db();
    const t = tx(db, 'attempts', 'readonly');
    const idx = t.objectStore('attempts').index('songId');
    const attempts = await reqToPromise(idx.getAll(IDBKeyRange.only(songId)));
    return attempts.sort((a, b) => b.startedAt - a.startedAt); // newest first
  }

  async deleteAttempt(id) {
    const db = await this.db();
    const t = tx(db, 'attempts', 'readwrite');
    t.objectStore('attempts').delete(id);
    return txDone(t);
  }
}

export const store = new Store();
