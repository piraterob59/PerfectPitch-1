// Accuracy scoring: compares live mic pitch samples against the target
// pitch timeline, weighting each sample by the same green/yellow/red tier
// used to color its dot on the visualizer (see note-utils.js's pitchTier) —
// green counts full, yellow counts half, red counts nothing. The tier
// boundary itself is the Settings 5-50 cent slider.
// Deliberately independent from visualizer.js's own liveSamples array,
// which is trimmed to a short trailing window for rendering performance —
// scoring needs the full singing-session history, not just what's on screen.

import { centsOffPitch, interpolateTargetMidi, pitchTier, TIER_SCORE } from './note-utils.js';

export function createAccuracyTracker(pitchTimeline, { toleranceCents = 5 } = {}) {
  const points = (pitchTimeline?.points || []).filter((p) => p.freqHz !== null);
  let tolerance = toleranceCents;
  let sumScore = 0;
  let total = 0;

  function setTolerance(cents) {
    tolerance = cents;
  }

  // Silent/unvoiced mic frames (freqHz: null) are skipped rather than
  // counted as misses — gaps between words shouldn't drag the score down.
  function addSample(timeSec, freqHz) {
    if (freqHz === null) return;
    const targetMidi = interpolateTargetMidi(points, timeSec);
    if (targetMidi === null) return;
    total++;
    sumScore += TIER_SCORE[pitchTier(centsOffPitch(freqHz, targetMidi), tolerance)];
  }

  // Whole-percent accuracy, or null if nothing scoreable has come in yet
  // (e.g. right after "Start Singing", before any voiced sample lands).
  function getAccuracy() {
    return total > 0 ? Math.round((sumScore / total) * 100) : null;
  }

  function reset() {
    sumScore = 0;
    total = 0;
  }

  return { addSample, getAccuracy, setTolerance, reset };
}
