// Canvas 2D scrolling pitch-roll (Rock Band/Yousician-style): target pitch
// drawn as a ribbon from the stored timeline, live mic pitch drawn as a
// trailing color-coded line once mic.js is wired in. x maps time linearly;
// y maps pitch linearly in semitones (reads more naturally than linear Hz).

import { centsOffPitch, interpolateTargetMidi as interpolateTargetMidiShared, pitchTier, TIER_COLOR, MAX_INTERPOLATION_GAP_SEC, MAX_SCOREABLE_CENTS_OFF, estimateWordTimes } from './note-utils.js';
import { SECONDARY_YIN_THRESHOLD } from './pitch.js';

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
// matter how the pitch curves. Lyrics are drawn as one row within it (see
// the lyric ticker in render()).
const LYRIC_BAND_HEIGHT = 92;
// The offline analyzer's YIN detector accepts a point down to
// SECONDARY_YIN_THRESHOLD (see pitch.js) when nothing clears its
// stricter primary threshold — a harmony/backing vocal sharing the frame
// with the lead is exactly when that fallback kicks in — so no accepted
// point's confidence (1 - dip) ever falls below this floor. A genuinely
// solo, clean vocal frame sits near the top of this [floor, 1] band; a
// frame only the secondary threshold rescued sits at the bottom. Mapped to
// alpha below so the target band visibly dims exactly where the reference
// pitch is least trustworthy, instead of either drawing every accepted
// frame at equal, unearned confidence, or dropping it as a gap.
const CONFIDENCE_FLOOR = 1 - SECONDARY_YIN_THRESHOLD;
const CONFIDENCE_DIM_ALPHA_SCALE = 0.3; // fill alpha at the confidence floor, as a fraction of full
// Quantizing into a handful of alpha steps groups nearby-confidence frames
// into one fill() path instead of one per ~10ms point — real audio's
// confidence is locally correlated, so this keeps the per-frame canvas cost
// low (a few dozen fills per band, not hundreds) while still tracking real
// swings in how trustworthy the target pitch is.
const CONFIDENCE_ALPHA_STEPS = 6;

function confidenceAlphaScale(confidence) {
  const norm = Math.max(0, Math.min(1, ((confidence ?? 1) - CONFIDENCE_FLOOR) / (1 - CONFIDENCE_FLOOR)));
  return CONFIDENCE_DIM_ALPHA_SCALE + norm * (1 - CONFIDENCE_DIM_ALPHA_SCALE);
}
// Section lyrics are a single-row "ticker": every word in one font size at
// its natural width, laid out in reading order, and scrolled at whatever speed
// keeps the word being sung right at the "now" line. Placing words at their
// true times on the graph's own scale doesn't work -- sung words arrive
// faster than they fit side by side at that scale -- so instead the line
// moves faster through quick passages and slower through held notes, and the
// word under the "now" line is always the one being sung. Words already sung
// are green, ones still to come are gray.
const LYRIC_FONT_PX = 36;
const LYRIC_WORD_GAP_PX = 12;
const LYRIC_SECTION_GAP_PX = 32;
const LYRIC_UPCOMING_COLOR = '#6b7280';
const SECTION_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, sans-serif';

