// App shell: view routing + service worker registration + library/import.
// Fleshed out incrementally as pitch.js/player.js/etc. land.

import { store, uuid } from './db.js';
import { separateVocals } from './lalalai.js';
import { analyzeSongVocals } from './analyze.js';
import { createPlayer } from './player.js';
import { createVisualizer } from './visualizer.js';
import { startMicPitchTracking, getAnalysisLatencySec } from './mic.js';
import { createAccuracyTracker } from './scoring.js';
import { createAttemptRecorder, isRecordingSupported } from './recorder.js';

const TOLERANCE_META_KEY = 'pitchToleranceCents';
const DEFAULT_TOLERANCE_CENTS = 5;

const views = document.querySelectorAll('.view');
const tabButtons = document.querySelectorAll('.tab-btn');

export function switchView(name) {
  views.forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  // Settings is reachable mid-session (it doesn't tear practiceSession down —
  // see wireTabbar's comment below), so "Return to Song" only makes sense,
  // and is only shown, when there's actually a session left to return to.
  if (name === 'settings') returnToSongBtn.hidden = !practiceSession;
}

function wireTabbar() {
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
      // The tabbar is reachable from any screen (it's outside the .view
      // sections), so this is the only navigation path that's guaranteed to
      // run on every way of getting back to Library — the Processing/
      // Practice screens' own "Back to library" buttons re-render too, but
      // relying on only those left the list stale (and a practice session
      // running in the background) whenever someone used this tabbar
      // button instead.
      if (btn.dataset.view === 'library') {
        stopPracticeSession();
        renderLibrary();
      }
    });
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// --- Settings ---

const toleranceSliderEl = document.getElementById('tolerance-slider');
const toleranceValueEl = document.getElementById('tolerance-value');
const returnToSongBtn = document.getElementById('return-to-song-btn');

async function loadSettings() {
  const saved = await store.getMeta(TOLERANCE_META_KEY);
  const cents = saved ?? DEFAULT_TOLERANCE_CENTS;
  toleranceSliderEl.value = cents;
  toleranceValueEl.textContent = cents;
}

function wireSettings() {
  toleranceSliderEl.addEventListener('input', () => {
    toleranceValueEl.textContent = toleranceSliderEl.value;
    // Applies immediately if a practice session is already running, rather
    // than only taking effect the next time a song is opened — keeps the
    // dot colors and the score's tier boundary in agreement with each other.
    if (practiceSession) {
      const cents = Number(toleranceSliderEl.value);
      practiceSession.accuracyTracker.setTolerance(cents);
      practiceSession.visualizer.setTolerance(cents);
      practiceSession.toleranceCents = cents;
      practiceToleranceEl.textContent = `±${cents}¢`;
    }
  });
  toleranceSliderEl.addEventListener('change', () => {
    store.setMeta(TOLERANCE_META_KEY, Number(toleranceSliderEl.value));
  });
  returnToSongBtn.addEventListener('click', () => {
    if (practiceSession) switchView('practice');
  });
}

// --- Library ---

const songListEl = document.getElementById('song-list');
const libraryEmptyEl = document.getElementById('library-empty');
const importBtn = document.getElementById('import-btn');
const importInput = document.getElementById('import-input');

const STATUS_LABELS = {
  imported: 'Imported',
  uploading: 'Uploading…',
  separating: 'Separating vocals…',
  downloading_stems: 'Downloading stems…',
  analyzing: 'Analyzing pitch…',
  ready: 'Ready',
  failed: 'Failed',
};

// Tracks the song (if any) currently showing its inline "delete this?"
// confirmation in place of its normal status/delete button. An in-app
// confirmation instead of window.confirm(): native dialogs are unreliable
// in some PWA/installed-homescreen contexts and are outright disabled in
// this project's own preview tooling, where confirm() silently returns
// false and makes the delete button look broken.
let pendingDeleteId = null;

async function renderLibrary() {
  const songs = await store.getAllSongs();
  songs.sort((a, b) => b.createdAt - a.createdAt);
  songListEl.innerHTML = '';
  libraryEmptyEl.hidden = songs.length > 0;
  for (const song of songs) {
    const li = document.createElement('li');
    li.className = 'song-row';

    if (pendingDeleteId === song.id) {
      li.innerHTML = `
        <span class="song-row-confirm-text">Delete "${song.title}"?</span>
        <button class="btn btn-secondary song-row-confirm-cancel">Cancel</button>
        <button class="btn btn-primary song-row-confirm-delete">Delete</button>
      `;
      li.querySelector('.song-row-confirm-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        pendingDeleteId = null;
        renderLibrary();
      });
      li.querySelector('.song-row-confirm-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await store.deleteSong(song.id);
        pendingDeleteId = null;
        await renderLibrary();
      });
    } else {
      li.innerHTML = `
        <span class="song-row-title"></span>
        <span class="song-row-status status-${song.status}"></span>
        <button class="song-row-delete" aria-label="Delete song" title="Delete">&times;</button>
      `;
      li.querySelector('.song-row-title').textContent = song.title;
      li.querySelector('.song-row-status').textContent = STATUS_LABELS[song.status] || song.status;
      li.addEventListener('click', () => openSong(song.id));
      li.querySelector('.song-row-delete').addEventListener('click', (e) => {
        e.stopPropagation(); // don't also trigger the row's openSong click
        pendingDeleteId = song.id;
        renderLibrary();
      });
    }
    songListEl.appendChild(li);
  }
}

function openSong(id) {
  pendingDeleteId = null;
  store.getSong(id).then((song) => {
    if (song && song.status === 'ready') openPractice(id);
    else showProcessing(id);
  });
}

// --- Processing ---

const processingTitleEl = document.getElementById('processing-title');
const processingStatusEl = document.getElementById('processing-status');
const processingBarEl = document.getElementById('processing-bar');
const processingErrorEl = document.getElementById('processing-error');
const processingBackBtn = document.getElementById('processing-back-btn');

async function showProcessing(songId) {
  const song = await store.getSong(songId);
  if (!song) return;
  processingTitleEl.textContent = song.title;
  processingStatusEl.textContent = STATUS_LABELS[song.status] || song.status;
  processingBarEl.style.width = song.status === 'ready' ? '100%' : '10%';
  processingErrorEl.hidden = !song.errorMessage;
  processingErrorEl.textContent = song.errorMessage || '';
  switchView('processing');
}

processingBackBtn.addEventListener('click', async () => {
  switchView('library');
  await renderLibrary();
});

// --- Import ---

importBtn.addEventListener('click', () => importInput.click());

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;
  await importSong(file);
});

