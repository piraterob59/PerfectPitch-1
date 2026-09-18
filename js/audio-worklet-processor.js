// Runs in the isolated AudioWorkletGlobalScope on the audio rendering
// thread (no window/DOM here) — this is what keeps real-time pitch
// detection from stuttering under normal page/UI work, unlike the
// deprecated main-thread ScriptProcessorNode. Imports the same
// detectPitchYIN used by analyze.js's offline pass, so there's one DSP
// implementation, not two to keep in sync.
import { detectPitchYIN, SECONDARY_YIN_THRESHOLD } from './pitch.js';

const WINDOW_SIZE = 2048;
const HOP_SIZE = 1024; // ~23ms @44.1kHz -> ~43 pitch messages/sec
// Same role as note-utils.js's MAX_INTERPOLATION_GAP_SEC (not imported
// directly — this worklet's isolated module scope already pulls in only
// pitch.js, and duplicating one small constant beats adding a second
// cross-worklet import for it): a silence this long is a real pause, not
// just a missed frame, so the continuity hint below resets instead of
// anchoring the next frame to a stale pitch.
const CONTINUITY_RESET_SEC = 0.5;

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.windowSize = options.processorOptions?.windowSize ?? WINDOW_SIZE;
    this.hopSize = options.processorOptions?.hopSize ?? HOP_SIZE;
    this.ringBuffer = new Float32Array(this.windowSize);
    this.writeIndex = 0;
    this.samplesSinceAnalysis = 0;
    // Confirmed live: singing without headphones means the instrumental
    // itself bleeds into the mic alongside the voice, at a level that can
    // easily stop the strict-threshold search from ever finding the voice's
    // own dip — the mic level meter shows real signal, but no pitch ever
    // comes out. Same fix as analyze.js's backing-vocal case: track the
    // last voiced pitch and feed it back in as a continuity hint, so the
    // search stays anchored to the voice instead of needing an unaided
    // strict-threshold dip every single ~23ms frame.
    this.lastVoicedFreqHz = null;
    this.lastVoicedTime = null;
  }

  // Rebuilds a time-ordered buffer starting at the oldest sample, since
  // the ring buffer's physical write position isn't the logical start.
  _linearize() {
    const out = new Float32Array(this.windowSize);
    for (let i = 0; i < this.windowSize; i++) {
      out[i] = this.ringBuffer[(this.writeIndex + i) % this.windowSize];
    }
    return out;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true; // keep the node alive even with no input yet

    for (let i = 0; i < channel.length; i++) {
      this.ringBuffer[this.writeIndex] = channel[i];
      this.writeIndex = (this.writeIndex + 1) % this.windowSize;
      this.samplesSinceAnalysis++;
    }

    if (this.samplesSinceAnalysis >= this.hopSize) {
      this.samplesSinceAnalysis = 0;
      const ordered = this._linearize();
      // `currentTime` is an AudioWorkletGlobalScope global, same as
      // `sampleRate` below — both already used this way, no import needed.
      const gapTooLong = this.lastVoicedTime !== null && (currentTime - this.lastVoicedTime) > CONTINUITY_RESET_SEC;
      const preferFreqHz = gapTooLong ? null : this.lastVoicedFreqHz;
      const { freqHz, confidence, rmsLevel } = detectPitchYIN(ordered, sampleRate, {
        preferFreqHz, secondaryThreshold: SECONDARY_YIN_THRESHOLD,
      });
      if (freqHz !== null) {
        this.lastVoicedFreqHz = freqHz;
        this.lastVoicedTime = currentTime;
      }
      // rmsLevel is forwarded even though detectPitchYIN already used it
      // internally (the silence gate) — the main thread has no other way
      // to know the mic is actually delivering signal at all, as opposed
      // to no periodicity being found in real signal. That distinction is
      // exactly what a stuck-at-zero mic level meter vs. a moving-but-
      // pitchless one tells apart.
      this.port.postMessage({ type: 'pitch', freqHz, confidence, rmsLevel });
    }

    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
