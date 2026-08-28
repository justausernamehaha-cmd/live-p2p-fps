// Every sound is synthesised on the fly — no audio assets to load or host.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
  }

  // must be called from a user gesture (browsers block audio otherwise)
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.noise = makeNoise(this.ctx);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _burst(dur, freq, gain, type = 'sawtooth') {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  _noise(dur, gain, filterFreq, q = 1) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = filterFreq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** distance = 0 for our own gun, larger for someone else's */
  shot(weaponId, distance = 0) {
    if (!this.ctx) return;
    const vol = Math.max(0.06, 1 - distance / 60);
    if (weaponId === 1) { this._noise(0.28, 0.5 * vol, 700, 0.6); this._burst(0.16, 150, 0.28 * vol, 'square'); }
    else if (weaponId === 2) { this._noise(0.3, 0.32 * vol, 1400, 0.8); this._burst(0.22, 260, 0.26 * vol, 'sawtooth'); }
    else { this._noise(0.12, 0.35 * vol, 1800, 0.9); this._burst(0.09, 320, 0.2 * vol, 'square'); }
  }

  hit() { if (this.ctx) this._burst(0.06, 1400, 0.16, 'square'); }
  kill() { if (this.ctx) { this._burst(0.09, 900, 0.2, 'triangle'); setTimeout(() => this.ctx && this._burst(0.12, 1500, 0.18, 'triangle'), 70); } }
  hurt() { if (this.ctx) { this._noise(0.18, 0.3, 300, 0.5); this._burst(0.14, 110, 0.2, 'sawtooth'); } }
  death() { if (this.ctx) this._burst(0.6, 220, 0.3, 'sawtooth'); }
  reload() { if (this.ctx) { this._noise(0.05, 0.16, 2600, 3); setTimeout(() => this.ctx && this._noise(0.06, 0.16, 1600, 3), 160); } }
  join() { if (this.ctx) this._burst(0.18, 660, 0.14, 'triangle'); }
}

function makeNoise(ctx) {
  const len = ctx.sampleRate * 0.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
