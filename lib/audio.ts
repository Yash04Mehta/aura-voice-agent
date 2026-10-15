// Browser audio plumbing.
//   MicStream   : microphone -> 16-bit PCM chunks (base64) at the device's native rate.
//                 Gemini Live resamples any input rate, so we skip resampling in JS.
//   AudioPlayer : base64 16-bit PCM @ 24 kHz from Gemini -> gapless playback,
//                 with instant stop() for barge-in.

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class MicStream {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  sampleRate = 16000;

  async start(onChunk: (base64: string) => void, onLevel: (rms: number) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true, // stops Aria hearing herself through the speakers
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule("/mic-processor.js");

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "mic-processor");
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      onLevel(e.data.rms);
      onChunk(bytesToBase64(e.data.pcm));
    };
    // A muted path to the destination keeps the worklet running in every browser.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.ctx.destination);
  }

  stop() {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = undefined;
    this.stream = undefined;
    this.ctx = undefined;
  }
}

export class AudioPlayer {
  private ctx: AudioContext;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private levelData: Uint8Array<ArrayBuffer>;
  onIdle?: () => void;

  constructor(sampleRate = 24000) {
    this.ctx = new AudioContext({ sampleRate });
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.levelData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.gain.connect(this.analyser).connect(this.ctx.destination);
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get playing() {
    return this.sources.size > 0;
  }

  /** Current output loudness 0..1, used for the speaking animation. */
  level(): number {
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const v of this.levelData) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / this.levelData.length);
  }

  enqueue(base64Pcm: string) {
    const bytes = base64ToBytes(base64Pcm);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (samples.length === 0) return;

    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);

    // Schedule back-to-back so chunks join without clicks or gaps.
    const startAt = Math.max(this.nextTime, this.ctx.currentTime + 0.03);
    src.start(startAt);
    this.nextTime = startAt + buffer.duration;

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this.onIdle?.();
    };
  }

  /** Barge-in: drop everything queued and go silent immediately. */
  stop() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextTime = 0;
    this.onIdle?.();
  }

  close() {
    this.stop();
    this.ctx.close().catch(() => {});
  }
}
