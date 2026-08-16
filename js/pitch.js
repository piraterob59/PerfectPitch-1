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

/**
 * @param {Float32Array} buffer mono PCM samples for one analysis window
 * @param {number} sampleRate in Hz
 * @returns {{ freqHz: number|null, confidence: number, rmsLevel: number }}
 *   freqHz is null when the frame is silent (rms < silenceRms) or no
 *   confident periodicity dip was found (unvoiced/noisy).
 */
export function detectPitchYIN(buffer, sampleRate, {
  threshold = DEFAULT_YIN_THRESHOLD, minFreq = 70, maxFreq = 1000, silenceRms = 0.01,
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

  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      // Walk forward to the bottom of this dip rather than stopping at the
      // first sample under threshold, for a more accurate period estimate.
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    return { freqHz: null, confidence: 0, rmsLevel: rms };
  }

  // Parabolic interpolation around tauEstimate for sub-sample precision —
  // otherwise pitch is quantized to whole-sample periods, which is coarse
  // enough to matter for a small ensemble/vocal frequency range.
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
  }

  return {
    freqHz: sampleRate / betterTau,
    confidence: 1 - cmnd[tauEstimate],
    rmsLevel: rms,
  };
}
