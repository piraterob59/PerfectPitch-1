// YIN pitch detection (de Cheveigne / Kawahara). Pure, DOM-free — this same
// function is called from both the offline batch analyzer (analyze.js,
// normal module scope) and the real-time AudioWorklet processor
// (audio-worklet-processor.js, isolated worklet module scope), so there's
// exactly one DSP implementation to get right and debug.
//
// YIN's cumulative-mean-normalized difference function is what
// distinguishes it from plain autocorrelation: it's what avoids
// autocorrelation's classic octave-error problem (picking 2x or 0.5x the
// true pitch), which matters a lot for tracking a single vocal melody line.

export const DEFAULT_YIN_THRESHOLD = 0.15;

// A second, looser threshold used only by the offline analyzer (see
// analyze.js), for frames where nothing clears DEFAULT_YIN_THRESHOLD at
// all. Two simultaneous voices (lead + harmony) raise the difference
// function's noise floor enough that neither one's dip reliably clears the
// strict threshold, even though real periodicity is still present — that's
// what was fragmenting the target band into disconnected dashes through
// dense harmony passages, since a fully rejected frame becomes a gap, not
// just a dim point. Real-time mic tracking never uses this (see
// audio-worklet-processor.js) — a live take is one voice, so a frame that
// fails the strict threshold really is noise/silence, and a wrong guess
// there costs a scored miss immediately rather than just a dimmer target
// band.
export const OFFLINE_SECONDARY_YIN_THRESHOLD = 0.3;

// How far (in cents) a frame's pitch may drift from the previous frame's
// and still count as the same voice continuing, when searching near a
// preferFreqHz continuity hint (see detectPitchYIN below). Bounds "same
// voice" narrowly enough that a harmony note (a third apart is 300+ cents)
// can't be mistaken for continuation, while staying wide enough for real
// melodic movement between two frames only ~10ms apart.
const MAX_CONTINUITY_JUMP_CENTS = 150;

// Shared tail end of detectPitchYIN: turns a chosen tau into the returned
// {freqHz, confidence, rmsLevel}, via the same parabolic interpolation
// (for sub-sample precision) regardless of which search path chose tau.
function finalizePitch(tauEstimate, cmnd, halfN, sampleRate, rms) {
  const x0 = tauEstimate < 1 ? tauEstimate : tauEstimate - 1;
  const x2 = tauEstimate + 1 < halfN ? tauEstimate + 1 : tauEstimate;
  let betterTau;
  if (x0 === tauEstimate) {
    betterTau = cmnd[tauEstimate] <= cmnd[x2] ? tauEstimate : x2;
  } else if (x2 === tauEstimate) {
    betterTau = cmnd[tauEstimate] <= cmnd[x0] ? tauEstimate : x0;
  } else {
    const s0 = cmnd[x0];
    const s1 = cmnd[tauEstimate];
    const s2 = cmnd[x2];
    const denom = 2 * s1 - s2 - s0;
    betterTau = denom === 0 ? tauEstimate : tauEstimate + (s2 - s0) / (2 * denom);
    // A parabola fit through three equally-spaced points always has its
    // vertex within [x0, x2] when it's a genuine local minimum — a result
    // outside that range means denom was only near zero (a numerically
    // near-flat fit), not real curvature, most often when the tau being
    // refined sits at the edge of a narrow search window (see
    // preferFreqHz's neighborhood search above) rather than a true dip.
    // Confirmed live: an unclamped overshoot here produced a negative
    // betterTau, and thus a negative freqHz, from an otherwise ordinary
    // frame. Clamping is the correct fix, not just a defensive one — it's
    // exactly the range a real vertex can fall in.
    betterTau = Math.min(x2, Math.max(x0, betterTau));
  }
  return {
    freqHz: sampleRate / betterTau,
    // Clamped: cmnd can exceed 1 in principle (it's diff[tau]*tau/runningSum,
    // not itself bounded), which only a secondaryThreshold-admitted tau can
    // actually reach in practice — a strict-threshold candidate is always
    // already < threshold (<=1).
    confidence: Math.max(0, 1 - cmnd[tauEstimate]),
    rmsLevel: rms,
  };
}

/**
 * @param {Float32Array} buffer mono PCM samples for one analysis window
 * @param {number} sampleRate in Hz
 * @returns {{ freqHz: number|null, confidence: number, rmsLevel: number }}
 *   freqHz is null when the frame is silent (rms < silenceRms) or no
 *   confident periodicity dip was found (unvoiced/noisy).
 */
