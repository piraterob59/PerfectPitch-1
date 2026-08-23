// Accuracy scoring: compares live mic pitch samples against the target
// pitch timeline, weighting each sample by the same green/yellow/red tier
// used to color its dot on the visualizer (see note-utils.js's pitchTier) —
// green counts full, yellow counts half, red counts nothing. The tier
// boundary itself is the Settings 5-50 cent slider.
// Deliberately independent from visualizer.js's own liveSamples array,
// which is trimmed to a short trailing window for rendering performance —
// scoring needs the full singing-session history, not just what's on screen.

import { centsOffPitch, interpolateTargetMidi, pitchTier, TIER_SCORE, MAX_SCOREABLE_CENTS_OFF } from './note-utils.js';

export function createAccuracyTracker(pitchTimeline, initialSections = [], { toleranceCents = 5, rollingWindowSec = 5 } = {}) {
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
  // One entry per section, each carrying its own running sum/count for the
  // attempt's whole lifetime (not trimmed like recentSamples) so
  // getSectionBreakdown() can report a final per-section accuracy once
  // singing stops. A single array of stat objects (not parallel arrays
  // alongside a separate `sections` list) specifically so addSection/
  // updateSectionBounds/removeSection below can't drift out of sync with
  // whatever they're tracking — there's only one array to keep correct.
  // Kept in sync with the Sections panel for the session's whole lifetime:
  // marking, retiming, relabeling, or deleting a section *after* Practice
  // was already open used to be invisible to scoring entirely (this array
  // was only ever built once, at construction) — confirmed live as the
  // cause of attempts missing sections from their breakdown.
  let sectionStats = initialSections
    .map((s) => ({ id: s.id, startSec: s.startSec, endSec: s.endSec, label: s.label, sumScore: 0, count: 0 }))
    .sort((a, b) => a.startSec - b.startSec);
  // Consecutive scoreable frames seen in a row, reset the instant one isn't
  // — a stray noise/hum blip is almost always isolated, while real singing
  // holds a note across many frames (~23ms apart, see mic.js's HOP_SIZE), so
  // requiring a short streak before counting anything filters out the blip
  // without meaningfully delaying real singing.
  let voicedStreak = 0;
  const REQUIRED_VOICED_STREAK = 3;

  function setTolerance(cents) {
    tolerance = cents;
  }

  function addSection(section) {
    sectionStats.push({ id: section.id, startSec: section.startSec, endSec: section.endSec, label: section.label, sumScore: 0, count: 0 });
    sectionStats.sort((a, b) => a.startSec - b.startSec);
  }

  function removeSection(id) {
    sectionStats = sectionStats.filter((s) => s.id !== id);
  }

  function updateSectionBounds(id, startSec, endSec) {
    const stat = sectionStats.find((s) => s.id === id);
    if (!stat) return;
    stat.startSec = startSec;
    stat.endSec = endSec;
    sectionStats.sort((a, b) => a.startSec - b.startSec);
  }

  function updateSectionLabel(id, label) {
    const stat = sectionStats.find((s) => s.id === id);
    if (stat) stat.label = label;
  }

  // sectionStats is kept sorted (see addSection/updateSectionBounds) and
  // non-overlapping (enforced when a section is saved — see app.js), so a
  // linear scan is simple and cheap enough at this scale (a handful of
  // sections per song).
  function sectionIndexFor(timeSec) {
    for (let i = 0; i < sectionStats.length; i++) {
      if (timeSec >= sectionStats[i].startSec && timeSec <= sectionStats[i].endSec) return i;
    }
    return -1;
  }

  // Silent/unvoiced mic frames (freqHz: null) are skipped rather than
  // counted as misses — gaps between words shouldn't drag the score down.
  function addSample(timeSec, freqHz) {
    if (freqHz === null) { voicedStreak = 0; return; }
    const targetMidi = interpolateTargetMidi(points, timeSec);
    if (targetMidi === null) { voicedStreak = 0; return; }
    const cents = centsOffPitch(freqHz, targetMidi);
    // Wildly off (see MAX_SCOREABLE_CENTS_OFF) is excluded entirely, not
    // scored as a "red" miss — likely noise/an octave error, not a
    // genuine attempt, so it shouldn't count against the score either way.
    if (Math.abs(cents) > MAX_SCOREABLE_CENTS_OFF) { voicedStreak = 0; return; }
    voicedStreak++;
    if (voicedStreak < REQUIRED_VOICED_STREAK) return;
    const score = TIER_SCORE[pitchTier(cents, tolerance)];
    total++;
    sumScore += score;
    recentSamples.push({ timeSec, score });
    const sectionIdx = sectionIndexFor(timeSec);
    if (sectionIdx !== -1) {
      sectionStats[sectionIdx].sumScore += score;
      sectionStats[sectionIdx].count++;
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

  // Final per-section accuracy, sorted by start time, each { startSec,
  // endSec, label, accuracyPct }. `label` carries through whatever the
  // Sections panel had it set to at the moment this is called (persisted
  // onto the attempt as-is — a section renamed later doesn't retroactively
  // relabel a past attempt's breakdown). accuracyPct is null for a section
  // nothing scoreable ever landed in (e.g. the singer never reached it),
  // same null-means-"nothing yet" convention as getAccuracy().
  function getSectionBreakdown() {
    return sectionStats.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      label: s.label || '',
      accuracyPct: s.count > 0 ? Math.round((s.sumScore / s.count) * 100) : null,
    }));
  }

  function reset() {
    sumScore = 0;
    total = 0;
    recentSamples = [];
    for (const s of sectionStats) { s.sumScore = 0; s.count = 0; }
    voicedStreak = 0;
  }

  return {
    addSample, getAccuracy, getRollingAccuracy, getSectionBreakdown, setTolerance, reset,
    addSection, removeSection, updateSectionBounds, updateSectionLabel,
  };
}
