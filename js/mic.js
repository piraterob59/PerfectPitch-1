// Main-thread mic/worklet glue. Every exported function here must be
// called from inside a user-gesture handler (e.g. the "Start Singing"
// button's click) — both AudioContext creation/resume and getUserMedia
// require an active gesture on iOS Safari, on top of the HTTPS requirement
// GitHub Pages already satisfies.

const WORKLET_MODULE_URL = new URL('./audio-worklet-processor.js', import.meta.url);

export async function startMicPitchTracking(audioContext, { onPitch }) {
  await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'pitch-processor', {
    processorOptions: { windowSize: 2048, hopSize: 1024 },
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
