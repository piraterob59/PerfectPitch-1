// Canvas 2D scrolling pitch-roll (Rock Band/Yousician-style): target pitch
// drawn as a ribbon from the stored timeline, live mic pitch drawn as a
// trailing color-coded line once mic.js is wired in. x maps time linearly;
// y maps pitch linearly in semitones (reads more naturally than linear Hz).

import { centsOffPitch, interpolateTargetMidi as interpolateTargetMidiShared, pitchTier, TIER_COLOR, MAX_INTERPOLATION_GAP_SEC, MAX_SCOREABLE_CENTS_OFF } from './note-utils.js';

const WINDOW_SEC = 6;
const NOW_FRAC = 0.3; // "now" line sits 30% in from the left
const LIVE_TRAIL_SEC = 2;
// The yellow/red boundary is fixed at 50 cents (see note-utils.js's
// pitchTier), same as scoring; red has no such fixed outer edge there
// (anything beyond 50 cents is just "red", however far), so this gives the
// red band a finite width to draw — as wide again as yellow's, an
// arbitrary but proportionate choice rather than a real threshold.
const RED_BAND_EXTRA_CENTS = 50;
// Reserved vertical strip at the bottom of the canvas, exclusively for
// lyric cue text. The ribbon's pitch-to-y mapping is compressed to end
// above this strip (see midiToY), so the ribbon can never physically enter
// it no matter how the pitch curves — a fixed offset near each cue's own
// point isn't enough, since text has width and the curve can dip lower at
// the text's edges than it does at the cue's exact timestamp.
const LYRIC_BAND_HEIGHT = 32;
// Padding (in semitones) added above/below the visible window's own
// min/max target pitch, and the smallest total vertical span ever shown
// even when the visible melody is nearly flat — without a floor, a flat
// stretch would zoom in so tight the band fills the whole height with no
// margin and the reference gridlines lose all meaning.
const VERTICAL_PADDING_SEMITONES = 2;
const MIN_VERTICAL_RANGE_SEMITONES = 8;

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

  // Fallback range shown only before the first real render() call ever
  // runs (or if a frame's visible window happens to contain zero points) —
  // render() itself recomputes these from just the currently-visible
  // window each frame, not the whole song, so the target band always
  // reads at a legible size regardless of how wide the song's overall
  // vocal range is.
  let minMidi = 55;
  let maxMidi = 79;
  if (points.length) {
    const midis = points.map((p) => p.midi);
    minMidi = Math.floor(Math.min(...midis) - VERTICAL_PADDING_SEMITONES);
    maxMidi = Math.ceil(Math.max(...midis) + VERTICAL_PADDING_SEMITONES);
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

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function setTolerance(cents) {
    toleranceGreenCents = cents;
  }

  function pushLiveSample(timeSec, freqHz, confidence) {
    liveSamples.push({ timeSec, freqHz, confidence });
    const cutoff = timeSec - LIVE_TRAIL_SEC - 1;
    while (liveSamples.length && liveSamples[0].timeSec < cutoff) liveSamples.shift();
  }

  // Drops the live pitch trail entirely — used when discarding the current
  // take (see app.js's Reset button) so old dots don't linger over a
  // rewound, about-to-restart attempt.
  function clearLiveSamples() {
    liveSamples = [];
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

    const rangeStart = nowSec - WINDOW_SEC * NOW_FRAC;
    const rangeEnd = nowSec + WINDOW_SEC * (1 - NOW_FRAC);

    // Re-centers the vertical range on just what's currently visible each
    // frame (mirroring how the x-axis already shows a moving window, not
    // the whole song) — otherwise a song whose melody ranges widely over
    // its full length would permanently squeeze every moment's target band
    // into a sliver of the available height. Left unchanged (not reset to
    // the whole-song fallback) when nothing's in view right now — e.g. a
    // silence gap mid-window — so the graph doesn't jump on every gap.
    const visibleMidis = points
      .filter((p) => p.timeSec >= rangeStart - 0.5 && p.timeSec <= rangeEnd + 0.5)
      .map((p) => p.midi);
    if (visibleMidis.length) {
      let lo = Math.min(...visibleMidis) - VERTICAL_PADDING_SEMITONES;
      let hi = Math.max(...visibleMidis) + VERTICAL_PADDING_SEMITONES;
      if (hi - lo < MIN_VERTICAL_RANGE_SEMITONES) {
        const mid = (lo + hi) / 2;
        lo = mid - MIN_VERTICAL_RANGE_SEMITONES / 2;
        hi = mid + MIN_VERTICAL_RANGE_SEMITONES / 2;
      }
      minMidi = Math.floor(lo);
      maxMidi = Math.ceil(hi);
    }

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

    // Target pitch band: three nested colored corridors (red outermost,
    // green innermost) following the target curve, widths driven by the
    // same tolerance tiers scoring.js grades the live dots against — so
    // "am I inside the green?" is answerable by eye, not just by the dot
    // color. Drawn widest-to-narrowest so each narrower fill overpaints the
    // middle of the one before it, leaving nested bands rather than
    // stacked-alpha overlap.

    function drawPitchBand(halfWidthSemitones, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      let top = [];
      let bottom = [];
      const flushSegment = () => {
        if (top.length >= 2) {
          ctx.moveTo(top[0][0], top[0][1]);
          for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
          for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1]);
          ctx.closePath();
        }
        top = [];
        bottom = [];
      };
      let lastTimeSec = null;
      for (const p of points) {
        if (p.timeSec < rangeStart - 0.5 || p.timeSec > rangeEnd + 0.5) { flushSegment(); lastTimeSec = null; continue; }
        // A gap this wide is real silence in the target vocal (see
        // note-utils.js's MAX_INTERPOLATION_GAP_SEC) — break the band here
        // instead of drawing a straight edge across it, so the band never
        // implies a target pitch where scoring itself says there isn't one.
        if (lastTimeSec !== null && p.timeSec - lastTimeSec > MAX_INTERPOLATION_GAP_SEC) flushSegment();
        const x = timeToX(p.timeSec, nowSec, w);
        top.push([x, midiToY(p.midi + halfWidthSemitones, h)]);
        bottom.push([x, midiToY(p.midi - halfWidthSemitones, h)]);
        lastTimeSec = p.timeSec;
      }
      flushSegment();
      ctx.fill();
    }

    const greenHalfWidth = toleranceGreenCents / 100;
    const yellowHalfWidth = 50 / 100; // fixed boundary, matches pitchTier()
    const redHalfWidth = yellowHalfWidth + RED_BAND_EXTRA_CENTS / 100;
    drawPitchBand(redHalfWidth, hexToRgba(TIER_COLOR.red, 0.35));
    drawPitchBand(yellowHalfWidth, hexToRgba(TIER_COLOR.yellow, 0.45));
    drawPitchBand(greenHalfWidth, hexToRgba(TIER_COLOR.green, 0.55));

    // "now" line — drawn after the (semi-transparent) band so it stays
    // fully bright where it crosses it, not dulled by the fill underneath.
    const nowX = NOW_FRAC * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    // Lyric cues: rendered inside the reserved LYRIC_BAND_HEIGHT strip at
    // the bottom, horizontally aligned with the moment they occur (same
    // timeToX as the ribbon) but at a fixed height, not tied to the cue's
    // pitch — see the LYRIC_BAND_HEIGHT comment for why a pitch-linked
    // height couldn't reliably avoid overlapping the ribbon.
    //
    // Left-aligned, not centered: with textAlign 'center', a cue's text
    // straddles its timestamp — so a longer phrase visually starts earlier
    // (and a short one later) than the timestamp it's actually anchored to,
    // by however many pixels half its own width happens to be. Left-align
    // makes the text's leading edge land exactly on timeSec regardless of
    // its length, so what you see lines up with the number in the cue list.
    ctx.fillStyle = '#f2f3f5';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
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
      let color = '#9aa1ab';
      if (targetMidi !== null) {
        const cents = centsOffPitch(s.freqHz, targetMidi);
        // Matches scoring.js's own cutoff (see MAX_SCOREABLE_CENTS_OFF) —
        // a sample this far off isn't scored, so it isn't drawn either,
        // rather than cluttering the graph with likely noise/octave-error
        // dots that don't correspond to anything the score reflects.
        if (Math.abs(cents) > MAX_SCOREABLE_CENTS_OFF) continue;
        color = liveColorForCents(cents);
      }
      const x = timeToX(s.timeSec, nowSec, w);
      const y = midiToY(69 + 12 * Math.log2(s.freqHz / 440), h);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  resize();

  return { resize, render, pushLiveSample, clearLiveSamples, addLyricCue, removeLyricCue, updateLyricCueText, setTolerance };
}