export function detectPitchYIN(buffer, sampleRate, {
  threshold = DEFAULT_YIN_THRESHOLD, minFreq = 70, maxFreq = 1000, silenceRms = 0.02,
  preferFreqHz = null, secondaryThreshold = null,
} = {}) {
  const n = buffer.length;

  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSquares / n);
  if (rms < silenceRms) return { freqHz: null, confidence: 0, rmsLevel: rms };

  // YIN's difference function needs each x[j] to have a x[j+tau] partner
  // for every tau being tested, so the search only covers the first half
  // of the buffer — this is the standard simplification.
  const halfN = Math.floor(n / 2);
  const diff = new Float32Array(halfN);
  for (let tau = 0; tau < halfN; tau++) {
    let sum = 0;
    for (let j = 0; j < halfN; j++) {
      const delta = buffer[j] - buffer[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Cumulative mean normalized difference function: flattens the
  // difference function's tendency to trend upward with tau, which is what
  // makes a fixed absolute threshold usable across different tau ranges.
  const cmnd = new Float32Array(halfN);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfN; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum === 0 ? 1 : (diff[tau] * tau) / runningSum;
  }

  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(halfN - 1, Math.floor(sampleRate / minFreq));

  // When there's a voice already being tracked (preferFreqHz), look for
  // its continuation FIRST, in a narrow neighborhood around where it's
  // expected to still be — rather than finding the best dip(s) anywhere in
  // the frame and only afterward picking whichever is closest. That
  // "pick the global best, then check distance" order is what still let a
  // harmony note (or, worse, vocal-separation bleed-through admitted by
  // secondaryThreshold) win outright whenever it produced a stronger dip
  // than the lead: the lead's own dip was on the candidate list, but
  // ranked second, not disqualifying. Searching only the neighborhood
  // first means a different voice's dip — however strong — never even
  // enters the comparison unless the tracked voice's own periodicity has
  // genuinely dropped out of that neighborhood.
  //
  // MAX_CONTINUITY_JUMP_CENTS bounds "same voice": clearly narrower than a
  // typical harmony interval (a third is 300+ cents) so a harmony note
  // can't masquerade as continuation, comfortably wider than real
  // frame-to-frame melodic motion at a 10ms hop (portamento/vibrato
  // included) so genuine pitch movement isn't mistaken for a dropout.
  if (preferFreqHz != null) {
    const searchRatio = Math.pow(2, MAX_CONTINUITY_JUMP_CENTS / 1200);
    const expectedTau = sampleRate / preferFreqHz;
    const tauLo = Math.max(tauMin, Math.round(expectedTau / searchRatio));
    const tauHi = Math.min(tauMax, Math.round(expectedTau * searchRatio));
    if (tauLo <= tauHi) {
      let localBestTau = tauLo;
      for (let t = tauLo + 1; t <= tauHi; t++) if (cmnd[t] < cmnd[localBestTau]) localBestTau = t;
      // Accepting against secondaryThreshold when given (offline analyzer)
      // is safe here in a way it wasn't for the old whole-frame fallback:
      // this dip is already anchored to where the tracked voice should be,
      // not wherever the single strongest periodicity in the frame happens
      // to sit, so a loose bar doesn't invite an unrelated signal in.
      if (cmnd[localBestTau] < (secondaryThreshold ?? threshold)) {
        return finalizePitch(localBestTau, cmnd, halfN, sampleRate, rms);
      }
    }
  }

  // No continuity hint (phrase onset, or the tracked voice's neighborhood
  // came up empty this frame — real gap or a jump wider than the window
  // above) — fall back to a fresh whole-frame search. Collect every dip
  // under threshold across the search range, not just the first — a
  // harmony/backing vocal sharing the frame with the lead can produce its
  // own clean dip at a different tau (its own pitch), and on a
  // frame-by-frame basis there's no way to tell from the dip alone which
  // voice is "the" melody. Each dip is walked to its local minimum the
  // same way the original single-candidate version did, then scanning
  // resumes past it to find any further dips.
  const candidateTaus = [];
  let tau = tauMin;
  while (tau <= tauMax) {
    if (cmnd[tau] < threshold) {
      let dipTau = tau;
      while (dipTau + 1 <= tauMax && cmnd[dipTau + 1] < cmnd[dipTau]) dipTau++;
      candidateTaus.push(dipTau);
      tau = dipTau + 1;
    } else {
      tau++;
    }
  }

  if (candidateTaus.length === 0) {
    if (secondaryThreshold == null) {
      return { freqHz: null, confidence: 0, rmsLevel: rms };
    }
    // Nothing cleared the strict threshold — fall back to the single best
    // (lowest-CMND) dip in the whole range, as long as it at least clears
    // the looser secondaryThreshold. Still gated, just not as strictly, so
    // this doesn't turn real silence/consonant noise into a fake pitch —
    // only a frame with some real periodicity, just not enough to pass the
    // strict threshold, gets rescued. Its honestly-low confidence (below
    // DEFAULT_YIN_THRESHOLD's own floor) is what visualizer.js uses to dim
    // it, rather than the frame becoming an outright gap in the band.
    let bestTau = tauMin;
    for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[bestTau]) bestTau = t;
    if (cmnd[bestTau] >= secondaryThreshold) {
      return { freqHz: null, confidence: 0, rmsLevel: rms };
    }
    candidateTaus.push(bestTau);
  }

  let tauEstimate;
  if (candidateTaus.length === 1 || preferFreqHz == null) {
    // No continuity hint to break the tie with (real-time mic tracking
    // never passes one, and the offline analyzer only has one at a phrase
    // onset) — fall back to standard YIN behavior: the first (shortest
    // period / highest frequency) dip under threshold, which is what
    // avoids the classic octave-down error for a solo voice.
    tauEstimate = candidateTaus[0];
  } else {
    // A previous frame's accepted pitch is available (see analyze.js,
    // which threads the last voiced frequency through as preferFreqHz)
    // — pick whichever candidate's resulting pitch is closest to it in
    // cents. This is what keeps the offline analyzer tracking the same
    // voice through a sustained phrase instead of hopping onto whichever
    // note happens to produce a marginally cleaner dip in a given ~10ms
    // window, which is what harmony/backing vocals otherwise cause.
    let bestCents = Infinity;
    tauEstimate = candidateTaus[0];
    for (const candidateTau of candidateTaus) {
      const candidateFreq = sampleRate / candidateTau;
      const cents = Math.abs(1200 * Math.log2(candidateFreq / preferFreqHz));
      if (cents < bestCents) {
        bestCents = cents;
        tauEstimate = candidateTau;
      }
    }
  }

  return finalizePitch(tauEstimate, cmnd, halfN, sampleRate, rms);
}
