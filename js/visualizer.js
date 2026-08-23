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
// Reserved vertical strip at the bottom of the canvas, for section lyric
// text. The ribbon's pitch-to-y mapping is compressed to end above this
// strip (see midiToY), so the ribbon can never physically enter it no
// matter how the pitch curves. Sized for two lines at MAX_SECTION_FONT_PX
// plus a little padding — see computeSectionLayout for how a section's
// actual font size is chosen within that budget.
const LYRIC_BAND_HEIGHT = 92;
const MAX_SECTION_FONT_PX = 32;
const MIN_SECTION_FONT_PX = 12;
const SECTION_LINE_HEIGHT_RATIO = 1.2;
const SECTION_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, sans-serif';

// Greedy word-wrap: adds words to the current line until one would exceed
// maxWidthPx, then starts a new line. A single word wider than maxWidthPx
// still gets its own line (better to overflow slightly than drop text).
function wrapTextToLines(ctx, text, maxWidthPx) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(attempt).width <= maxWidthPx) {
      current = attempt;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Picks the largest font size (within [MIN_SECTION_FONT_PX,
// MAX_SECTION_FONT_PX]) that wraps `text` into at most 2 lines each fitting
// maxWidthPx — "as big as possible to fit in no more than two rows", per
// the actual request this implements. Falls back to the smallest size
// (however many lines that takes) only in the rare case even that doesn't
// fit in 2 — very long text in a very short section.
function fitSectionText(ctx, text, maxWidthPx) {
  if (!text) return { fontPx: MAX_SECTION_FONT_PX, lines: [] };
  for (let fontPx = MAX_SECTION_FONT_PX; fontPx >= MIN_SECTION_FONT_PX; fontPx -= 1) {
    ctx.font = `bold ${fontPx}px ${SECTION_FONT_FAMILY}`;
    const lines = wrapTextToLines(ctx, text, maxWidthPx);
    if (lines.length <= 2) return { fontPx, lines };
  }
  ctx.font = `bold ${MIN_SECTION_FONT_PX}px ${SECTION_FONT_FAMILY}`;
  return { fontPx: MIN_SECTION_FONT_PX, lines: wrapTextToLines(ctx, text, maxWidthPx) };
}

export function createVisualizer(canvasEl, { pitchTimeline, sections = [], toleranceCents = 5 }) {
  const ctx = canvasEl.getContext('2d');
  const points = (pitchTimeline?.points || []).filter((p) => p.freqHz !== null);
  // { id, startSec, endSec, text } — user-marked (see db.js's sections
  // store), sorted so render() can scan them in order alongside the pitch
  // points. Each section's best-fit text layout is cached in
  // sectionLayouts (see computeSectionLayout) rather than recomputed every
  // render() frame, since it only depends on the section's own duration and
  // text, not on playback position or scroll.
  let sectionList = [...sections].sort((a, b) => a.startSec - b.startSec);
  const sectionLayouts = new Map(); // id -> { fontPx, lines }
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

  // A section's on-screen width is constant regardless of scroll position —
  // only its x offset moves as it scrolls through the window — since it's
  // purely a function of its duration and the fixed time-to-pixel scale.
  // So the best-fit font size only needs recomputing when the section's own
  // bounds/text change, or the canvas resizes, never per render() frame.
  function computeSectionLayout(section) {
    const widthCss = canvasEl.getBoundingClientRect().width;
    const pxPerSec = widthCss / WINDOW_SEC;
    // Capped at the canvas's own width: a section longer than WINDOW_SEC is
    // never fully on-screen at once regardless of font size, so sizing text
    // to its full duration would just pick a huge font that's mostly
    // clipped off-canvas at any given moment. Capping means even a long
    // section gets text sized to actually fit one screenful.
    const sectionWidthPx = Math.max(10, Math.min((section.endSec - section.startSec) * pxPerSec, widthCss));
    return fitSectionText(ctx, section.text || '', sectionWidthPx);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(rect.width * dpr));
    canvasEl.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const section of sectionList) sectionLayouts.set(section.id, computeSectionLayout(section));
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

  // Inserts a newly-marked section in start-time order without needing to
  // rebuild the visualizer, so app.js's "Mark Section End" handler can call
  // this directly right after saving it to the sections store.
  function addSection(section) {
    const idx = sectionList.findIndex((s) => s.startSec > section.startSec);
    if (idx === -1) sectionList.push(section); else sectionList.splice(idx, 0, section);
    sectionLayouts.set(section.id, computeSectionLayout(section));
  }

  function removeSection(id) {
    sectionList = sectionList.filter((s) => s.id !== id);
    sectionLayouts.delete(id);
  }

  function updateSectionText(id, text) {
    const section = sectionList.find((s) => s.id === id);
    if (section) {
      section.text = text;
      sectionLayouts.set(id, computeSectionLayout(section));
    }
  }

  function updateSectionBounds(id, startSec, endSec) {
    const section = sectionList.find((s) => s.id === id);
    if (section) {
      section.startSec = startSec;
      section.endSec = endSec;
      sectionList.sort((a, b) => a.startSec - b.startSec);
      sectionLayouts.set(id, computeSectionLayout(section));
    }
  }

  function render(nowSec) {
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const rangeStart = nowSec - WINDOW_SEC * NOW_FRAC;
    const rangeEnd = nowSec + WINDOW_SEC * (1 - NOW_FRAC);

    // Faint reference lines every 2 semitones so the ribbon has legible context.
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
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
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    // Section lyric text: shown for a section's entire on-screen span, not
    // just an instant — unlike the old point-in-time cues this replaced —
    // sized once per section (see computeSectionLayout) to the largest font
    // that wraps to <=2 lines within the section's own fixed width, so it
    // never jitters in size as the section scrolls through the window.
    //
    // Left-aligned starting at the section's own start-x, not centered:
    // the section's width was exactly what the font size was fit to, so
    // left-aligning keeps every line's leading edge inside that width
    // rather than needing separate centering math per line.
    ctx.fillStyle = TIER_COLOR.green;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const section of sectionList) {
      if (section.endSec < rangeStart || section.startSec > rangeEnd) continue;
      const layout = sectionLayouts.get(section.id);
      if (!layout || !layout.lines.length) continue;
      const x = timeToX(section.startSec, nowSec, w);
      ctx.font = `bold ${layout.fontPx}px ${SECTION_FONT_FAMILY}`;
      const lineHeight = layout.fontPx * SECTION_LINE_HEIGHT_RATIO;
      const blockHeight = layout.lines.length * lineHeight;
      const bandTop = h - LYRIC_BAND_HEIGHT;
      const startY = bandTop + Math.max(0, (LYRIC_BAND_HEIGHT - blockHeight) / 2);
      layout.lines.forEach((line, i) => ctx.fillText(line, x, startY + i * lineHeight));
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

  return {
    resize, render, pushLiveSample, clearLiveSamples,
    addSection, removeSection, updateSectionText, updateSectionBounds,
    setTolerance,
  };
}