export function createVisualizer(canvasEl, { pitchTimeline, secondaryTimeline = null, lyricTimeline = pitchTimeline, sections = [], toleranceCents = 5 }) {
  const ctx = canvasEl.getContext('2d');
  // Number.isFinite(p.midi) matters, not just freqHz !== null: minMidi/
  // maxMidi below take Math.min/max across every point's midi in one pass,
  // and a single NaN (or Infinity) poisons that whole computation to NaN —
  // which then makes midiToY() return NaN for literally every point, so
  // the entire band vanishes for the whole song, not just near the bad
  // sample. Confirmed live from one corrupted frame reaching this far.
  const usablePoints = (timeline) => (timeline?.points || []).filter((p) => p.freqHz !== null && Number.isFinite(p.midi));
  // `points` is the line being sung against (drawn as the colored band and
  // used to grade live dots); `secondaryPoints` is the other part of a
  // lead/harmony split, drawn as a faint reference line. Swapped via
  // setParts().
  let points = usablePoints(pitchTimeline);
  let secondaryPoints = usablePoints(secondaryTimeline);
  // { id, startSec, endSec, text } — user-marked (see db.js's sections
  // store), sorted so render() can scan them in order alongside the pitch
  // points. Each section's best-fit text layout is cached in
  // sectionLayouts (see computeSectionLayout) rather than recomputed every
  // render() frame, since it only depends on the section's own duration and
  // text, not on playback position or scroll.
  let sectionList = [...sections].sort((a, b) => a.startSec - b.startSec);
  const sectionLayouts = new Map(); // id -> { words: [{ text, startSec, naturalW }] }
  // Every section's words in time order with their x offset along the ticker
  // (px from the first word's left edge) -- see layoutLyrics.
  let lyricWords = [];
  // Word timing follows the lead vocal regardless of which part is being sung
  // against, so it's fixed at construction and never swapped by setParts().
  const lyricPoints = (lyricTimeline?.points || []).filter((p) => p.freqHz !== null && Number.isFinite(p.midi));
  // The Settings tolerance slider's green-band threshold — same value
  // scoring.js uses, so a dot's color always matches whether it actually
  // counted as a hit. Mutable via setTolerance() for live Settings changes.
  let toleranceGreenCents = toleranceCents;

  let minMidi = 55;
  let maxMidi = 79;
  // Sized to both lines, so switching which one is "primary" never moves
  // the vertical scale.
  function computeRange() {
    const all = points.concat(secondaryPoints);
    if (!all.length) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of all) { if (p.midi < lo) lo = p.midi; if (p.midi > hi) hi = p.midi; }
    minMidi = Math.floor(lo - 2);
    maxMidi = Math.ceil(hi + 2);
  }
  computeRange();

  function setParts(primaryTimeline, secondary) {
    points = usablePoints(primaryTimeline);
    secondaryPoints = usablePoints(secondary);
    computeRange();
  }

  let liveSamples = []; // { timeSec, freqHz, confidence }

  // Each word's estimated start time only depends on the section's own text,
  // bounds, and the pitch curve -- not on playback position or scroll -- and
  // its width only on the font, so both are computed once here rather than
  // every render() frame, and redone only when the section's text/bounds
  // change or the canvas resizes.
  function computeSectionLayout(section) {
    ctx.font = `bold ${LYRIC_FONT_PX}px ${SECTION_FONT_FAMILY}`;
    const words = estimateWordTimes(section.text || '', section.startSec, section.endSec, lyricPoints)
      .map((wd, i) => ({ text: wd.text, startSec: wd.startSec, endSec: wd.endSec, naturalW: ctx.measureText(wd.text).width, firstInSection: i === 0 }));
    return { words };
  }

  // Flattens every section's words into one time-ordered list and gives each
  // its x offset along the ticker: each word starts after the previous one's
  // width plus a gap (wider between sections). Independent of the canvas
  // size, so only redone when sections change.
  function layoutLyrics() {
    const all = [];
    for (const section of sectionList) {
      const layout = sectionLayouts.get(section.id);
      if (layout) all.push(...layout.words);
    }
    all.sort((a, b) => a.startSec - b.startSec);
    let x = 0;
    lyricWords = all.map((wd, i) => {
      if (i > 0) x += all[i - 1].naturalW + (wd.firstInSection ? LYRIC_SECTION_GAP_PX : LYRIC_WORD_GAP_PX);
      return { text: wd.text, startSec: wd.startSec, endSec: wd.endSec, naturalW: wd.naturalW, x0: x };
    });
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(rect.width * dpr));
    canvasEl.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const section of sectionList) sectionLayouts.set(section.id, computeSectionLayout(section));
    layoutLyrics();
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
    layoutLyrics();
  }

  function removeSection(id) {
    sectionList = sectionList.filter((s) => s.id !== id);
    sectionLayouts.delete(id);
    layoutLyrics();
  }

  function updateSectionText(id, text) {
    const section = sectionList.find((s) => s.id === id);
    if (section) {
      section.text = text;
      sectionLayouts.set(id, computeSectionLayout(section));
      layoutLyrics();
    }
  }

  function updateSectionBounds(id, startSec, endSec) {
    const section = sectionList.find((s) => s.id === id);
    if (section) {
      section.startSec = startSec;
      section.endSec = endSec;
      sectionList.sort((a, b) => a.startSec - b.startSec);
      sectionLayouts.set(id, computeSectionLayout(section));
      layoutLyrics();
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

    function drawPitchBand(halfWidthSemitones, colorHex, baseAlpha) {
      let top = [];
      let bottom = [];
      let segmentBucket = null;
      const flushSegment = () => {
        if (top.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(top[0][0], top[0][1]);
          for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
          for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1]);
          ctx.closePath();
          ctx.fillStyle = hexToRgba(colorHex, baseAlpha * (segmentBucket / CONFIDENCE_ALPHA_STEPS));
          ctx.fill();
        }
      };
      let lastTimeSec = null;
      for (const p of points) {
        const inRange = p.timeSec >= rangeStart - 0.5 && p.timeSec <= rangeEnd + 0.5;
        // A gap this wide is real silence in the target vocal (see
        // note-utils.js's MAX_INTERPOLATION_GAP_SEC) — break the band here
        // instead of drawing a straight edge across it, so the band never
        // implies a target pitch where scoring itself says there isn't one.
        const isGap = lastTimeSec !== null && p.timeSec - lastTimeSec > MAX_INTERPOLATION_GAP_SEC;
        if (!inRange || isGap) {
          flushSegment();
          top = [];
          bottom = [];
          segmentBucket = null;
          lastTimeSec = null;
          if (!inRange) continue;
        }
        const bucket = Math.round(confidenceAlphaScale(p.confidence) * CONFIDENCE_ALPHA_STEPS);
        if (segmentBucket !== null && bucket !== segmentBucket) {
          // Close out the previous run, then re-seed the new one with the
          // shared boundary point so adjacent alpha segments share an edge
          // exactly, instead of leaving a hairline gap where the fill
          // alpha steps.
          flushSegment();
          top = [top[top.length - 1]];
          bottom = [bottom[bottom.length - 1]];
        }
        segmentBucket = bucket;
        const x = timeToX(p.timeSec, nowSec, w);
        top.push([x, midiToY(p.midi + halfWidthSemitones, h)]);
        bottom.push([x, midiToY(p.midi - halfWidthSemitones, h)]);
        lastTimeSec = p.timeSec;
      }
      flushSegment();
    }

    const greenHalfWidth = toleranceGreenCents / 100;
    const yellowHalfWidth = 50 / 100; // fixed boundary, matches pitchTier()
    const redHalfWidth = yellowHalfWidth + RED_BAND_EXTRA_CENTS / 100;
    drawPitchBand(redHalfWidth, TIER_COLOR.red, 0.35);
    drawPitchBand(yellowHalfWidth, TIER_COLOR.yellow, 0.45);
    drawPitchBand(greenHalfWidth, TIER_COLOR.green, 0.55);

    // The other part of a lead/harmony split, as a faint dashed line so it
    // reads as context, not as something being scored.
    if (secondaryPoints.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(124, 58, 237, 0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      let pen = false;
      let lastT = null;
      ctx.beginPath();
      for (const p of secondaryPoints) {
        if (p.timeSec < rangeStart - 0.5) continue;
        if (p.timeSec > rangeEnd + 0.5) break;
        const x = timeToX(p.timeSec, nowSec, w);
        const y = midiToY(p.midi, h);
        if (!pen || p.timeSec - lastT > MAX_INTERPOLATION_GAP_SEC) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        pen = true;
        lastT = p.timeSec;
      }
      ctx.stroke();
      ctx.restore();
    }

    // "now" line — drawn after the (semi-transparent) band so it stays
    // fully bright where it crosses it, not dulled by the fill underneath.
    const nowX = NOW_FRAC * w;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    // Lyric ticker (see LYRIC_FONT_PX): find the word being sung, and scroll
    // the whole line so that word's left edge is at the "now" line, easing
    // toward the next word's left edge as this one's sung time runs out.
    if (lyricWords.length) {
      let cur = -1;
      let lo = 0;
      let hi = lyricWords.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lyricWords[mid].startSec <= nowSec) { cur = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      let scroll;
      if (cur === -1) {
        scroll = lyricWords[0].x0; // before the first word: it waits at the now line
      } else {
        const wd = lyricWords[cur];
        const next = lyricWords[cur + 1];
        const f = Math.max(0, Math.min(1, (nowSec - wd.startSec) / Math.max(0.05, wd.endSec - wd.startSec)));
        scroll = wd.x0 + f * ((next ? next.x0 : wd.x0 + wd.naturalW) - wd.x0);
      }
      ctx.font = `bold ${LYRIC_FONT_PX}px ${SECTION_FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const lyricY = h - LYRIC_BAND_HEIGHT + (LYRIC_BAND_HEIGHT - LYRIC_FONT_PX * 1.2) / 2;
      const originX = NOW_FRAC * w - scroll;
      const first = Math.max(0, (cur === -1 ? 0 : cur) - 40); // a generous bound; off-screen words are skipped below
      for (let i = first; i < lyricWords.length; i++) {
        const wd = lyricWords[i];
        const x = originX + wd.x0;
        if (x > w) break;
        if (x + wd.naturalW < 0) continue;
        ctx.fillStyle = i <= cur ? TIER_COLOR.green : LYRIC_UPCOMING_COLOR;
        ctx.fillText(wd.text, x, lyricY);
      }
      ctx.textBaseline = 'alphabetic';
    }

    // Live pitch trail, color-coded by how far off the target it is.
    for (const s of liveSamples) {
      if (s.freqHz === null || s.timeSec < rangeStart) continue;
      const targetMidi = interpolateTargetMidi(s.timeSec);
      let color = '#9aa1ab';
      // Defaults to the singer's own true pitch (used as-is when there's no
      // target here at all); overridden below to the octave-aligned pitch
      // whenever a target exists, so the dot visually sits inside the
      // colored band it matches rather than at the singer's actual octave,
      // which the graph's own vertical range (sized to the target melody's
      // register) may not even show.
      let displayMidi = 69 + 12 * Math.log2(s.freqHz / 440);
      if (targetMidi !== null) {
        // Octave-invariant (see centsOffPitch) — matches scoring.js's own
        // comparison, so a note drawn/colored as "on pitch" here is exactly
        // one scoring.js would count as a hit.
        const cents = centsOffPitch(s.freqHz, targetMidi);
        // Matches scoring.js's own cutoff (see MAX_SCOREABLE_CENTS_OFF) —
        // a sample this far off isn't scored, so it isn't drawn either,
        // rather than cluttering the graph with mic noise or genuinely
        // wrong notes that don't correspond to anything the score reflects.
        if (Math.abs(cents) > MAX_SCOREABLE_CENTS_OFF) continue;
        color = liveColorForCents(cents);
        displayMidi = targetMidi + cents / 100;
      }
      const x = timeToX(s.timeSec, nowSec, w);
      const y = midiToY(displayMidi, h);
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
    setTolerance, setParts,
  };
}
