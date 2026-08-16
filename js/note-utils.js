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

// Finds the target pitch at time t by linearly interpolating between the
// two nearest points in a pitch timeline's `points` array (voiced points
// only — filter out freqHz:null entries before calling). Shared by
// visualizer.js (to color live samples) and scoring.js (to score them),
// so there's one interpolation implementation, not two that could drift.
export function interpolateTargetMidi(points, t) {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (t <= points[0].timeSec) return points[0].midi;
  if (t >= points[hi].timeSec) return points[hi].midi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].timeSec <= t) lo = mid; else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.timeSec - a.timeSec;
  const frac = span > 0 ? (t - a.timeSec) / span : 0;
  return a.midi + (b.midi - a.midi) * frac;
}
