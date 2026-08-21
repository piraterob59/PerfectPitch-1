// Accuracy scoring: compares live mic pitch samples against the target
// pitch timeline, weighting each sample by the same green/yellow/red tier
// used to color its dot on the visualizer (see note-utils.js's pitchTier) —
// green counts full, yellow counts half, red counts nothing. The tier
// boundary itself is the Settings 5-50 cent slider.
// Deliberately independent from visualizer.js's own liveSamples array,
// which is trimmed to a short trailing window for rendering performance —
// scoring needs the full singing-session history, not just what's on screen.

import { centsOffPitch, interpolateTargetMidi, pitchTier, TIER_SCORE, MAX_SCOREABLE_CENTS_OFF } from './note-utils.js';

export function createAccuracyTracker(pitchTimeline, sections = [], { toleranceCents = 5, rollingWindowSec = 5 } = {}) {
  const points = (pitchTimeline?.points || []).filter((p) => p.freqHz !== null);
  let tolerance = toleranceCents;
  let sumScore = 0;
  let total = 0;
  // Same scored samples also kept here, timestamped, so getRollingAccuracy()
  // can report "how am I doing right now" without the cumulative average's
  // problem: as `total` grows across a whole song, each additional sample
  // moves sumScore/total less and less, so the number effectively freezes
  // a few bars in regardless of how singing changes afterward.
  let recentSamples = []; // { timeSec, score }
  // Per-section running sums, parallel to `sections` (see
  // note-utils.js's computeVocalSections) — kept for the attempt's whole
  // lifetime, not trimmed like recentSamples, so getSectionBreakdown() can
  // report a final per-section accuracy once singing stops.
  let sectionSums = sections.map(() => 0);
  let sectionCounts = sections.map(() => 0);

  function setTolerance(cents) {
    tolerance = cents;
  }

  // Sections are sorted and non-overlapping (computeVocalSections builds
  // them from a time-ordered points array), so a linear scan is simple and
  // cheap enough at this scale (a handful of sections per song).
  function sectionIndexFor(timeSec) {
    for (let i = 0; i < sections.length; i++) {
      if (timeSec >= sections[i].startSec && timeSec <= sections[i].endSec) return i;
    }
    return -1;
  }

  // Silent/unvoiced mic frames (freqHz: null) are skipped rather than
  // counted as misses — gaps between words shouldn't drag the score down.
  function addSample(timeSec, freqHz) {
    if (freqHz === null) return;
    const targetMidi = interpolateTargetMidi(points, timeSec);
    if (targetMidi === null) return;
    const cents = centsOffPitch(freqHz, targetMidi);
    // Wildly off (see MAX_SCOREABLE_CENTS_OFF) is excluded entirely, not
    // scored as a "red" miss — likely noise/an octave error, not a
    // genuine attempt, so it shouldn't count against the score either way.
    if (Math.abs(cents) > MAX_SCOREABLE_CENTS_OFF) return;
    const score = TIER_SCORE[pitchTier(cents, tolerance)];
    total++;
    sumScore += score;
    recentSamples.push({ timeSec, score });
    const sectionIdx = sectionIndexFor(timeSec);
    if (sectionIdx !== -1) {
      sectionSums[sectionIdx] += score;
      sectionCounts[sectionIdx]++;
    }
  }

  // Whole-percent accuracy across the entire session so far, or null if
  // nothing scoreable has come in yet (e.g. right after "Start Singing",
  // before any voiced sample lands).
  function getAccuracy() {
    return total > 0 ? Math.round((sumScore / total) * 100) : null;
  }

  // Whole-percent accuracy over just the last `rollingWindowSec` of
  // playback. Pruned against `nowSec` (the caller's current playback
  // position), not just each new sample's own timestamp — otherwise the
  // window would only shrink when new samples arrive, and stay stuck
  // showing an old score through a silent pause instead of emptying out.
  function getRollingAccuracy(nowSec) {
    const cutoff = nowSec - rollingWindowSec;
    while (recentSamples.length && recentSamples[0].timeSec < cutoff) recentSamples.shift();
    if (!recentSamples.length) return null;
    const sum = recentSamples.reduce((s, r) => s + r.score, 0);
    return Math.round((sum / recentSamples.length) * 100);
  }

  // Final per-section accuracy — one entry per input section, in the same
  // order, each { startSec, endSec, accuracyPct }. accuracyPct is null for
  // a section nothing scoreable ever landed in (e.g. the singer never
  // reached it), same null-means-"nothing yet" convention as getAccuracy().
  function getSectionBreakdown() {
    return sections.map((s, i) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      accuracyPct: sectionCounts[i] > 0 ? Math.round((sectionSums[i] / sectionCounts[i]) * 100) : null,
    }));
  }

  function reset() {
    sumScore = 0;
    total = 0;
    recentSamples = [];
    sectionSums = sections.map(() => 0);
    sectionCounts = sections.map(() => 0);
  }

  return { addSample, getAccuracy, getRollingAccuracy, getSectionBreakdown, setTolerance, reset };
}
