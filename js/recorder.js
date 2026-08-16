// Records a full attempt — the pitch-roll canvas plus a mix of instrumental
// playback and mic input — into a single video file via MediaRecorder.
//
// This is the single riskiest piece of platform compatibility in the whole
// app: canvas.captureStream() + MediaRecorder support on iOS Safari is
// newer and less battle-tested than desktop Chrome, and Safari has never
// supported the 'video/webm' container most other browsers default to
// (only MP4/QuickTime-family containers) — see pickMimeType() below. This
// needs real-device verification, not just the dev preview.

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4', // Safari's actual supported container
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

// `playerSourceNode` is a MediaElementAudioSourceNode wrapping the
// instrumental <audio> element — created once per practice session and
// passed in (rather than created here), because an HTMLMediaElement can
// only ever be wrapped by one MediaElementAudioSourceNode for its entire
// lifetime; creating a second one on a later attempt would throw.
export function createAttemptRecorder({ canvasEl, audioContext, playerSourceNode, micStream }) {
  const dest = audioContext.createMediaStreamDestination();
  playerSourceNode.connect(dest);
  const micSourceNode = audioContext.createMediaStreamSource(micStream);
  micSourceNode.connect(dest);

  const canvasStream = canvasEl.captureStream(30);
  const combined = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  function cleanupNodes() {
    // Targeted disconnect (not a bare .disconnect()) so playerSourceNode's
    // separate connection to audioContext.destination — the one keeping
    // instrumental playback audible — survives past this recording.
    playerSourceNode.disconnect(dest);
    micSourceNode.disconnect();
    canvasStream.getTracks().forEach((t) => t.stop());
  }

  return {
    start() {
      recorder.start();
    },
    // Resolves with the recorded video Blob once MediaRecorder has fully
    // flushed its last chunk.
    stop() {
      return new Promise((resolve, reject) => {
        recorder.onstop = () => {
          cleanupNodes();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }));
        };
        recorder.onerror = (e) => {
          cleanupNodes();
          reject(e.error || new Error('MediaRecorder error'));
        };
        recorder.stop();
      });
    },
    // Used when a practice session is torn down (navigating away) mid
    // recording — releases the mic/canvas tracks without waiting for or
    // saving a partial attempt, since leaving mid-attempt reasonably
    // implies the user didn't want to keep it.
    abort() {
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
      cleanupNodes();
    },
  };
}

export function isRecordingSupported() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}