async function importSong(file) {
  const song = {
    id: uuid(),
    title: file.name.replace(/\.[^.]+$/, ''),
    artist: '',
    originalFileName: file.name,
    durationSec: null,
    status: 'uploading',
    errorMessage: null,
    lalalaiTaskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.putSong(song);
  await showProcessing(song.id);

  const onProgress = ({ phase, pct }) => {
    song.status = phase;
    processingStatusEl.textContent = STATUS_LABELS[phase] || phase;
    processingBarEl.style.width = `${pct}%`;
  };

  try {
    const { vocalsBlob, instrumentalBlob, taskId } = await separateVocals(file, { onProgress });
    song.lalalaiTaskId = taskId;
    await store.putStem({ songId: song.id, kind: 'vocals', blob: vocalsBlob, mimeType: vocalsBlob.type });
    await store.putStem({ songId: song.id, kind: 'instrumental', blob: instrumentalBlob, mimeType: instrumentalBlob.type });

    song.status = 'analyzing';
    processingStatusEl.textContent = STATUS_LABELS.analyzing;
    processingBarEl.style.width = '0%';
    await analyzeSongVocals(song.id, {
      onProgress: (pct) => { processingBarEl.style.width = `${pct}%`; },
    });
    song.status = 'ready';
  } catch (err) {
    song.status = 'failed';
    song.errorMessage = err.message || String(err);
  }
  song.updatedAt = Date.now();
  await store.putSong(song);
  await showProcessing(song.id);
}

// --- Practice ---

const practiceTitleEl = document.getElementById('practice-title');
const practiceToleranceEl = document.getElementById('practice-tolerance-badge');
const pitchCanvasEl = document.getElementById('pitch-canvas');
const seekBarEl = document.getElementById('seek-bar');
const seekCurrentTimeEl = document.getElementById('seek-current-time');
const seekDurationEl = document.getElementById('seek-duration');
const seekNudgeBackBtn = document.getElementById('seek-nudge-back-btn');
const seekNudgeFwdBtn = document.getElementById('seek-nudge-fwd-btn');
const resetAttemptBtn = document.getElementById('reset-attempt-btn');
const playPauseBtn = document.getElementById('play-pause-btn');
const startSingingBtn = document.getElementById('start-singing-btn');
const micStatusEl = document.getElementById('mic-status');
const accuracyDisplayEl = document.getElementById('accuracy-display');
const sectionPanelEl = document.getElementById('section-panel');
const markSectionStartBtn = document.getElementById('mark-section-start-btn');
const markSectionEndBtn = document.getElementById('mark-section-end-btn');
const sectionPendingLabelEl = document.getElementById('section-pending-label');
const sectionListEl = document.getElementById('section-list');
const viewAttemptsBtn = document.getElementById('view-attempts-btn');
const attemptsBackBtn = document.getElementById('attempts-back-btn');
const attemptsTitleEl = document.getElementById('attempts-title');
const attemptsListEl = document.getElementById('attempts-list');
const attemptsEmptyEl = document.getElementById('attempts-empty');
const attemptPlayerEl = document.getElementById('attempt-player');
const attemptVideoEl = document.getElementById('attempt-video');
const attemptPlayPauseBtn = document.getElementById('attempt-play-pause-btn');
const attemptResetBtn = document.getElementById('attempt-reset-btn');
const attemptSeekBarEl = document.getElementById('attempt-seek-bar');
const attemptCurrentTimeEl = document.getElementById('attempt-current-time');
const attemptDurationEl = document.getElementById('attempt-duration');
const attemptSectionBreakdownEl = document.getElementById('attempt-section-breakdown');

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Time only — used inside a day group, where the group's own header
// already carries the date (see formatDayLabel/dayKeyFor below).
function formatTimeOnly(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Groups attempts by local calendar day (toDateString() ignores time-of-day
// and is stable for same-day comparison without a timezone library).
function dayKeyFor(ms) {
  return new Date(ms).toDateString();
}

function formatDayLabel(ms) {
  const d = new Date(ms);
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

// Whole-song cumulative average alongside a 5s rolling average — the
// cumulative figure alone stops moving meaningfully after the first few
// bars (see scoring.js), so the rolling number is what actually reflects
// how the last few seconds went.
function formatAccuracyDisplay(cumulativePct, rollingPct) {
  const fmt = (pct) => (pct === null ? '--' : pct + '%');
  return `Accuracy: ${fmt(cumulativePct)} · Last 5s: ${fmt(rollingPct)}`;
}

// Accepts "M:SS" (matching formatTime's own output, so round-tripping
// through the field is lossless) or a bare number of seconds. Returns null
// on anything unparseable so the caller can fall back sensibly.
function parseTimeInput(str) {
  const s = String(str || '').trim();
  if (s.includes(':')) {
    const [mPart, sPart] = s.split(':');
    const m = parseInt(mPart, 10);
    const sec = parseFloat(sPart);
    if (Number.isFinite(m) && Number.isFinite(sec)) return m * 60 + sec;
    return null;
  }
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

// Chromium's webm muxer often reports a bogus/inflated `duration` for
// streamed/chunked MediaRecorder output — and critically, the bogus value
// is a plausible-looking finite number (seen live: ~29s for a real ~4s
// recording), not Infinity/NaN, so a "only fix it if duration looks
// unset" guard would skip exactly the case that needs fixing. This always
// runs the standard workaround instead: seeking near the end of the
// stream forces the browser to recompute the true duration, then playback
// position resets to the start.
function fixVideoDuration(video) {
  return new Promise((resolve) => {
    const doFix = () => {
      const onTimeUpdate = () => {
        video.removeEventListener('timeupdate', onTimeUpdate);
        video.currentTime = 0;
        resolve(video.duration);
      };
      video.addEventListener('timeupdate', onTimeUpdate);
      video.currentTime = 1e101;
    };
    if (video.readyState >= 1) doFix();
    else video.addEventListener('loadedmetadata', doFix, { once: true });
  });
}

// Wired once here (not per render) since attempt-video/-seek-bar/etc. are
// static elements reused across every attempt row click — re-wiring inside
// renderAttemptsList would stack duplicate listeners on every re-render.
attemptPlayPauseBtn.addEventListener('click', () => {
  if (attemptVideoEl.paused) attemptVideoEl.play();
  else attemptVideoEl.pause();
});
attemptVideoEl.addEventListener('play', () => { attemptPlayPauseBtn.textContent = 'Pause'; });
attemptVideoEl.addEventListener('pause', () => { attemptPlayPauseBtn.textContent = 'Start'; });
attemptVideoEl.addEventListener('timeupdate', () => {
  attemptSeekBarEl.value = attemptVideoEl.currentTime;
  attemptCurrentTimeEl.textContent = formatTime(attemptVideoEl.currentTime);
});
attemptSeekBarEl.addEventListener('input', () => {
  attemptVideoEl.currentTime = parseFloat(attemptSeekBarEl.value);
});
// Discards nothing (there's no separate "take" to abandon here, unlike the
// Practice screen's Reset) — just pauses and rewinds this attempt's own
// playback back to the start.
attemptResetBtn.addEventListener('click', () => {
  attemptVideoEl.pause();
  attemptVideoEl.currentTime = 0;
  attemptSeekBarEl.value = 0;
  attemptCurrentTimeEl.textContent = '0:00';
  attemptPlayPauseBtn.textContent = 'Start';
});

// Tracks the cue (if any) currently showing its inline text-edit field in
// place of its normal display row — same pattern as pendingDeleteId for
// the song list, one row swaps to an editable state rather than opening a
// separate dialog.
// The in-progress section mark: set to a playback position by "Mark Section
// Start", cleared once "Mark Section End" completes (or a new song opens).
// Not persisted — a half-marked section is meaningless outside this session.
let pendingSectionStart = null;
// Swaps a row's boundary display into editable start/end fields, same
// pattern the old cue list used for its own inline edit — one row at a
// time, in place, rather than a separate dialog.
let editingSectionId = null;

// Sections don't overlap and are sorted by start (enforced at save time
// below), so "Section N" numbering is just the sorted list's own index —
// no separate ordering field needed.
async function renderSectionList(songId) {
  const sections = await store.getSectionsForSong(songId);
  sectionListEl.innerHTML = '';
  sections.forEach((section, i) => {
    const li = document.createElement('li');
    li.className = 'section-row';

    const header = document.createElement('div');
    header.className = 'section-row-header';

    if (editingSectionId === section.id) {
      header.innerHTML = `
        <input type="text" class="section-time-input section-edit-start" placeholder="0:00" inputmode="numeric" autocomplete="off" />
        <span class="section-row-text">to</span>
        <input type="text" class="section-time-input section-edit-end" placeholder="0:00" inputmode="numeric" autocomplete="off" />
        <button class="btn btn-secondary section-edit-cancel">Cancel</button>
        <button class="btn btn-primary section-edit-save">Save</button>
        <span class="section-edit-error"></span>
      `;
      const startInput = header.querySelector('.section-edit-start');
      const endInput = header.querySelector('.section-edit-end');
      const errorEl = header.querySelector('.section-edit-error');
      startInput.value = formatTime(section.startSec);
      endInput.value = formatTime(section.endSec);
      const save = async () => {
        const startSec = parseTimeInput(startInput.value);
        const endSec = parseTimeInput(endInput.value);
        if (startSec === null || endSec === null) { errorEl.textContent = 'Enter valid times.'; return; }
        if (endSec <= startSec) { errorEl.textContent = 'End must be after start.'; return; }
        const others = sections.filter((s) => s.id !== section.id);
        if (others.some((s) => startSec < s.endSec && endSec > s.startSec)) {
          errorEl.textContent = 'Overlaps another section.';
          return;
        }
        await store.updateSection(section.id, { startSec, endSec });
        if (practiceSession && practiceSession.songId === songId) {
          practiceSession.visualizer.updateSectionBounds(section.id, startSec, endSec);
          practiceSession.accuracyTracker.updateSectionBounds(section.id, startSec, endSec);
        }
        editingSectionId = null;
        await renderSectionList(songId);
      };
      header.querySelector('.section-edit-save').addEventListener('click', save);
      header.querySelector('.section-edit-cancel').addEventListener('click', () => {
        editingSectionId = null;
        renderSectionList(songId);
      });
    } else {
      header.innerHTML = `
        <input type="text" class="section-label-input" autocomplete="off" />
        <span class="section-row-time"></span>
        <button class="section-row-edit" aria-label="Edit section timing" title="Edit timing">&#9998;</button>
        <button class="section-row-delete" aria-label="Delete section" title="Delete">&times;</button>
      `;
      const labelInput = header.querySelector('.section-label-input');
      // Placeholder (not stored) shows the positional fallback name — typing
      // something replaces it with a real, persisted, position-independent
      // label (e.g. "Chorus") that survives sections being added before it.
      labelInput.placeholder = `Section ${i + 1}`;
      labelInput.value = section.label || '';
      const saveLabel = async () => {
        const label = labelInput.value.trim();
        if (label === (section.label || '')) return;
        await store.updateSectionLabel(section.id, label);
        if (practiceSession && practiceSession.songId === songId) {
          practiceSession.accuracyTracker.updateSectionLabel(section.id, label);
        }
        // Full re-render (safe — this only fires after blur, so nothing is
        // mid-edit) rather than just mutating `section.label` in place:
        // every OTHER row's "Copy from…" dropdown was built from this same
        // render's `sections` snapshot, so a stale in-place mutation here
        // wouldn't reach their already-built <option> text or their still-
        // stale copy of this section's text.
        await renderSectionList(songId);
      };
      labelInput.addEventListener('blur', saveLabel);
      labelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') labelInput.blur(); });
      header.querySelector('.section-row-time').textContent =
        `(${formatTime(section.startSec)}–${formatTime(section.endSec)})`;
      header.querySelector('.section-row-edit').addEventListener('click', () => {
        editingSectionId = section.id;
        renderSectionList(songId);
      });
      header.querySelector('.section-row-delete').addEventListener('click', async () => {
        await store.deleteSection(section.id);
        if (practiceSession && practiceSession.songId === songId) {
          practiceSession.visualizer.removeSection(section.id);
          practiceSession.accuracyTracker.removeSection(section.id);
        }
        await renderSectionList(songId);
      });
    }
    li.appendChild(header);

    // Always visible (not gated behind the timing-edit toggle above) since
    // typing/tweaking the lyric happens far more often than adjusting a
    // section's boundaries once they're set.
    const lyricRow = document.createElement('div');
    lyricRow.className = 'section-lyric-row';
    lyricRow.innerHTML = `
      <input type="text" class="section-lyric-input" placeholder="Lyric for this section" autocomplete="off" />
      <select class="section-copy-select" aria-label="Copy lyric from another section"></select>
    `;
    const textInput = lyricRow.querySelector('.section-lyric-input');
    textInput.value = section.text || '';
    const saveText = async (text) => {
      if (text === (section.text || '')) return;
      await store.updateSectionText(section.id, text);
      if (practiceSession && practiceSession.songId === songId) {
        practiceSession.visualizer.updateSectionText(section.id, text);
      }
      // Same reasoning as saveLabel's full re-render: other rows' copy
      // dropdowns would otherwise keep offering this section's pre-edit
      // text (or pre-rename label) until something else happened to
      // trigger a rebuild.
      await renderSectionList(songId);
    };
    textInput.addEventListener('blur', () => saveText(textInput.value.trim()));
    textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') textInput.blur(); });

    // Reuses an already-typed lyric on another section (e.g. a repeated
    // chorus) instead of retyping it — copies that section's current text
    // in immediately, no confirmation, same low-friction editing as typing
    // it directly (retyping is just as easy an "undo" as anything else here).
    const copySelect = lyricRow.querySelector('.section-copy-select');
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = 'Copy from…';
    placeholderOpt.disabled = true;
    placeholderOpt.selected = true;
    copySelect.appendChild(placeholderOpt);
    sections.forEach((other, otherIndex) => {
      if (other.id === section.id) return;
      const opt = document.createElement('option');
      opt.value = other.id;
      const otherLabel = other.label || `Section ${otherIndex + 1}`;
      opt.textContent = `${otherLabel} (${formatTime(other.startSec)}–${formatTime(other.endSec)})`;
      copySelect.appendChild(opt);
    });
    copySelect.addEventListener('change', async () => {
      const sourceId = copySelect.value;
      copySelect.value = '';
      if (!sourceId) return;
      const source = sections.find((s) => s.id === sourceId);
      if (source) await saveText(source.text || '');
    });

    li.appendChild(lyricRow);

    sectionListEl.appendChild(li);
  });
}

markSectionStartBtn.addEventListener('click', () => {
  if (!practiceSession) return;
  pendingSectionStart = practiceSession.player.currentTime;
  sectionPendingLabelEl.textContent = `Start set at ${formatTime(pendingSectionStart)} — play or step to the end, then Mark Section End.`;
  markSectionEndBtn.disabled = false;
});

markSectionEndBtn.addEventListener('click', async () => {
  if (!practiceSession || pendingSectionStart === null) return;
  const session = practiceSession;
  const startSec = pendingSectionStart;
  const endSec = session.player.currentTime;
  if (endSec <= startSec) {
    sectionPendingLabelEl.textContent = `End (${formatTime(endSec)}) must be after start (${formatTime(startSec)}) — play forward, then try again.`;
    return;
  }
  const existing = await store.getSectionsForSong(session.songId);
  if (existing.some((s) => startSec < s.endSec && endSec > s.startSec)) {
    sectionPendingLabelEl.textContent = 'That overlaps an existing section — adjust and try again.';
    return;
  }
  const entry = await store.addSection({ songId: session.songId, startSec, endSec });
  pendingSectionStart = null;
  markSectionEndBtn.disabled = true;
  sectionPendingLabelEl.textContent = '';
  if (practiceSession === session) {
    practiceSession.visualizer.addSection(entry);
    practiceSession.accuracyTracker.addSection(entry);
    await renderSectionList(session.songId);
  }
});

// Tracks the attempt (if any) currently showing its inline "delete this?"
// confirmation — deleting a recording is more consequential than deleting
// a text cue, so this uses the same Cancel/Delete confirm pattern as the
// song list rather than the cue list's immediate delete.
let pendingDeleteAttemptId = null;
// Which day groups are currently expanded on the Attempts screen (keyed by
// dayKeyFor's date string) — day groups start collapsed, so this only ever
// holds days the user has actually opened. Reset whenever "View Attempts"
// is entered fresh (see viewAttemptsBtn below), but preserved across the
// re-renders a delete/cancel triggers within that same viewing session, so
// expanding a day to delete something from it doesn't collapse it again.
let expandedDayKeys = new Set();
// The object URL currently loaded into attempt-video — tracked so it can
// be revoked before creating the next one, otherwise each attempt played
// back in a session leaks its blob URL for the rest of the page's life.
let currentAttemptVideoUrl = null;
// attempt-video/-seek-bar/-duration are static elements shared across every
// attempt row (see renderAttemptsList below) — bumped on each row click and
// captured locally so a slower fixVideoDuration() call for an earlier click
// can tell it's been superseded and skip applying its (now-stale) result to
// whichever attempt is actually loaded by the time it resolves.
let attemptPlaybackToken = 0;
// Resolves once fixVideoDuration()'s own seek-to-end-and-back workaround
// (see below) has settled for whichever attempt is currently loaded —
// section clicks await this first so their seek doesn't race with, and
// get silently overwritten by, that in-flight duration-fix.
let attemptVideoReadyPromise = null;

const SECTION_LEADIN_SEC = 3;

function accuracyClass(pct) {
  if (pct === null || pct === undefined) return '';
  if (pct < 50) return 'accuracy-low';
  if (pct < 80) return 'accuracy-mid';
  return '';
}

// Older attempts predate sectionBreakdown entirely (undefined, not just
// empty) — rendered as no list at all rather than a misleading empty one.
// `token` is this row's attemptPlaybackToken snapshot, so a section click
// that resolves after a later row click has superseded it becomes a no-op
// instead of seeking whatever attempt is now actually loaded.
function renderSectionBreakdown(attempt, token) {
  attemptSectionBreakdownEl.innerHTML = '';
  if (!attempt.sectionBreakdown) return;
  // The video's own time 0 is when recording started, not song time 0 (see
  // attemptStartPlaybackSec) — without that anchor there's no reliable way
  // to map a section's song-timeline time onto a position in this video,
  // so older attempts recorded before it existed just aren't clickable.
  const canSeek = Number.isFinite(attempt.startPlaybackSec);
  attempt.sectionBreakdown.forEach((section, i) => {
    const li = document.createElement('li');
    li.className = canSeek ? 'attempt-section-row clickable' : 'attempt-section-row';
    li.innerHTML = `
      <span class="attempt-section-label"></span>
      <span class="attempt-section-pct"></span>
      <button type="button" class="attempt-section-redo-btn" title="Redo this section">Redo</button>
    `;
    const label = section.label || `Section ${i + 1}`;
    li.querySelector('.attempt-section-label').textContent =
      `${label} (${formatTime(section.startSec)}–${formatTime(section.endSec)})`;
    const pctEl = li.querySelector('.attempt-section-pct');
    pctEl.textContent = section.accuracyPct === null ? '—' : `${section.accuracyPct}%`;
    pctEl.className = `attempt-section-pct ${accuracyClass(section.accuracyPct)}`;
    if (canSeek) {
      li.addEventListener('click', async () => {
        await attemptVideoReadyPromise; // let fixVideoDuration's own seek settle first
        if (token !== attemptPlaybackToken) return; // a later row click superseded this attempt
        const videoSeekSec = Math.max(0, section.startSec - SECTION_LEADIN_SEC - attempt.startPlaybackSec);
        attemptVideoEl.currentTime = videoSeekSec;
        attemptVideoEl.play().catch(() => {});
      });
    }
    // Redo: back to Practice with the *song* (not the attempt video)
    // paused and parked at this section's lead-in — unlike the row's own
    // click above, this only needs section.startSec on the song's own
    // timeline, so it works even on attempts that predate startPlaybackSec.
    li.querySelector('.attempt-section-redo-btn').addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the row's own video-seek click
      if (!practiceSession) return;
      const seekSec = Math.max(0, section.startSec - SECTION_LEADIN_SEC);
      practiceSession.player.pause();
      practiceSession.player.seek(seekSec);
      playPauseBtn.textContent = 'Play';
      seekBarEl.value = seekSec;
      seekCurrentTimeEl.textContent = formatTime(seekSec);
      switchView('practice');
    });
    attemptSectionBreakdownEl.appendChild(li);
  });
}

// Slack around the song's last voiced point, so a take that was stopped
// essentially at the end isn't flagged just because the user's "Stop
// Singing" tap landed a beat before the very last analyzed frame.
const PARTIAL_ATTEMPT_SLACK_SEC = 2;

// "Complete" means vocal input ran through to where the song's own pitch
// spectrum ends — not just "sang for about as long as the song" (that's
// also satisfied by, say, starting mid-song and singing to the end, or
// missed by pausing partway through even after singing a full duration's
// worth elsewhere). `songSpectrumEndSec` is the target timeline's last
// voiced point (see renderAttemptsList); `attempt.endPlaybackSec` is where
// playback actually was the moment "Stop Singing" was clicked.
function isPartialAttempt(attempt, songSpectrumEndSec) {
  if (!Number.isFinite(songSpectrumEndSec) || songSpectrumEndSec <= 0) return false;
  if (!Number.isFinite(attempt.endPlaybackSec)) return false; // older attempts predate this field
  return attempt.endPlaybackSec < songSpectrumEndSec - PARTIAL_ATTEMPT_SLACK_SEC;
}

async function renderAttemptsList(songId) {
  // A previous row click (see below) may have moved the player to sit
  // directly under that row, inside attemptsListEl — move it back to its
  // original position first, or wiping attemptsListEl below would destroy
  // it (video element, listeners, playback state) along with whatever row
  // it's currently nested under. Any full rebuild (collapsing a day,
  // deleting a different attempt) closes the inline player this way,
  // rather than trying to re-locate and reopen it under its original row.
  attemptsListEl.after(attemptPlayerEl);
  const [attempts, pitchTimeline] = await Promise.all([
    store.getAttemptsForSong(songId), // newest first
    store.getPitchTimeline(songId),
  ]);
  attemptsListEl.innerHTML = '';
  attemptsEmptyEl.hidden = attempts.length > 0;
  attemptPlayerEl.hidden = true;
  attemptVideoEl.pause();

  // Where the song's target pitch data actually ends — same voiced-points
  // filter visualizer.js/scoring.js use — not the raw audio's total
  // duration, which can run past (or, in principle, differ from) the last
  // analyzed vocal frame.
  const voicedPoints = (pitchTimeline?.points || []).filter((p) => p.freqHz !== null);
  const songSpectrumEndSec = voicedPoints.length ? voicedPoints[voicedPoints.length - 1].timeSec : null;

  // Counted up front so a collapsed day's header can say how many attempts
  // are inside it without needing a second pass once the group is built.
  const countsByDay = new Map();
  // Best-scoring *complete* attempt per day (the whole attempt, not just
  // its score, since the header also shows the tolerance it was scored
  // under) — a partial take stopped early shouldn't be able to win "best
  // of the day" over a lower-scoring attempt that actually finished.
  const bestAttemptByDay = new Map();
  for (const attempt of attempts) {
    const key = dayKeyFor(attempt.startedAt);
    countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
    if (attempt.accuracyPct === null || isPartialAttempt(attempt, songSpectrumEndSec)) continue;
    const prevBest = bestAttemptByDay.get(key);
    if (!prevBest || attempt.accuracyPct > prevBest.accuracyPct) bestAttemptByDay.set(key, attempt);
  }

  // Attempts arrive newest-first already, so a new day group starts
  // exactly when dayKeyFor changes from the previous attempt — no need to
  // re-sort or bucket into a map first.
  let currentRowsEl = null;
  let currentDayKey = null;

  for (const attempt of attempts) {
    const dayKey = dayKeyFor(attempt.startedAt);
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      const expanded = expandedDayKeys.has(dayKey);

      const groupEl = document.createElement('div');
      groupEl.className = 'attempts-day-group';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'attempts-day-header';
      header.setAttribute('aria-expanded', String(expanded));
      const count = countsByDay.get(dayKey);
      const bestAttempt = bestAttemptByDay.get(dayKey);
      header.innerHTML = `
        <span class="attempts-day-header-label"></span>
        <span class="attempts-day-header-count"></span>
        <span class="attempts-day-header-best"></span>
        <span class="attempts-day-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
      `;
      header.querySelector('.attempts-day-header-label').textContent = formatDayLabel(attempt.startedAt);
      header.querySelector('.attempts-day-header-count').textContent = `${count} attempt${count === 1 ? '' : 's'}`;
      // Left empty (not "Best 0%") when the day has no complete attempt to
      // actually credit a best score to. Older attempts predate
      // toleranceCents, so the "@Y¢" part is only appended when known.
      if (bestAttempt) {
        const centsText = bestAttempt.toleranceCents == null ? '' : `@${bestAttempt.toleranceCents}¢`;
        header.querySelector('.attempts-day-header-best').textContent = `Best ${bestAttempt.accuracyPct}%${centsText}`;
      }
      header.addEventListener('click', () => {
        if (expandedDayKeys.has(dayKey)) expandedDayKeys.delete(dayKey);
        else expandedDayKeys.add(dayKey);
        renderAttemptsList(songId);
      });
      groupEl.appendChild(header);

      currentRowsEl = document.createElement('div');
      currentRowsEl.className = 'attempts-day-rows';
      currentRowsEl.hidden = !expanded;
      groupEl.appendChild(currentRowsEl);

      attemptsListEl.appendChild(groupEl);
    }

    const row = document.createElement('div');
    row.className = 'attempt-row';

    if (pendingDeleteAttemptId === attempt.id) {
      row.innerHTML = `
        <span class="song-row-confirm-text">Delete this attempt?</span>
        <button class="btn btn-secondary attempt-confirm-cancel">Cancel</button>
        <button class="btn btn-primary attempt-confirm-delete">Delete</button>
      `;
      row.querySelector('.attempt-confirm-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        pendingDeleteAttemptId = null;
        renderAttemptsList(songId);
      });
      row.querySelector('.attempt-confirm-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await store.deleteAttempt(attempt.id);
        pendingDeleteAttemptId = null;
        await renderAttemptsList(songId);
      });
    } else {
      row.innerHTML = `
        <span class="attempt-row-datetime"></span>
        <span class="attempt-row-partial" hidden>Partial</span>
        <span class="attempt-row-tolerance"></span>
        <span class="attempt-row-accuracy"></span>
        <button class="attempt-row-delete" aria-label="Delete attempt" title="Delete">&times;</button>
      `;
      // Just the time — the day group's own header already carries the date.
      row.querySelector('.attempt-row-datetime').textContent = formatTimeOnly(attempt.startedAt);
      // Left hidden (not shown as "false") when songDurationSec isn't
      // available at all, rather than asserting "not partial" on data we
      // don't actually have — same non-guessing spirit as the tolerance
      // badge above.
      row.querySelector('.attempt-row-partial').hidden = !isPartialAttempt(attempt, songSpectrumEndSec);
      // Older attempts predate this field and have no stored tolerance —
      // left blank rather than guessing at a value that wasn't actually
      // used to score them.
      row.querySelector('.attempt-row-tolerance').textContent =
        attempt.toleranceCents == null ? '' : `±${attempt.toleranceCents}¢`;
      const accuracyEl = row.querySelector('.attempt-row-accuracy');
      accuracyEl.textContent = attempt.accuracyPct === null ? '—' : `${attempt.accuracyPct}%`;
      accuracyEl.className = `attempt-row-accuracy ${accuracyClass(attempt.accuracyPct)}`;
      row.addEventListener('click', async () => {
        const token = ++attemptPlaybackToken;
        if (currentAttemptVideoUrl) URL.revokeObjectURL(currentAttemptVideoUrl);
        currentAttemptVideoUrl = URL.createObjectURL(attempt.videoBlob);
        attemptVideoEl.src = currentAttemptVideoUrl;
        // Relocates the shared player to sit directly under this row,
        // rather than always appearing in one fixed spot below the whole
        // list regardless of which attempt (possibly several days back)
        // was actually clicked.
        row.insertAdjacentElement('afterend', attemptPlayerEl);
        attemptPlayerEl.hidden = false;
        attemptSeekBarEl.value = 0;
        attemptCurrentTimeEl.textContent = '0:00';
        attemptPlayPauseBtn.textContent = 'Start'; // not necessarily still accurate from a previous attempt's playback state
        renderSectionBreakdown(attempt, token);
        const readyPromise = fixVideoDuration(attemptVideoEl);
        attemptVideoReadyPromise = readyPromise;
        const duration = await readyPromise;
        if (token !== attemptPlaybackToken) return; // a later click already loaded a different attempt
        attemptSeekBarEl.max = duration || 0;
        attemptDurationEl.textContent = formatTime(duration);
        // Left paused — the user starts playback themselves via the Start
        // button, rather than it playing automatically as soon as an
        // attempt is chosen.
      });
      row.querySelector('.attempt-row-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        pendingDeleteAttemptId = attempt.id;
        renderAttemptsList(songId);
      });
    }
    currentRowsEl.appendChild(row);
  }
}

