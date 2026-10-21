// Background music, synthesized with WebAudio so there is no audio file to ship or license.
// A two-bar A-minor funk loop on a 16th-note grid (kick, clap, hats, bass, chord stabs).
//
// The dance and the music share one clock: `time()` is the dance time in seconds. While the music
// plays, that time is read from the audio hardware clock, so the two cannot drift apart.

const midiHz = n => 440 * Math.pow(2, (n - 69) / 12);

const BASS = [[0, null, null, 0, null, 0, null, 3, null, null, 0, null, 7, null, 5, null],   // semitones above A1
              [0, null, null, 0, null, 0, null, 3, null, null, 5, null, 3, null, -2, null]];
const CHORDS = [{ steps: [2, 7, 10], notes: [57, 60, 64, 67] },                               // Am7
                { steps: [2, 7, 10], notes: [62, 65, 69, 72] }];                              // Dm7
const TURNAROUND = [64, 68, 71, 74];                                                          // E7, bar 2 step 14
const PATTERN_STEPS = 32;

export class Music {
  constructor(bpm = 120) {
    this.bpm = bpm;
    this.volume = 0.7;
    this.on = false;
    this.ctx = null;
    this.master = null;
    this.anchor = 0;       // audio-clock time at which dance time was 0
    this.timer = null;
  }

  get stepLen() { return 60 / this.bpm / 4; }

  /** Dance time (s) according to the audio clock. Only meaningful while `on`. */
  time() { return this.ctx.currentTime - this.anchor; }

  /** Start playing so that the bar line lands where the dance currently is (`danceTime`, in seconds). */
  start(danceTime) {
    this.stop(true);
    if (!this.ctx) this._init();
    const c = this.ctx;
    c.resume();
    this.master = c.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.comp);
    // the next 16th-note boundary that is at least a moment away
    const k = Math.ceil((danceTime + 0.05) / this.stepLen - 1e-6);
    this.anchor = c.currentTime - danceTime;
    this.step = k;
    this.next = this.anchor + k * this.stepLen;
    this.timer = setInterval(() => this._tick(), 25);
    this.on = true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.master) {
      const m = this.master;
      m.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
      setTimeout(() => m.disconnect(), 300);
      this.master = null;
    }
    this.on = false;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  // ---- internals ----

  _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.connect(this.ctx.destination);
  }

  _tick() {
    while (this.next < this.ctx.currentTime + 0.12) {
      this._playStep(this.step % PATTERN_STEPS, this.next);
      this.next += this.stepLen;
      this.step++;
    }
  }

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _kick(t) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this._env(g, t, 1.0, 0.003, 0.28);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.35);
  }

  _noise(t, type, freq, peak, decay, q = 0.7) {
    const c = this.ctx, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
    this._env(g, t, peak, 0.002, decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5); src.stop(t + decay + 0.05);
  }

  _clap(t) {
    for (const d of [0, 0.011, 0.022]) this._noise(t + d, "bandpass", 1500, 0.5, d === 0.022 ? 0.14 : 0.02, 1.2);
  }

  _bass(t, hz, dur) {
    const c = this.ctx, o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = "sawtooth"; o.frequency.value = hz;
    f.type = "lowpass"; f.Q.value = 6;
    f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(260, t + dur);
    this._env(g, t, 0.5, 0.005, dur);
    o.connect(f).connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _stab(t, notes) {
    const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain();
    f.type = "lowpass";
    f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.16);
    this._env(g, t, 0.16, 0.004, 0.17);
    f.connect(g).connect(this.master);
    for (const n of notes) {
      const o = c.createOscillator();
      o.type = "sawtooth"; o.frequency.value = midiHz(n); o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(f); o.start(t); o.stop(t + 0.25);
    }
  }

  _playStep(i, t) {
    const bar = i >> 4, s = i & 15;
    if (s % 4 === 0) this._kick(t);
    if (s === 4 || s === 12) this._clap(t);
    if (s % 4 === 2) this._noise(t, "highpass", 7000, 0.22, 0.11);        // open hat on the off-beat
    else if (s % 2 === 0) this._noise(t, "highpass", 8000, 0.10, 0.035);  // closed hat
    else this._noise(t, "highpass", 8000, 0.04, 0.025);                   // ghost 16th
    const semi = BASS[bar][s];
    if (semi !== null) this._bass(t, midiHz(33 + semi), this.stepLen * 1.7);   // 33 = A1
    if (CHORDS[bar].steps.includes(s)) this._stab(t, CHORDS[bar].notes);
    if (bar === 1 && s === 14) this._stab(t, TURNAROUND);
  }
}
