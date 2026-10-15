// AudioWorklet: runs on the browser's audio thread.
// Collects microphone samples, converts float32 [-1, 1] to 16-bit PCM (what Gemini Live expects)
// and posts a chunk roughly every 100 ms together with a loudness level for the UI.

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.round(sampleRate / 10); // ~100 ms
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;

      if (this.offset === this.chunkSize) {
        const rms = Math.sqrt(this.sumSquares / this.chunkSize);
        const out = this.buffer.slice(0);
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
        this.offset = 0;
        this.sumSquares = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
