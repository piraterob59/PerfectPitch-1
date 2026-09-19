// Whole-library backup/restore: dumps every IndexedDB store into a single
// downloadable JSON file, and restores from one. Exists because everything
// this app stores — song list, separated stems, pitch timelines, recorded
// attempts, sections — lives only in this browser's IndexedDB with no
// server or sync, so clearing site data (or switching devices) otherwise
// means losing the whole library with no way back.
//
// Blobs (stem audio, attempt recordings) are inlined as base64 rather than
// packaged as a real zip — there's no bundler/zip library in this
// no-build-step project, and a single self-contained JSON file is simpler
// to save/attach/restore from than a multi-file archive. The tradeoff is
// file size (base64 inflates binary data by ~33%), acceptable for an
// occasional manual backup of a personal library.

import { store } from './db.js';

const BACKUP_APP_ID = 'perfectpitch';
const BACKUP_FORMAT_VERSION = 1;
// Which field holds a Blob in each store, if any — everything else in a
// row is already plain-JSON-serializable as stored.
const BLOB_FIELDS = { stems: 'blob', attempts: 'videoBlob' };

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // btoa needs a plain string. Spreading a large Uint8Array through
  // String.fromCharCode(...bytes) in one call can blow the call stack on a
  // multi-MB video attempt, so this builds the string up in chunks instead.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// Builds the backup object in memory (stores + base64 blobs). Split out
// from downloadBackup so a future "share/upload backup" path could reuse
// it without going through a file download.
export async function exportBackup({ onProgress } = {}) {
  const raw = await store.exportRaw();
  const storeNames = Object.keys(raw);
  const stores = {};
  for (let i = 0; i < storeNames.length; i++) {
    const name = storeNames[i];
    const blobField = BLOB_FIELDS[name];
    if (blobField) {
      stores[name] = await Promise.all(raw[name].map(async (row) => {
        const { [blobField]: blob, ...rest } = row;
        return { ...rest, [blobField]: blob ? await blobToBase64(blob) : null };
      }));
    } else {
      stores[name] = raw[name];
    }
    if (onProgress) onProgress(((i + 1) / storeNames.length) * 100);
  }
  return { app: BACKUP_APP_ID, backupVersion: BACKUP_FORMAT_VERSION, exportedAt: Date.now(), stores };
}

export async function downloadBackup({ onProgress } = {}) {
  const backup = await exportBackup({ onProgress });
  const json = JSON.stringify(backup);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
  a.href = url;
  a.download = `pitchperfect-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return backup;
}

// Parses and sanity-checks a chosen file without touching the database yet
// — the caller shows a confirmation (restoring can overwrite existing
// songs/attempts that share an id) before actually calling importBackup.
export async function readBackupFile(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    throw new Error('That file isn’t valid JSON.');
  }
  if (!backup || backup.app !== BACKUP_APP_ID || !backup.stores) {
    throw new Error('That file doesn’t look like a PitchPerfect backup.');
  }
  return backup;
}

export async function importBackup(backup, { onProgress } = {}) {
  const storeNames = Object.keys(backup.stores);
  const data = {};
  for (let i = 0; i < storeNames.length; i++) {
    const name = storeNames[i];
    const blobField = BLOB_FIELDS[name];
    if (blobField) {
      data[name] = backup.stores[name].map((row) => {
        const { [blobField]: base64, ...rest } = row;
        return { ...rest, [blobField]: base64 ? base64ToBlob(base64, rest.mimeType) : null };
      });
    } else {
      data[name] = backup.stores[name];
    }
    if (onProgress) onProgress(((i + 1) / storeNames.length) * 100);
  }
  await store.importRaw(data);
}
