// Offline batch pitch analysis: decode the separated vocals stem and slide
// a window across it, calling the same detectPitchYIN used for real-time
// mic tracking (see pitch.js's header comment for why that sharing matters).

import { detectPitchYIN, OFFLINE_SECONDARY_YIN_THRESHOLD } from './pitch.js';
import { MAX_INTERPOLATION_GAP_SEC } from './note-utils.js';
import { store } from './db.js';

const WINDOW_SIZE = 2048;
const HOP_SIZE = 441; // ~10ms @44.1kHz -> ~100 timeline points/sec

// Decodes `blob` and returns its first channel as a mono Float32Array plus
// the buffer's sample rate. AudioContext is created fresh here (not the
// shared playback/mic one) since this can run before any user gesture —
// decodeAudioData doesn't require an unlocked AudioContext, unlike
// playback/getUserMedia.
async function decodeToMono(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return { samples: audioBuffer.getChannelData(0), sampleRate: audioBuffer.sampleRate };
  } finally {
    audioCtx.close();
  }
}

/**
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @returns {{ hopSec: number, points: Array<{timeSec:number, freqHz:number|null, midi:number|null, confidence:number}> }}
 */
export function analyzeSamples(samples, sampleRate) {
  const hopSec = HOP_SIZE / sampleRate;
  const points = [];
  // The vocals stem is whatever LALAL.AI separated from the mix — lead and
  // any backing/harmony vocals together, not just the melody — so a given
  // ~10ms window can contain two simultaneous, individually clean pitches.
  // detectPitchYIN can't tell from one window alone which is "the" line, so
  // it's told here: the last voiced frequency is passed back in as
  // preferFreqHz, which breaks that ambiguity in favor of staying on
  // whichever voice was already being tracked, rather than hopping to
  // whichever note's dip happens to be marginally cleaner in this window.
  // Only the offline analyzer can do this (it can afford the sequential
  // dependency); the real-time mic path never passes preferFreqHz, so live
  // tracking is unaffected.
  let lastVoicedFreqHz = null;
  let lastVoicedTimeSec = null;
  for (let start = 0; start + WINDOW_SIZE <= samples.length; start += HOP_SIZE) {
    const timeSec = start / sampleRate;
    // A gap this wide is a real silence/instrumental break (see
    // note-utils.js's MAX_INTERPOLATION_GAP_SEC) — the next phrase can
    // start on any pitch, lead or harmony, so there's nothing to stay
    // continuous with. A shorter gap (an unvoiced consonant, a quick
    // breath mid-phrase) keeps the hint, so tracking doesn't reset every
    // time voicing briefly drops out within the same held line.
    const gapTooLong = lastVoicedTimeSec !== null && (timeSec - lastVoicedTimeSec) > MAX_INTERPOLATION_GAP_SEC;
    const preferFreqHz = gapTooLong ? null : lastVoicedFreqHz;
    const window = samples.subarray(start, start + WINDOW_SIZE);
    // secondaryThreshold: see pitch.js's OFFLINE_SECONDARY_YIN_THRESHOLD —
    // rescues frames a harmony/backing vocal would otherwise drop entirely
    // (a gap in the band) into a low-confidence point (a dimmed one)
    // instead.
    const { freqHz, confidence } = detectPitchYIN(window, sampleRate, {
      preferFreqHz, secondaryThreshold: OFFLINE_SECONDARY_YIN_THRESHOLD,
    });
    points.push({
      timeSec,
      freqHz,
      midi: freqHz ? 69 + 12 * Math.log2(freqHz / 440) : null,
      confidence,
    });
    if (freqHz !== null) {
      lastVoicedFreqHz = freqHz;
      lastVoicedTimeSec = timeSec;
    }
  }
  return { hopSec, points };
}

// Decodes the stored vocals stem for `songId`, analyzes it, and persists
// the resulting pitch timeline via db.js.
export async function analyzeSongVocals(songId, { onProgress } = {}) {
  const stem = await store.getStem(songId, 'vocals');
  if (!stem) throw new Error(`No vocals stem stored for song ${songId}`);
  if (onProgress) onProgress(0);
  const { samples, sampleRate } = await decodeToMono(stem.blob);
  if (onProgress) onProgress(50);
  const { hopSec, points } = analyzeSamples(samples, sampleRate);
  await store.putPitchTimeline(songId, points, hopSec);
  if (onProgress) onProgress(100);
  return { hopSec, points };
}
