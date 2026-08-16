// LALAL.AI client — talks to a small Cloudflare Worker proxy
// (worker/lalalai-proxy.js) rather than LALAL.AI's API directly. Confirmed
// live: a direct browser fetch() to LALAL.AI gets rejected at the CORS
// preflight stage (their Access-Control-Allow-Headers doesn't allowlist
// X-License-Key), because their API is built for server-side callers. The
// proxy exists purely to make that one server-to-server hop.
//
// This also means the license key now lives in the Worker (as a secret,
// never in this app's source) instead of being pasted into the app by the
// end user — better privacy than the original bring-your-own-key-in-the-
// browser design, since nothing secret needs to live in client storage.
//
// Set this to your deployed Worker's URL — see worker/README.md.
const PROXY_BASE_URL = 'https://perfectpitch-proxy.piraterob.workers.dev';

class LalalConfigError extends Error {}
class LalalRequestError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function assertConfigured() {
  if (!PROXY_BASE_URL || PROXY_BASE_URL === 'TODO_SET_ME') {
    throw new LalalConfigError(
      'PROXY_BASE_URL is not set in js/lalalai.js — deploy the Worker in worker/ first (see worker/README.md), then paste its URL in here.'
    );
  }
}

function contentDisposition(filename) {
  if (/^[\x00-\x7F]*$/.test(filename)) return `attachment; filename="${filename}"`;
  return `attachment; filename*=utf-8''${encodeURIComponent(filename)}`;
}

async function proxyFetch(path, options = {}) {
  const res = await fetch(`${PROXY_BASE_URL}${path}`, options);
  if (!res.ok) {
    let body;
    try { body = await res.text(); } catch { /* ignore */ }
    throw new LalalRequestError(`Proxy request failed: ${res.status} ${res.statusText}`, {
      status: res.status,
      body,
    });
  }
  return res.json();
}

// POST /proxy/upload -> LALAL.AI POST /upload/ — raw file bytes as the
// body, filename carried in Content-Disposition. Returns the source_id.
export async function uploadFile(file) {
  const result = await proxyFetch('/proxy/upload', {
    method: 'POST',
    headers: { 'Content-Disposition': contentDisposition(file.name || 'audio') },
    body: file,
  });
  return result.id;
}

// POST /proxy/split -> LALAL.AI POST /split/stem_separator/. `clear_cut` is
// chosen over the API's own `deep_extraction` default because a cleaner
// (if slightly less detailed) vocal stem matters more here than max
// fidelity — analyze.js runs pitch detection on it, and separation
// artifacts are more likely to confuse that than to matter for karaoke
// listening.
export async function startSplitTask(sourceId, {
  stem = 'vocals', extractionLevel = 'clear_cut', splitter = 'auto',
} = {}) {
  const result = await proxyFetch('/proxy/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_id: sourceId,
      presets: { stem, extraction_level: extractionLevel, splitter },
    }),
  });
  return result.task_id;
}

// POST /proxy/check -> LALAL.AI POST /check/, batched by design; we only
// ever ask about one task, so unwrap that single entry for callers.
export async function checkTask(taskId) {
  const result = await proxyFetch('/proxy/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: [taskId] }),
  });
  const task = result.result?.[taskId];
  if (!task) throw new LalalRequestError(`Task ${taskId} not found in check response`);
  return task; // { status, progress?, presets?, result? }
}

export async function pollTaskUntilDone(taskId, { intervalMs = 5000, timeoutMs = 600000, onStatus } = {}) {
  const start = Date.now();
  for (;;) {
    const task = await checkTask(taskId);
    if (onStatus) onStatus(task.status, task.progress);
    if (task.status === 'success') return task.result; // { tracks: [{ url, label }, ...] }
    if (task.status === 'cancelled') throw new LalalRequestError('LALAL.AI task was cancelled');
    // Confirmed statuses are 'progress' (still running) and the two above —
    // anything else is an unrecognized/error status. Surface it immediately
    // instead of silently polling for the full timeout and reporting a
    // generic "timed out" that hides the real reason.
    if (task.status !== 'progress') {
      throw new LalalRequestError(`LALAL.AI task failed with unexpected status: ${task.status}`);
    }
    if (Date.now() - start > timeoutMs) throw new LalalRequestError('LALAL.AI task timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Routed through the proxy's /proxy/download too, rather than fetched
// directly — the track URL LALAL.AI returns may live on a different host
// with unknown CORS behavior of its own, and there's no upside to finding
// that out the hard way when the proxy already handles this case.
export async function downloadTrack(url) {
  const res = await fetch(`${PROXY_BASE_URL}/proxy/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    throw new LalalRequestError(`Track download failed: ${res.status} ${res.statusText}`, { status: res.status });
  }
  return res.blob();
}

// Best-effort storage cleanup once stems are downloaded — considerate given
// this is the account's own quota, not required for correctness.
export async function deleteSource(sourceId) {
  await proxyFetch('/proxy/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId }),
  }).catch(() => {}); // cleanup is opportunistic, not worth failing the import over
}

// Confirmed live against a real split: a stem_separator/vocals request
// returns tracks labeled exactly "vocals" and "no_vocals". The vocals match
// is anchored (^vocals?$) rather than a loose /vocal/i substring test,
// because "no_vocals" itself contains "vocal" and would otherwise get
// matched as the vocals track depending on array order. The extra
// alternatives below are a fallback in case a different preset/stem
// combination ever returns different label text.
function parseTracks(result) {
  const tracks = result?.tracks || [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  const vocals = tracks.find((t) => /^vocals?$/.test(norm(t.label)));
  const instrumental = tracks.find((t) => t !== vocals && /^no.?vocals?$|instrumental|back|accompaniment|music/.test(norm(t.label)));
  if (!vocals || !instrumental) {
    throw new LalalRequestError(
      `Could not identify vocals/instrumental tracks in split result. Labels seen: ${tracks.map((t) => JSON.stringify(t.label)).join(', ') || '(none)'}`
    );
  }
  return { vocalsUrl: vocals.url, instrumentalUrl: instrumental.url };
}

// High-level orchestration used by app.js: upload -> split -> poll -> download.
export async function separateVocals(file, { onProgress } = {}) {
  assertConfigured();
  const progress = (phase, pct) => onProgress && onProgress({ phase, pct });

  progress('uploading', 0);
  const sourceId = await uploadFile(file);
  progress('uploading', 100);

  progress('separating', 0);
  const taskId = await startSplitTask(sourceId, { stem: 'vocals' });
  const result = await pollTaskUntilDone(taskId, {
    onStatus: (status, pct) => progress('separating', status === 'progress' ? (pct ?? 10) : 10),
  });
  progress('separating', 100);

  progress('downloading_stems', 0);
  const { vocalsUrl, instrumentalUrl } = parseTracks(result);
  const [vocalsBlob, instrumentalBlob] = await Promise.all([
    downloadTrack(vocalsUrl),
    downloadTrack(instrumentalUrl),
  ]);
  progress('downloading_stems', 100);

  deleteSource(sourceId); // fire-and-forget cleanup, not awaited

  return { vocalsBlob, instrumentalBlob, taskId };
}

export { LalalConfigError, LalalRequestError };
