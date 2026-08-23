// Offline batch pitch analysis: decode the separated vocals stem and slide
// a window across it, calling the same detectPitchYIN used for real-time
// mic tracking (see pitch.js's header comment for why that sharing matters).

import { detectPitchYIN } from './pitch.js';
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
  for (let start = 0; start + WINDOW_SIZE <= samples.length; start += HOP_SIZE) {
    const window = samples.subarray(start, start + WINDOW_SIZE);
    const { freqHz, confidence } = detectPitchYIN(window, sampleRate);
    points.push({
      timeSec: start / sampleRate,
      freqHz,
      midi: freqHz ? 69 + 12 * Math.log2(freqHz / 440) : null,
      confidence,
    });
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
