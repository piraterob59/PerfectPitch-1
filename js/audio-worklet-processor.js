// Runs in the isolated AudioWorkletGlobalScope on the audio rendering
// thread (no window/DOM here) — this is what keeps real-time pitch
// detection from stuttering under normal page/UI work, unlike the
// deprecated main-thread ScriptProcessorNode. Imports the same
// detectPitchYIN used by analyze.js's offline pass, so there's one DSP
// implementation, not two to keep in sync.
import { detectPitchYIN } from './pitch.js';

const WINDOW_SIZE = 2048;
const HOP_SIZE = 1024; // ~23ms @44.1kHz -> ~43 pitch messages/sec

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.windowSize = options.processorOptions?.windowSize ?? WINDOW_SIZE;
    this.hopSize = options.processorOptions?.hopSize ?? HOP_SIZE;
    this.ringBuffer = new Float32Array(this.windowSize);
    this.writeIndex = 0;
    this.samplesSinceAnalysis = 0;
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
      const { freqHz, confidence } = detectPitchYIN(ordered, sampleRate);
      this.port.postMessage({ type: 'pitch', freqHz, confidence });
    }

    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
