// Instrumental playback wrapper. Uses a plain <audio> element rather than
// an AudioBufferSourceNode graph — simpler/more robust play/pause/seek and
// better iOS background behavior. See the project plan's "timing model"
// note: this means playback has its own clock, separate from the mic
// AudioContext's clock, which is fine for a visual practice aid.

export function createPlayer(instrumentalBlob) {
  const audio = new Audio();
  audio.src = URL.createObjectURL(instrumentalBlob);
  audio.preload = 'auto';

  return {
    audio,
    get currentTime() { return audio.currentTime; },
    get duration() { return audio.duration; },
    get paused() { return audio.paused; },
    play() { return audio.play(); },
    pause() { audio.pause(); },
    seek(t) { audio.currentTime = t; },
    destroy() {
      audio.pause();
      URL.revokeObjectURL(audio.src);
    },
  };
}