let practiceSession = null; // { songId, player, visualizer, accuracyTracker, rafId, audioContext, playerSourceNode, micSession, recorder, attemptStartedAt }

function stopPracticeSession() {
  if (!practiceSession) return;
  if (practiceSession.rafId) cancelAnimationFrame(practiceSession.rafId);
  if (practiceSession.recorder) practiceSession.recorder.abort(); // still actively recording: genuinely abandoned
  if (practiceSession.micSession) practiceSession.micSession.stop();
  const { audioContext, pendingSave } = practiceSession;
  if (audioContext) {
    if (pendingSave) {
      // A "Stop Singing" save is already flushing — the user asked to keep
      // this one, so let it finish using this AudioContext's nodes instead
      // of closing them out from under it. (A failure is already reported
      // by the save flow itself; nothing more to do with it here.)
      pendingSave.catch(() => {}).finally(() => audioContext.close());
    } else {
      audioContext.close();
    }
  }
  practiceSession.player.destroy();
  practiceSession = null;
}

async function openPractice(songId) {
  stopPracticeSession();

  const song = await store.getSong(songId);
  const instrumentalStem = await store.getStem(songId, 'instrumental');
  const pitchTimeline = await store.getPitchTimeline(songId);
  if (!song || !instrumentalStem) return;

  practiceTitleEl.textContent = song.title;
  playPauseBtn.textContent = 'Play';
  startSingingBtn.textContent = 'Start Singing';
  startSingingBtn.disabled = false;
  setSingingLayout(false); // ensure a fresh song always opens in the default (not-singing) layout
  micStatusEl.textContent = '';
  seekBarEl.value = 0;
  seekBarEl.max = 0;
  seekCurrentTimeEl.textContent = '0:00';
  seekDurationEl.textContent = '0:00';
  accuracyDisplayEl.hidden = true;
  accuracyDisplayEl.textContent = formatAccuracyDisplay(null, null);
  accuracyDisplayEl.className = 'accuracy-display';
  pendingDeleteAttemptId = null;
  if (currentAttemptVideoUrl) { URL.revokeObjectURL(currentAttemptVideoUrl); currentAttemptVideoUrl = null; }
  attemptPlayerEl.hidden = true;
  attemptVideoEl.pause();
  attemptVideoEl.removeAttribute('src');
  attemptVideoEl.load();
  attemptSeekBarEl.value = 0;
  attemptSeekBarEl.max = 0;
  attemptCurrentTimeEl.textContent = '0:00';
  attemptDurationEl.textContent = '0:00';
  attemptPlayPauseBtn.textContent = 'Start';
  attemptSectionBreakdownEl.innerHTML = '';
  pendingSectionStart = null;
  editingSectionId = null;
  markSectionEndBtn.disabled = true;
  sectionPendingLabelEl.textContent = '';

  const toleranceCents = (await store.getMeta(TOLERANCE_META_KEY)) ?? DEFAULT_TOLERANCE_CENTS;
  practiceToleranceEl.textContent = `±${toleranceCents}¢`;
  const player = createPlayer(instrumentalStem.blob);
  // User-marked verse/phrase boundaries (see the Sections panel's Mark
  // Start/End buttons) — replaced an earlier silence-gap auto-detection
  // heuristic that proved unreliable in practice. Each section's own `text`
  // is what the visualizer renders during playback (see createVisualizer).
  const songSections = await store.getSectionsForSong(songId);
  const visualizer = createVisualizer(pitchCanvasEl, { pitchTimeline, sections: songSections, toleranceCents });
  const accuracyTracker = createAccuracyTracker(pitchTimeline, songSections, { toleranceCents });
  practiceSession = {
    songId, player, visualizer, accuracyTracker, toleranceCents,
    rafId: null, audioContext: null, playerSourceNode: null, micSession: null, recorder: null, attemptStartedAt: null,
    pendingSave: null,
  };

  // Duration isn't known until the browser has parsed enough of the audio;
  // readyState check covers blobs that load fast enough to already have it
  // by the time this listener would otherwise be added.
  const setDuration = () => {
    seekBarEl.max = player.duration || 0;
    seekDurationEl.textContent = formatTime(player.duration);
  };
  player.audio.addEventListener('loadedmetadata', setDuration);
  if (player.audio.readyState >= 1) setDuration();

  switchView('practice');
  visualizer.resize();
  await renderSectionList(songId);
  // Attempts render lazily when "View Attempts" is opened, not here — no
  // point fetching and building that list every time a song is opened.

  // Captured so loop() can tell it's been superseded — by a teardown *or*
  // by a second openPractice() call racing this one (e.g. a fast double-tap
  // on a song row, before either call's awaited DB reads above resolve) —
  // and stop rescheduling itself either way. A bare `if (!practiceSession)`
  // truthiness check isn't enough: it stays true for whichever session is
  // *currently* assigned, so a superseded loop would just keep rendering
  // (and its <audio> element playing) forever as an orphaned rAF chain that
  // stopPracticeSession() can never reach, since practiceSession.rafId only
  // ever holds one loop's id at a time.
  const session = practiceSession;

  function loop() {
    if (practiceSession !== session) return;
    visualizer.render(player.currentTime);
    seekBarEl.value = player.currentTime;
    seekCurrentTimeEl.textContent = formatTime(player.currentTime);
    if (!accuracyDisplayEl.hidden) {
      const cumulativePct = session.accuracyTracker.getAccuracy();
      const rollingPct = session.accuracyTracker.getRollingAccuracy(player.currentTime);
      accuracyDisplayEl.textContent = formatAccuracyDisplay(cumulativePct, rollingPct);
      // Colored by the rolling figure, not cumulative — cumulative barely
      // moves after the first few bars (see formatAccuracyDisplay's
      // comment), so tying color to it would look frozen; rolling is the
      // number that actually reflects how the last few seconds went.
      accuracyDisplayEl.className = `accuracy-display ${accuracyClass(rollingPct)}`;
    }
    session.rafId = requestAnimationFrame(loop);
  }
  loop();
}

