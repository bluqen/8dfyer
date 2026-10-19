// Shared 8D audio graph: used by the live preview and the offline export so both sound identical.

export const DEFAULTS = {
  period: 8,      // seconds per full orbit
  direction: 1,   // 1 = clockwise, -1 = counter-clockwise
  radius: 3,      // orbit distance
  reverb: 0.2,    // wet amount 0..1
  vertical: false // slight up/down drift
};

const CURVE_POINTS_PER_SECOND = 100;

function makeImpulse(ctx, seconds = 2.2, decay = 2.5) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return ir;
}

function orbitCurves(opts, offset, duration) {
  const span = Math.max(duration - offset, 0.1);
  const n = Math.max(2, Math.ceil(span * CURVE_POINTS_PER_SECOND));
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = offset + (i / (n - 1)) * span;
    const theta = opts.direction * 2 * Math.PI * (t / opts.period);
    x[i] = opts.radius * Math.sin(theta);
    z[i] = opts.radius * Math.cos(theta);
    y[i] = opts.vertical ? opts.radius * 0.4 * Math.sin(theta / 2.7) : 0;
  }
  return { x, y, z, span };
}

/**
 * Wire `source` through the 8D chain to ctx.destination.
 * @param offset  playback offset (s) the source will start from, so the orbit stays in sync after pause/resume
 * @param duration total buffer duration (s)
 * @param startAt  ctx time at which the source starts
 */
export function buildGraph(ctx, source, opts, { offset = 0, duration, startAt = 0 }) {
  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = 'explicit';
  mono.channelInterpretation = 'speakers';

  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.rolloffFactor = 0.6;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 16000;

  const dry = ctx.createGain();
  dry.gain.value = 1 - opts.reverb * 0.5;
  const wet = ctx.createGain();
  wet.gain.value = opts.reverb;
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);

  const master = ctx.createGain();
  master.gain.value = 1.4; // compensate for HRTF/distance attenuation

  source.connect(mono);
  mono.connect(panner);
  panner.connect(lowpass);
  lowpass.connect(dry);
  lowpass.connect(convolver);
  convolver.connect(wet);
  dry.connect(master);
  wet.connect(master);
  master.connect(ctx.destination);

  const { x, y, z, span } = orbitCurves(opts, offset, duration);
  if (panner.positionX) {
    panner.positionX.setValueCurveAtTime(x, startAt, span);
    panner.positionY.setValueCurveAtTime(y, startAt, span);
    panner.positionZ.setValueCurveAtTime(z, startAt, span);
  } else {
    panner.setPosition(x[0], y[0], z[0]); // legacy fallback: static
  }

  // Muffle slightly when the source is behind the listener (z < 0).
  const lpTimes = Math.max(2, Math.ceil(span * 20));
  const lpCurve = new Float32Array(lpTimes);
  for (let i = 0; i < lpTimes; i++) {
    const idx = Math.floor((i / (lpTimes - 1)) * (z.length - 1));
    lpCurve[i] = z[idx] < 0 ? 9000 : 16000;
  }
  lowpass.frequency.setValueCurveAtTime(lpCurve, startAt, span);

  return { panner, master };
}

/** Render the whole buffer offline with the 8D effect. Returns an AudioBuffer (stereo). */
export async function render8D(buffer, opts) {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  buildGraph(ctx, src, opts, { offset: 0, duration: buffer.duration, startAt: 0 });
  src.start(0);
  return ctx.startRendering();
}

/** Live preview player with pause/resume that stays in sync with the orbit. */
export class Previewer {
  constructor(buffer, getOpts, onEnded) {
    this.buffer = buffer;
    this.getOpts = getOpts;
    this.onEnded = onEnded;
    this.ctx = null;
    this.src = null;
    this.offset = 0;
    this.startedAt = 0;
    this.playing = false;
  }

  get position() {
    if (!this.playing) return this.offset;
    return Math.min(this.offset + (this.ctx.currentTime - this.startedAt), this.buffer.duration);
  }

  async play() {
    this.stopSource();
    this.ctx = this.ctx || new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const startAt = this.ctx.currentTime + 0.05;
    buildGraph(this.ctx, src, this.getOpts(), {
      offset: this.offset,
      duration: this.buffer.duration,
      startAt
    });
    src.onended = () => {
      if (this.src === src && this.playing) {
        this.playing = false;
        this.offset = 0;
        this.onEnded?.();
      }
    };
    src.start(startAt, this.offset);
    this.src = src;
    this.startedAt = startAt;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.playing = false;
    this.stopSource();
  }

  /** Re-apply options by restarting from the current position. */
  refresh() {
    if (!this.playing) return;
    this.offset = this.position;
    this.play();
  }

  stopSource() {
    if (this.src) {
      this.src.onended = null;
      try { this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
      this.src = null;
    }
  }

  dispose() {
    this.playing = false;
    this.stopSource();
    this.ctx?.close();
    this.ctx = null;
  }
}
