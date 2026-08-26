(function (root) {
  'use strict';

  function SoundEngine() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }

  SoundEngine.prototype.ensure = function () {
    if (!this.ctx) {
      try {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.ctx = null;
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(function () {});
    }
  };

  SoundEngine.prototype.setMuted = function (m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  };

  SoundEngine.prototype.tone = function (freq, dur, opts) {
    opts = opts || {};
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + (opts.delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(opts.slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opts.gain || 0.15, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.03);
  };

  SoundEngine.prototype.noise = function (dur, opts) {
    opts = opts || {};
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + (opts.delay || 0);
    const len = Math.max(1, Math.floor(dur * this.ctx.sampleRate));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.type || 'highpass';
    f.frequency.value = opts.freq || 1200;
    f.Q.value = opts.q || 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain || 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  };

  SoundEngine.prototype.play = function (name) {
    this.ensure();
    if (!this.ctx || this.muted) return;
    switch (name) {
      case 'click':
        this.tone(660, 0.06, { type: 'triangle', gain: 0.1 });
        break;
      case 'select':
        this.tone(520, 0.07, { type: 'triangle', gain: 0.09 });
        break;
      case 'deal':
        this.noise(0.05, { freq: 2600, gain: 0.09 });
        break;
      case 'place':
        this.noise(0.06, { freq: 1500, gain: 0.2 });
        this.tone(185, 0.08, { type: 'sine', gain: 0.09 });
        break;
      case 'flip':
        this.noise(0.09, { type: 'bandpass', freq: 900, q: 2, gain: 0.16 });
        break;
      case 'sweep':
        this.noise(0.3, { type: 'lowpass', freq: 700, gain: 0.28 });
        break;
      case 'star':
        this.tone(1568, 0.12, { type: 'sine', gain: 0.12 });
        this.tone(2093, 0.16, { type: 'sine', gain: 0.09, delay: 0.06 });
        break;
      case 'kot':
        [523, 659, 784, 1046].forEach(function (f, i) {
          this.tone(f, 0.3, { type: 'square', gain: 0.08, delay: i * 0.09 });
        }, this);
        this.noise(0.5, { type: 'lowpass', freq: 320, gain: 0.22, delay: 0.36 });
        break;
      case 'win':
        [392, 523, 659, 784, 1046].forEach(function (f, i) {
          this.tone(f, 0.42, { type: 'triangle', gain: 0.11, delay: i * 0.11 });
        }, this);
        break;
      case 'lose':
        [330, 262, 196].forEach(function (f, i) {
          this.tone(f, 0.36, { type: 'sawtooth', gain: 0.06, delay: i * 0.14 });
        }, this);
        break;
      case 'stamp':
        this.tone(95, 0.18, { type: 'sine', gain: 0.35, slide: 45 });
        this.noise(0.08, { type: 'lowpass', freq: 420, gain: 0.28 });
        break;
    }
  };

  root.HokmSound = new SoundEngine();
})(typeof window !== 'undefined' ? window : globalThis);