seekBarEl.addEventListener('input', () => {
  if (!practiceSession) return;
  practiceSession.player.seek(parseFloat(seekBarEl.value));
});

// Nudge buttons flanking the slider: a whole song's duration is squeezed
// into one drag track, so a small delta in finger position covers a large
// delta in time — precise placement by dragging alone is hard regardless of
// the slider's own step size. 0.1s is fine enough to land exactly on a
// syllable after a rough drag gets you close.
const SEEK_NUDGE_SEC = 0.1;
function stepSeek(deltaSec) {
  if (!practiceSession) return;
  const { player } = practiceSession;
  const target = Math.max(0, Math.min(player.duration || 0, player.currentTime + deltaSec));
  player.seek(target);
  // Reflected immediately rather than waiting for the next rAF tick (see
  // openPractice's loop()), so the tap feels instant rather than laggy.
  seekBarEl.value = target;
  seekCurrentTimeEl.textContent = formatTime(target);
}
seekNudgeBackBtn.addEventListener('click', () => stepSeek(-SEEK_NUDGE_SEC));
seekNudgeFwdBtn.addEventListener('click', () => stepSeek(SEEK_NUDGE_SEC));

// Hides the Sections panel while actively singing and grows the pitch graph
// into the space it frees up (see #pitch-canvas.singing), since the graph
// is what you're actually watching while singing, and the extra height
// gives it more room to read clearly. Shown again (canvas back to its
// default height) once singing stops, so marking/editing sections is
// unaffected outside of an active take.
function setSingingLayout(isSinging) {
  sectionPanelEl.hidden = isSinging;
  pitchCanvasEl.classList.toggle('singing', isSinging);
  if (practiceSession) practiceSession.visualizer.resize();
}

