// Main-thread mic/worklet glue. Every exported function here must be
// called from inside a user-gesture handler (e.g. the "Start Singing"
// button's click) — both AudioContext creation/resume and getUserMedia
// require an active gesture on iOS Safari, on top of the HTTPS requirement
// GitHub Pages already satisfies.

const WORKLET_MODULE_URL = new URL('./audio-worklet-processor.js', import.meta.url);

// Matches audio-worklet-processor.js's own WINDOW_SIZE — kept here too
// (rather than imported cross-worklet-boundary) since this is the value
// actually passed via processorOptions below; getAnalysisLatencySec()
// derives from this single copy instead of a third hardcoded 2048.
const WINDOW_SIZE = 2048;
const HOP_SIZE = 1024;

// Each pitch estimate is computed from the trailing WINDOW_SIZE samples
// ending "now" (see audio-worklet-processor.js), so the best single-point
// estimate of when that pitch was actually sung is the window's midpoint,
// not the moment the result message arrives on the main thread. Callers
// should subtract this from whatever "now" timestamp they'd otherwise
// stamp a sample with. Does NOT include mic hardware/OS capture latency,
// which isn't reliably queryable from JS — this covers only the
// analysis-window component.
export function getAnalysisLatencySec(sampleRate) {
  return (WINDOW_SIZE / 2) / sampleRate;
}

export async function startMicPitchTracking(audioContext, { onPitch }) {
  await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'pitch-processor', {
    processorOptions: { windowSize: WINDOW_SIZE, hopSize: HOP_SIZE },
  });
  node.port.onmessage = (event) => {
    if (event.data?.type === 'pitch') onPitch(event.data);
  };

  // Deliberately not connected to audioContext.destination — otherwise the
  // mic would feed straight back into the speakers.
  source.connect(node);

  return {
    // Exposed so callers (e.g. recorder.js) can tap the same raw mic
    // stream for other purposes — a second getUserMedia call would prompt
    // for permission again and open a redundant physical mic stream.
    stream,
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
    },
  };
}
