// Canvas 2D scrolling pitch-roll (Rock Band/Yousician-style): target pitch
// drawn as a ribbon from the stored timeline, live mic pitch drawn as a
// trailing color-coded line once mic.js is wired in. x maps time linearly;
// y maps pitch linearly in semitones (reads more naturally than linear Hz).

import { centsOffPitch, interpolateTargetMidi as interpolateTargetMidiShared, pitchTier, TIER_COLOR } from './note-utils.js';

const WINDOW_SEC = 6;
const NOW_FRAC = 0.3; // "now" line sits 30% in from the left
const LIVE_TRAIL_SEC = 2;
// Reserved vertical strip at the bottom of the canvas, exclusively for
// lyric cue text. The ribbon's pitch-to-y mapping is compressed to end
// above this strip (see midiToY), so the ribbon can never physically enter
// it no matter how the pitch curves — a fixed offset near each cue's own
// point isn't enough, since text has width and the curve can dip lower at
// the text's edges than it does at the cue's exact timestamp.
const LYRIC_BAND_HEIGHT = 32;

export function createVisualizer(canvasEl, { pitchTimeline, lyricCues = [], toleranceCents = 5 }) {
  const ctx = canvasEl.getContext('2d');
  const points = (pitchTimeline?.points || []).filter((p) => p.freqHz !== null);
  // { timeSec, text } — user-entered (see db.js's lyricCues store), sorted
  // so render() can scan them in time order alongside the pitch points.
  const cues = [...lyricCues].sort((a, b) => a.timeSec - b.timeSec);
  // The Settings tolerance slider's green-band threshold — same value
  // scoring.js uses, so a dot's color always matches whether it actually
  // counted as a hit. Mutable via setTolerance() for live Settings changes.
  let toleranceGreenCents = toleranceCents;

  let minMidi = 55;
  let maxMidi = 79;
  if (points.length) {
    const midis = points.map((p) => p.midi);
    minMidi = Math.floor(Math.min(...midis) - 2);
    maxMidi = Math.ceil(Math.max(...midis) + 2);
  }

  let liveSamples = []; // { timeSec, freqHz, confidence }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(rect.width * dpr));
    canvasEl.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function midiToY(midi, heightCss) {
    const t = (midi - minMidi) / (maxMidi - minMidi);
    const usable = heightCss - LYRIC_BAND_HEIGHT;
    return usable - t * usable;
  }

  function timeToX(t, nowSec, widthCss) {
    return NOW_FRAC * widthCss + (t - nowSec) * (widthCss / WINDOW_SEC);
  }

  // Coloring the live pitch dot needs the same target-pitch interpolation
  // scoring.js uses to grade it, so it's shared via note-utils.js.
  function interpolateTargetMidi(t) {
    return interpolateTargetMidiShared(points, t);
  }

  function liveColorForCents(cents) {
    return TIER_COLOR[pitchTier(cents, toleranceGreenCents)];
  }

  function setTolerance(cents) {
    toleranceGreenCents = cents;
  }

  function pushLiveSample(timeSec, freqHz, confidence) {
    liveSamples.push({ timeSec, freqHz, confidence });
    const cutoff = timeSec - LIVE_TRAIL_SEC - 1;
    while (liveSamples.length && liveSamples[0].timeSec < cutoff) liveSamples.shift();
  }

  // Inserts a newly-added cue in time order without needing to rebuild the
  // visualizer, so the "add cue" button in app.js can call this directly.
  // `id` matches the cue's id in db.js's lyricCues store, so a later
  // removeLyricCue(id) call can find and drop the right one.
  function addLyricCue(id, timeSec, text) {
    const idx = cues.findIndex((c) => c.timeSec > timeSec);
    const entry = { id, timeSec, text };
    if (idx === -1) cues.push(entry); else cues.splice(idx, 0, entry);
  }

  function removeLyricCue(id) {
    const idx = cues.findIndex((c) => c.id === id);
    if (idx !== -1) cues.splice(idx, 1);
  }

  function updateLyricCueText(id, text) {
    const cue = cues.find((c) => c.id === id);
    if (cue) cue.text = text;
  }

  function render(nowSec) {
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Faint reference lines every 2 semitones so the ribbon has legible context.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let m = Math.ceil(minMidi / 2) * 2; m <= maxMidi; m += 2) {
      const y = midiToY(m, h);
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }

    // "now" line.
    const nowX = NOW_FRAC * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    // Target pitch ribbon.
    const rangeStart = nowSec - WINDOW_SEC * NOW_FRAC;
    const rangeEnd = nowSec + WINDOW_SEC * (1 - NOW_FRAC);
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    let drawing = false;
    for (const p of points) {
      if (p.timeSec < rangeStart - 0.5 || p.timeSec > rangeEnd + 0.5) { drawing = false; continue; }
      const x = timeToX(p.timeSec, nowSec, w);
      const y = midiToY(p.midi, h);
      if (!drawing) { ctx.moveTo(x, y); drawing = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    // Lyric cues: rendered inside the reserved LYRIC_BAND_HEIGHT strip at
    // the bottom, horizontally aligned with the moment they occur (same
    // timeToX as the ribbon) but at a fixed height, not tied to the cue's
    // pitch — see the LYRIC_BAND_HEIGHT comment for why a pitch-linked
    // height couldn't reliably avoid overlapping the ribbon.
    ctx.fillStyle = '#f2f3f5';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const cue of cues) {
      if (cue.timeSec < rangeStart || cue.timeSec > rangeEnd) continue;
      const x = timeToX(cue.timeSec, nowSec, w);
      ctx.fillText(cue.text, x, h - 8);
    }
    ctx.textBaseline = 'alphabetic';

    // Live pitch trail, color-coded by how far off the target it is.
    for (const s of liveSamples) {
      if (s.freqHz === null || s.timeSec < rangeStart) continue;
      const targetMidi = interpolateTargetMidi(s.timeSec);
      const x = timeToX(s.timeSec, nowSec, w);
      const y = midiToY(69 + 12 * Math.log2(s.freqHz / 440), h);
      const color = targetMidi === null ? '#9aa1ab' : liveColorForCents(centsOffPitch(s.freqHz, targetMidi));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  resize();

  return { resize, render, pushLiveSample, addLyricCue, removeLyricCue, updateLyricCueText, setTolerance };
}