startSingingBtn.addEventListener('click', async () => {
  if (!practiceSession || startSingingBtn.disabled) return;

  if (practiceSession.micSession) {
    practiceSession.micSession.stop();
    practiceSession.micSession = null;
    setSingingLayout(false);
    startSingingBtn.textContent = 'Start Singing';
    startSingingBtn.disabled = true; // briefly, while the recording finishes flushing
    micStatusEl.textContent = 'Saving attempt…';

    if (practiceSession.recorder) {
      const { recorder, accuracyTracker, attemptStartedAt, attemptStartPlaybackSec, songId, toleranceCents, player } = practiceSession;
      // Captured now, not after the async recorder.stop() below — this is
      // the playback position at the exact moment "Stop Singing" was
      // clicked, which is what "did singing cover the whole song" should
      // actually be judged against (see isPartialAttempt).
      const endPlaybackSec = player.currentTime;
      // Also captured now, not after the async recorder.stop() — the
      // tracker's per-section sums are already final at the moment singing
      // actually stopped.
      const sectionBreakdown = accuracyTracker.getSectionBreakdown();
      practiceSession.recorder = null;
      // Exposed on the session so stopPracticeSession() can let this finish
      // saving instead of closing the AudioContext its nodes depend on if
      // the user navigates away right now — they already asked to save
      // this recording by clicking "Stop Singing".
      const savePromise = (async () => {
        const videoBlob = await recorder.stop();
        await store.addAttempt({
          songId,
          startedAt: attemptStartedAt,
          durationSec: (Date.now() - attemptStartedAt) / 1000,
          accuracyPct: accuracyTracker.getAccuracy(),
          toleranceCents,
          endPlaybackSec,
          startPlaybackSec: attemptStartPlaybackSec,
          sectionBreakdown,
          videoBlob,
          mimeType: videoBlob.type,
        });
      })();
      practiceSession.pendingSave = savePromise;
      try {
        await savePromise;
        if (practiceSession && practiceSession.songId === songId) await renderAttemptsList(songId);
      } catch (err) {
        if (practiceSession) micStatusEl.textContent = `Recording could not be saved: ${err.message || err}`;
      } finally {
        if (practiceSession) practiceSession.pendingSave = null;
      }
    }

    if (practiceSession) {
      startSingingBtn.disabled = false;
      if (micStatusEl.textContent === 'Saving attempt…') micStatusEl.textContent = '';
    }
    return;
  }

  // Disabled immediately (not just during the stop/save flow above) so a
  // fast double-tap can't re-enter this branch before micSession is
  // assigned below and end up starting two concurrent mic/AudioContext
  // sessions that both feed the same accuracy tracker.
  startSingingBtn.disabled = true;

  // AudioContext creation and getUserMedia both need to happen inside this
  // click handler on iOS Safari — they're gated on an active user gesture.
  try {
    micStatusEl.textContent = 'Requesting microphone…';
    const audioContext = practiceSession.audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') await audioContext.resume();
    practiceSession.audioContext = audioContext;

    // An HTMLMediaElement can only ever be wrapped by one
    // MediaElementAudioSourceNode for its whole lifetime, so this is
    // created once per practice session (first "Start Singing") and reused
    // across multiple start/stop cycles, not recreated per attempt.
    if (!practiceSession.playerSourceNode) {
      const playerSourceNode = audioContext.createMediaElementSource(practiceSession.player.audio);
      playerSourceNode.connect(audioContext.destination); // keep instrumental playback audible
      practiceSession.playerSourceNode = playerSourceNode;
    }

    const session = practiceSession;
    // Each pitch estimate reflects audio from slightly before the moment
    // its message arrives (see getAnalysisLatencySec) — subtracted here so
    // a sample is compared against where the target pitch actually was
    // when that audio was captured, not wherever playback has since moved
    // on to.
    const micLatencySec = getAnalysisLatencySec(audioContext.sampleRate);
    const micSession = await startMicPitchTracking(audioContext, {
      onPitch: ({ freqHz, confidence }) => {
        if (practiceSession !== session) return; // session torn down mid-flight
        const t = Math.max(0, session.player.currentTime - micLatencySec);
        session.visualizer.pushLiveSample(t, freqHz, confidence);
        session.accuracyTracker.addSample(t, freqHz);
      },
    });
    if (practiceSession !== session) { micSession.stop(); return; } // torn down while awaiting permission

    // Reset/show the score only once the mic is actually confirmed live —
    // doing this before the permission prompt (as before) left the UI
    // showing a live "Accuracy: --" readout even after the user denied
    // access, since the catch below never had reason to undo it.
    practiceSession.accuracyTracker.reset();
    accuracyDisplayEl.hidden = false;
    accuracyDisplayEl.textContent = formatAccuracyDisplay(null, null);
    accuracyDisplayEl.className = 'accuracy-display';

    practiceSession.micSession = micSession;
    setSingingLayout(true);
    startSingingBtn.textContent = 'Stop Singing';
    micStatusEl.textContent = 'Listening…';

    if (isRecordingSupported()) {
      try {
        practiceSession.recorder = createAttemptRecorder({
          canvasEl: pitchCanvasEl,
          audioContext,
          playerSourceNode: practiceSession.playerSourceNode,
          micStream: micSession.stream,
        });
        practiceSession.recorder.start();
        practiceSession.attemptStartedAt = Date.now();
        // Song position at the moment the recording actually starts — the
        // video's own time 0 corresponds to this, not song time 0, since
        // singing can start partway through (see the section-click seek
        // math in renderSectionBreakdown).
        practiceSession.attemptStartPlaybackSec = practiceSession.player.currentTime;
      } catch (err) {
        // The mic is genuinely live at this point — only recording setup
        // failed — so this gets its own message instead of falling into
        // the catch below and wrongly claiming the mic is unavailable.
        micStatusEl.textContent = `Listening… (recording failed to start: ${err.message || err})`;
      }
    } else {
      micStatusEl.textContent = 'Listening… (recording not supported on this browser)';
    }
  } catch (err) {
    micStatusEl.textContent = `Mic unavailable: ${err.message || err}`;
  } finally {
    if (practiceSession) startSingingBtn.disabled = false;
  }
});

