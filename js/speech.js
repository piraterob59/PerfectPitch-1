// Best-effort live lyric transcription via the Web Speech API, used so a
// user doesn't have to hand-type lyric cues while singing. Feature-detected
// on purpose, not polyfilled: this API is unevenly supported, and notably
// documented as unavailable specifically inside installed/home-screen PWAs
// on iOS Safari (vs. working in an ordinary Safari tab) even though it's
// otherwise present. Always check isSpeechRecognitionSupported() first and
// degrade to the existing manual "Add Cue" flow when it's false.
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isSpeechRecognitionSupported() {
  return !!SpeechRecognitionImpl;
}

// onResult({ text, isFinal }) fires per recognition result as it arrives —
// only isFinal results are confirmed transcriptions worth saving as a cue;
// interim ones are for a "listening" indicator only and may still change.
export function startLyricTranscription({ onResult, onError } = {}) {
  if (!SpeechRecognitionImpl) throw new Error('SpeechRecognition is not supported in this browser');

  const recognition = new SpeechRecognitionImpl();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (text) onResult && onResult({ text, isFinal: result.isFinal });
    }
  };

  // 'no-speech' fires constantly during instrumental-only gaps between
  // lines, and 'aborted' fires on our own explicit stop() below — neither
  // is a real failure worth surfacing to the caller.
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    onError && onError(event.error);
  };

  // Browsers auto-end recognition after a period of silence even with
  // continuous:true; restart transparently unless stop() was the cause.
  let stopped = false;
  recognition.onend = () => {
    if (stopped) return;
    try { recognition.start(); } catch { /* already starting/started, ignore */ }
  };

  recognition.start();

  return {
    stop() {
      stopped = true;
      recognition.onend = null;
      recognition.stop();
    },
  };
}
