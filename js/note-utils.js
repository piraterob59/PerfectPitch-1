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

// A live sample this far off the target (2 full semitones) is almost never
// a genuine, if badly missed, singing attempt — far more likely a mic
// noise spike or an octave-detection error from pitch.js. Distinct from
// (and well beyond) the tier system above: scoring.js excludes samples
// past this from the score entirely rather than counting them as a scored
// "red" miss, and visualizer.js doesn't draw a dot for them at all.
export const MAX_SCOREABLE_CENTS_OFF = 200;

// Real silence/unvoiced stretches in the target vocal show up as gaps in
// `points` (freqHz:null entries already filtered out before this is
// called) — analyze.js hops every ~10ms, so any surviving gap much wider
// than that is a genuine removed stretch, not just normal hop spacing.
// Kept well above typical within-word unvoiced-consonant gaps (tens of ms)
// so interpolation still bridges those, and well below a real instrumental
// break (seconds), so only actual silence reads as "no target pitch here".
// Exported (not just used internally below) so visualizer.js's band
// rendering can break on the same real-silence boundary that scoring and
// live-dot coloring already respect, instead of drawing a straight edge
// across a gap that shouldn't have a target pitch at all.
export const MAX_INTERPOLATION_GAP_SEC = 0.5;

// Finds the target pitch at time t by linearly interpolating between the
// two nearest points in a pitch timeline's `points` array (voiced points
// only — filter out freqHz:null entries before calling). Returns null when
// t falls in a real silence/unvoiced gap — including before the first or
// after the last point — so callers don't score or color a live sample
// against a target pitch that doesn't actually exist at that moment.
// Shared by visualizer.js (to color live samples) and scoring.js (to score
// them), so there's one interpolation implementation, not two that could
// drift.
// Splits a voiced-points-only timeline (freqHz:null entries already
// filtered out) into contiguous "sections" — runs of points uninterrupted
// by a real silence gap (see MAX_INTERPOLATION_GAP_SEC above), e.g. verses
// or phrases separated by an instrumental break or a long pause. Used to
// give per-attempt accuracy a meaningful breakdown instead of one
// whole-song average.
function splitByGap(voicedPoints, gapSec) {
  const runs = [];
  let startSec = null;
  let lastTimeSec = null;
  for (const p of voicedPoints) {
    if (lastTimeSec !== null && p.timeSec - lastTimeSec > gapSec) {
      runs.push({ startSec, endSec: lastTimeSec });
      startSec = null;
    }
    if (startSec === null) startSec = p.timeSec;
    lastTimeSec = p.timeSec;
  }
  if (startSec !== null) runs.push({ startSec, endSec: lastTimeSec });
  return runs;
}

export function computeVocalSections(voicedPoints) {
  return splitByGap(voicedPoints, MAX_INTERPOLATION_GAP_SEC);
}

// A gap this wide is meant to catch a real structural pause between verses/
// choruses (an instrumental break, a held breath before a new part), not
// the much shorter breath/consonant gaps MAX_INTERPOLATION_GAP_SEC (0.5s)
// is tuned for — splitting on that shorter gap here would produce a
// section per phrase, not per song part.
// Lowered from 1.5s: real section breaks in "The Wind" were only ~1s
// apart, well under the old threshold, so consecutive sections were
// merging into one instead of splitting. 0.8s still sits comfortably above
// MAX_INTERPOLATION_GAP_SEC's breath gaps.
const SUGGESTED_SECTION_GAP_SEC = 0.8;
// Drops a run this short from the suggestions entirely (not merged into a
// neighbor) — a stray voiced blip inside a long instrumental gap is far
// more likely a mic/detection artifact than an actual song section, and a
// section this brief wouldn't be useful to type a lyric line into anyway.
// Lowered from 3s: real short sections (under 3s but still deliberate
// song parts) were being dropped outright, per live user testing across
// already-sectioned songs.
const MIN_SUGGESTED_SECTION_SEC = 1.75;

// One-time starting point for the Sections panel's "Suggest Sections"
// button: splits the song's voiced pitch data into candidate verse/chorus-
// sized sections by real silence gaps, for the user to review, adjust, and
// type lyrics into — not something that drives scoring or playback on its
// own. Deliberately reuses the exact same split-by-gap logic as
// computeVocalSections (just a wider gap and a minimum-length filter suited
// to structural sections instead of per-attempt score grouping), rather
// than a separate heuristic, so there's one gap-detection implementation to
// trust.
export function suggestSectionBreaks(voicedPoints) {
  return splitByGap(voicedPoints, SUGGESTED_SECTION_GAP_SEC)
    .filter((run) => run.endSec - run.startSec >= MIN_SUGGESTED_SECTION_SEC);
}

// A gap has to clear this to be worth offering as a skip — well past
// INSTRUMENTAL_SKIP_LEAD_IN_SEC below, since a gap only a little longer
// than the lead-in itself would barely save any time once that lead-in is
// preserved, and past SUGGESTED_SECTION_GAP_SEC (0.8s) so ordinary section
// breaks never show up here.
const INSTRUMENTAL_SKIP_MIN_GAP_SEC = 15;
// How much instrumental to leave playing right before the next vocal
// entrance when a gap is skipped — enough to hear the beat/lead-in and
// come back in on time, rather than being dropped in cold.
export const INSTRUMENTAL_SKIP_LEAD_IN_SEC = 10;

// Finds long instrumental stretches — real gaps in the vocal timeline
// worth skipping past during playback, not the shorter breath/section gaps
// splitByGap's other callers care about. Includes the intro (silence
// before the first vocal entrance) as well as mid-song gaps, since both
// "lead into" a next vocal section the same way; excludes any trailing
// silence after the last vocal entrance, since there's no next section to
// lead into there. Returns raw candidate gaps for the UI to list — whether
// a given one is actually skipped during playback is a separate, persisted
// per-song choice (see db.js's instrumentalSkips store).
export function findSkippableInstrumentalGaps(voicedPoints) {
  const gaps = [];
  if (!voicedPoints.length) return gaps;
  if (voicedPoints[0].timeSec > INSTRUMENTAL_SKIP_MIN_GAP_SEC) {
    gaps.push({ startSec: 0, endSec: voicedPoints[0].timeSec });
  }
  for (let i = 1; i < voicedPoints.length; i++) {
    const gapSec = voicedPoints[i].timeSec - voicedPoints[i - 1].timeSec;
    if (gapSec > INSTRUMENTAL_SKIP_MIN_GAP_SEC) {
      gaps.push({ startSec: voicedPoints[i - 1].timeSec, endSec: voicedPoints[i].timeSec });
    }
  }
  return gaps;
}

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