resetAttemptBtn.addEventListener('click', () => {
  // Same guard startSingingBtn's own handler uses — most importantly, it
  // keeps this from firing during the brief window after "Stop Singing"
  // where a save is still flushing: accuracyTracker.reset() below would
  // otherwise zero out the very score that pending save is about to read.
  if (!practiceSession || startSingingBtn.disabled) return;
  const session = practiceSession;

  // Discard whatever's currently being recorded/tracked — Reset means
  // starting over, not saving a partial take.
  if (session.recorder) {
    session.recorder.abort(); // still actively recording: genuinely abandoned
    session.recorder = null;
  }
  if (session.micSession) {
    session.micSession.stop();
    session.micSession = null;
  }
  session.attemptStartedAt = null;
  session.accuracyTracker.reset();
  session.visualizer.clearLiveSamples();
  setSingingLayout(false);

  startSingingBtn.textContent = 'Start Singing';
  micStatusEl.textContent = '';
  accuracyDisplayEl.hidden = true;
  accuracyDisplayEl.textContent = formatAccuracyDisplay(null, null);
  accuracyDisplayEl.className = 'accuracy-display';

  session.player.pause();
  session.player.seek(0);
  playPauseBtn.textContent = 'Play';
  seekBarEl.value = 0;
  seekCurrentTimeEl.textContent = '0:00';
});

playPauseBtn.addEventListener('click', () => {
  if (!practiceSession) return;
  const { player } = practiceSession;
  if (player.paused) {
    player.play();
    playPauseBtn.textContent = 'Pause';
  } else {
    player.pause();
    playPauseBtn.textContent = 'Play';
  }
});

viewAttemptsBtn.addEventListener('click', async () => {
  if (!practiceSession) return;
  attemptsTitleEl.textContent = practiceTitleEl.textContent;
  pendingDeleteAttemptId = null;
  expandedDayKeys = new Set();
  switchView('attempts');
  await renderAttemptsList(practiceSession.songId);
});

attemptsBackBtn.addEventListener('click', () => {
  // practiceSession (player, visualizer, accuracy tracker, etc.) is left
  // running untouched — this is a drill-down from Practice, not a
  // navigation away from the song, so there's nothing to tear down.
  switchView('practice');
});

window.addEventListener('resize', () => {
  if (practiceSession) practiceSession.visualizer.resize();
});

async function init() {
  wireTabbar();
  wireSettings();
  registerServiceWorker();
  await loadSettings();
  await renderLibrary();
}

init();
