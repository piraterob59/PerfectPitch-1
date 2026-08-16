// Frequency <-> MIDI <-> note-name conversions and pitch-difference math.
// Pure, DOM-free — used by both the offline analyzer and the visualizer
// without pulling in pitch.js's DSP code.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function freqToMidi(freqHz) {
  // MIDI 69 = A4 = 440Hz; 12 semitones per octave, each an equal ratio step.
  return 69 + 12 * Math.log2(freqHz / 440);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToNoteName(freqHz) {
  const midi = Math.round(freqToMidi(freqHz));
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`;
}

// How far `freqHz` is from `targetMidiOrFreq` (either a MIDI number or a
// frequency in Hz — pass isFreq: true for the latter), in cents (1/100 semitone).
export function centsOffPitch(freqHz, targetMidiOrFreq, { isFreq = false } = {}) {
  const targetMidi = isFreq ? freqToMidi(targetMidiOrFreq) : targetMidiOrFreq;
  return (freqToMidi(freqHz) - targetMidi) * 100;
}

// Classifies how far off pitch a sample is into the same green/yellow/red
// bands used for both the live dot color and the accuracy score, so the
// two always agree with each other. `greenCents` is the adjustable
// Settings threshold (full credit); the yellow/red boundary stays fixed at
// 50 cents. When greenCents itself reaches 50, the yellow band collapses
// to nothing — anything within 50 cents just reads as green, which is a
// reasonable degenerate case for a deliberately loose tolerance.
export function pitchTier(cents, greenCents) {
  const abs = Math.abs(cents);
  if (abs <= greenCents) return 'green';
  if (abs <= 50) return 'yellow';
  return 'red';
}

export const TIER_SCORE = { green: 1, yellow: 0.5, red: 0 };
export const TIER_COLOR = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' };

// Real silence/unvoiced stretches in the target vocal show up as gaps in
// `points` (freqHz:null entries already filtered out before this is
// called) — analyze.js hops every ~10ms, so any surviving gap much wider
// than that is a genuine removed stretch, not just normal hop spacing.
// Kept well above typical within-word unvoiced-consonant gaps (tens of ms)
// so interpolation still bridges those, and well below a real instrumental
// break (seconds), so only actual silence reads as "no target pitch here".
const MAX_INTERPOLATION_GAP_SEC = 0.5;

// Finds the target pitch at time t by linearly interpolating between the
// two nearest points in a pitch timeline's `points` array (voiced points
// only — filter out freqHz:null entries before calling). Returns null when
// t falls in a real silence/unvoiced gap — including before the first or
// after the last point — so callers don't score or color a live sample
// against a target pitch that doesn't actually exist at that moment.
// Shared by visualizer.js (to color live samples) and scoring.js (to score
// them), so there's one interpolation implementation, not two that could
// drift.
export function interpolateTargetMidi(points, t) {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (t <= points[0].timeSec) {
    return points[0].timeSec - t <= MAX_INTERPOLATION_GAP_SEC ? points[0].midi : null;
  }
  if (t >= points[hi].timeSec) {
    return t - points[hi].timeSec <= MAX_INTERPOLATION_GAP_SEC ? points[hi].midi : null;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].timeSec <= t) lo = mid; else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.timeSec - a.timeSec;
  if (span > MAX_INTERPOLATION_GAP_SEC) return null;
  const frac = span > 0 ? (t - a.timeSec) / span : 0;
  return a.midi + (b.midi - a.midi) * frac;
}
