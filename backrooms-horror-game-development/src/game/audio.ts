import * as THREE from 'three';
import { rand, clamp, WeaponId } from './types';
import { AudioLoop, scheduleEnvelope, smoothAudioParam } from './audioGraph';

export type ShotKind = WeaponId;
export type EnemyVoiceKind = 'stalker' | 'runner' | 'watcher' | 'heavy';

const liveEngines = new Set<AudioEngine>();

/**
 * Fully procedural WebAudio engine — no external sound files.
 * Synthesises gunfire, impacts, entity voices, fluorescent buzz,
 * ambience, heartbeat and UI sounds.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private volume = 0.8;
  private started = false;
  private disposed = false;
  private loops = new Set<AudioLoop>();
  private voices = new Set<EnemyVoice>();
  /** Live one-shot sources, so reset/dispose can stop them. */
  private liveSources = new Set<AudioScheduledSourceNode>();
  private listenerPosition = new THREE.Vector3();
  private listenerDirection = new THREE.Vector3();
  private listenerValid = false;
  private listenerUpdatedAt = -Infinity;

  // looping nodes
  private buzzSrc: { loop: AudioLoop; pan: PannerNode } | null = null;
  private heartTimer = 0;
  private danger = 0; // 0..1 drives heartbeat
  private ambientTimer = 6;
  private genHum: AudioLoop | null = null;
  private fanNodes: AudioLoop | null = null;
  private alarm: AudioLoop | null = null;

  init() {
    if (this.ctx && !this.disposed && this.ctx.state !== 'closed') {
      this.ensureRunning();
      return;
    }
    // first start — or a rebuild after dispose() closed the old context
    // (an engine that can never come back is how an update kills all sound)
    this.disposed = false;
    this.loops.clear();
    this.voices.clear();
    this.liveSources.clear();
    this.buzzSrc = null;
    this.genHum = null;
    this.fanNodes = null;
    this.alarm = null;
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    // Keep the existing combat mix; continuous ambience is cleaned separately.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.012;
    comp.release.value = 0.22;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.85;
    this.sfxBus.connect(this.master);

    this.noiseBuf = makeEffectNoise(this.ctx, 8);

    this.startDrone();
    this.startBuzz();
    smoothAudioParam(this.master.gain, this.volume, this.ctx.currentTime, 0.04);
    this.started = true;
    liveEngines.add(this);
  }

  get ready() {
    return this.started;
  }

  setVolume(v: number) {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.ctx) smoothAudioParam(this.master.gain, this.volume, this.ctx.currentTime);
  }

  updateListener(cam: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = cam.position;
    this.listenerPosition.copy(p);
    this.listenerValid = true;
    const t = this.ctx.currentTime;
    if (t - this.listenerUpdatedAt < 1 / 30) return;
    this.listenerUpdatedAt = t;
    const fwd = this.listenerDirection;
    cam.getWorldDirection(fwd);
    const up = cam.up;
    if (l.positionX) {
      smoothAudioParam(l.positionX, p.x, t, 0.03);
      smoothAudioParam(l.positionY, p.y, t, 0.03);
      smoothAudioParam(l.positionZ, p.z, t, 0.03);
      smoothAudioParam(l.forwardX, fwd.x, t, 0.03);
      smoothAudioParam(l.forwardY, fwd.y, t, 0.03);
      smoothAudioParam(l.forwardZ, fwd.z, t, 0.03);
      smoothAudioParam(l.upX, up.x, t, 0.03);
      smoothAudioParam(l.upY, up.y, t, 0.03);
      smoothAudioParam(l.upZ, up.z, t, 0.03);
    }
  }

  // ------------------------------------------------------------------ util
  private panner(pos?: THREE.Vector3, maxDist = 46): AudioNode | null {
    const ctx = this.ctx!;
    if (!pos) return this.sfxBus!;
    // nothing to spatialise if we're already past the audible range
    if (this.listenerValid && pos.distanceToSquared(this.listenerPosition) >= maxDist * maxDist) return null;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'linear'; // reaches true zero at maxDistance
    p.refDistance = 3;
    p.maxDistance = maxDist;
    p.rolloffFactor = 1;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.sfxBus!);
    return p;
  }

  private createLoop(output: AudioNode): AudioLoop {
    const loop = new AudioLoop(this.ctx!, output, (ended) => this.loops.delete(ended));
    this.loops.add(loop);
    return loop;
  }

  /** Track a one-shot so it can be stopped on reset/dispose; disconnect on end. */
  private track(source: AudioScheduledSourceNode, nodes: AudioNode[]) {
    this.liveSources.add(source);
    source.onended = () => {
      this.liveSources.delete(source);
      for (const n of nodes) n.disconnect();
    };
  }

  private stopLiveSources() {
    for (const s of [...this.liveSources]) {
      try { s.stop(); } catch { /* already ended */ }
    }
    this.liveSources.clear();
  }

  private ensureRunning() {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  private noise(
    out: AudioNode | null,
    opts: { dur: number; type?: BiquadFilterType; freq?: number; q?: number; gain?: number; sweepTo?: number; delay?: number },
  ) {
    const ctx = this.ctx;
    if (!ctx || !out || !this.noiseBuf) return;
    this.ensureRunning();
    const buf = this.noiseBuf;
    const t0 = ctx.currentTime + 0.005 + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false; // one-shots only — noise is never looped any more
    const dur = Math.min(opts.dur, buf.duration - 0.08);
    const maxOff = Math.max(0.01, buf.duration - dur - 0.04);
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'lowpass';
    filter.frequency.setValueAtTime(opts.freq ?? 1000, t0);
    if (opts.sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.sweepTo), t0 + dur);
    filter.Q.value = Math.min(opts.q ?? 0.8, 4);
    const g = ctx.createGain();
    const peak = Math.min(opts.gain ?? 0.3, 0.7);
    const end = scheduleEnvelope(g.gain, t0, dur, peak);
    src.connect(filter).connect(g).connect(out);
    this.track(src, [src, filter, g]);
    src.start(t0, rand(0, maxOff));
    src.stop(end);
  }

  private tone(
    out: AudioNode | null,
    opts: {
      type?: OscillatorType; freq: number; freqTo?: number; dur: number; gain?: number;
      delay?: number; attack?: number;
    },
  ) {
    const ctx = this.ctx;
    if (!ctx || !out) return;
    this.ensureRunning();
    const t0 = ctx.currentTime + 0.005 + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), t0 + opts.dur);
    const g = ctx.createGain();
    const peak = opts.gain ?? 0.2;
    const atk = opts.attack ?? 0.005;
    const end = scheduleEnvelope(g.gain, t0, opts.dur, peak, atk);
    osc.connect(g).connect(out);
    this.track(osc, [osc, g]);
    osc.start(t0);
    osc.stop(end);
  }

  // ------------------------------------------------------------- ambience
  private startDrone() {
    const ctx = this.ctx!;
    const loop = this.createLoop(this.master!);
    const o1 = loop.source(ctx.createOscillator());
    o1.type = 'sine';
    o1.frequency.value = 52;
    const og = loop.node(ctx.createGain());
    og.gain.value = 0.5;
    o1.connect(og).connect(loop.gain);
    o1.start();
    const o2 = loop.source(ctx.createOscillator());
    o2.type = 'sine';
    o2.frequency.value = 104.5;
    const og2 = loop.node(ctx.createGain());
    og2.gain.value = 0.08;
    o2.connect(og2).connect(loop.gain);
    o2.start();
    // Keep the low room hum without an always-on broadband noise floor.
    smoothAudioParam(loop.gain.gain, 0.11, ctx.currentTime, 1.2);
  }

  private startBuzz() {
    const ctx = this.ctx!;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'linear';
    pan.refDistance = 2.5;
    pan.maxDistance = 26;
    pan.rolloffFactor = 1;
    pan.connect(this.sfxBus!);
    const loop = this.createLoop(pan);
    loop.node(pan);
    const osc = loop.source(ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.value = 118;
    osc.connect(loop.gain);
    osc.start();
    const overtone = loop.source(ctx.createOscillator());
    overtone.type = 'sine';
    overtone.frequency.value = 236;
    const harmonicGain = loop.node(ctx.createGain());
    harmonicGain.gain.value = 0.12;
    overtone.connect(harmonicGain).connect(loop.gain);
    overtone.start();
    this.buzzSrc = { loop, pan };
  }

  /** Position the fluorescent buzz at the nearest light fixture. */
  setBuzz(pos: THREE.Vector3 | null, intensity: number) {
    if (!this.buzzSrc || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (pos) {
      smoothAudioParam(this.buzzSrc.pan.positionX, pos.x, t, 0.1);
      smoothAudioParam(this.buzzSrc.pan.positionY, pos.y, t, 0.1);
      smoothAudioParam(this.buzzSrc.pan.positionZ, pos.z, t, 0.1);
    }
    const audible = pos && pos.distanceToSquared(this.listenerPosition) < 26 * 26;
    smoothAudioParam(this.buzzSrc.loop.gain.gain, audible ? 0.014 * clamp(intensity, 0, 1.6) : 0, t, 0.16);
  }

  setDanger(v: number) {
    this.danger = clamp(v, 0, 1);
  }

  // ------------------------------------------------------------- vents
  /** Tonal fan motor with slow modulation instead of a looping noise buffer. */
  startFanHum() {
    if (!this.ctx || this.fanNodes) return;
    const ctx = this.ctx;
    const loop = this.createLoop(this.sfxBus!);
    const osc = loop.source(ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.value = 88;
    const breath = loop.node(ctx.createGain());
    breath.gain.value = 0.75;
    const lfo = loop.source(ctx.createOscillator());
    lfo.frequency.value = 0.6;
    const modulation = loop.node(ctx.createGain());
    modulation.gain.value = 0.15;
    lfo.connect(modulation).connect(breath.gain);
    osc.connect(breath).connect(loop.gain);
    osc.start();
    lfo.start();
    smoothAudioParam(loop.gain.gain, 0.045, ctx.currentTime, 0.5);
    this.fanNodes = loop;
  }

  stopFanHum() {
    this.fanNodes?.stop(0.15);
    this.fanNodes = null;
  }

  /** Long metallic groan from somewhere inside the ductwork. */
  ventCreak(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 40);
    this.tone(out, { type: 'sawtooth', freq: rand(70, 130), freqTo: rand(45, 70), dur: rand(0.5, 1.1), gain: 0.06 });
    this.tone(out, { type: 'square', freq: rand(300, 620), freqTo: 140, dur: 0.16, gain: 0.02, delay: 0.12 });
  }

  /** Fingernails on galvanized steel — the stalker saying hello. */
  ventTap(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 42);
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      this.noise(out, { dur: 0.05, type: 'bandpass', freq: rand(1500, 2600), q: 5, gain: 0.12, delay: i * rand(0.18, 0.3) });
    }
  }

  /** The Crawler announcing a hunt. Do not be in the vents when you hear it. */
  crawlerScreech(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 55);
    this.tone(out, { type: 'sawtooth', freq: 1400, freqTo: 300, dur: 0.7, gain: 0.12 });
    this.tone(out, { type: 'sawtooth', freq: 1900, freqTo: 420, dur: 0.55, gain: 0.07, delay: 0.05 });
    this.noise(out, { dur: 0.6, type: 'bandpass', freq: 900, sweepTo: 2400, q: 2, gain: 0.1 });
  }

  splashStep() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, { dur: 0.22, type: 'bandpass', freq: 800, sweepTo: 300, gain: 0.14 });
    this.noise(out, { dur: 0.1, type: 'lowpass', freq: 400, gain: 0.1, delay: 0.03 });
  }

  /** Electrical arc — the flooded complex bites. */
  zap(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 40);
    this.noise(out, { dur: 0.14, type: 'highpass', freq: 3000, gain: 0.22 });
    this.tone(out, { type: 'sawtooth', freq: 120, freqTo: 40, dur: 0.2, gain: 0.12, delay: 0.02 });
  }

  startGeneratorHum() {
    if (!this.ctx || this.genHum) return;
    const ctx = this.ctx;
    const loop = this.createLoop(this.sfxBus!);
    const osc = loop.source(ctx.createOscillator());
    osc.type = 'triangle';
    osc.frequency.value = 58;
    const f = loop.node(ctx.createBiquadFilter());
    f.type = 'lowpass';
    f.frequency.value = 240;
    f.Q.value = 0.5;
    osc.connect(f).connect(loop.gain);
    osc.start();
    smoothAudioParam(loop.gain.gain, 0.035, ctx.currentTime, 1.2);
    this.genHum = loop;
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (!this.ctx) return;
    // heartbeat
    if (this.danger > 0.25) {
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        const rate = lerpRate(this.danger);
        this.heartTimer = rate;
        const out = this.sfxBus!;
        this.tone(out, { type: 'sine', freq: 58, freqTo: 34, dur: 0.16, gain: 0.5 * this.danger });
        this.tone(out, { type: 'sine', freq: 52, freqTo: 30, dur: 0.13, gain: 0.34 * this.danger, delay: 0.17 });
      }
    }
    // random distant unsettling events
    this.ambientTimer -= dt;
    if (this.ambientTimer <= 0) {
      this.ambientTimer = rand(9, 24);
      const ang = rand(0, Math.PI * 2);
      const d = rand(14, 30);
      const pos = new THREE.Vector3(playerPos.x + Math.cos(ang) * d, 1.6, playerPos.z + Math.sin(ang) * d);
      const roll = Math.random();
      if (roll < 0.4) {
        // distant metallic clank
        const out = this.panner(pos, 60);
        this.tone(out, { type: 'triangle', freq: rand(300, 700), freqTo: 90, dur: 0.5, gain: 0.12 });
        this.noise(out, { dur: 0.2, type: 'bandpass', freq: 1800, gain: 0.05 });
      } else if (roll < 0.75) {
        // far footsteps on carpet — three soft taps
        const out = this.panner(pos, 55);
        for (let i = 0; i < 3; i++) {
          this.noise(out, { dur: 0.09, type: 'lowpass', freq: 300, gain: 0.16, delay: i * 0.42 });
        }
      } else {
        // faint whisper sweep
        const out = this.panner(pos, 50);
        this.noise(out, { dur: 1.6, type: 'bandpass', freq: 900, sweepTo: 2400, q: 6, gain: 0.035 });
      }
    }
  }

  // -------------------------------------------------------------- weapons
  shot(kind: ShotKind) {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    switch (kind) {
      case 'pistol':
        this.noise(out, { dur: 0.22, type: 'lowpass', freq: 3400, sweepTo: 300, gain: 0.55 });
        this.tone(out, { type: 'square', freq: 160, freqTo: 46, dur: 0.12, gain: 0.30 });
        this.noise(out, { dur: 0.05, type: 'highpass', freq: 2500, gain: 0.25 });
        break;
      case 'shotgun':
        this.noise(out, { dur: 0.5, type: 'lowpass', freq: 2600, sweepTo: 120, gain: 0.95 });
        this.tone(out, { type: 'square', freq: 110, freqTo: 30, dur: 0.3, gain: 0.5 });
        this.noise(out, { dur: 0.08, type: 'highpass', freq: 1800, gain: 0.3 });
        break;
      case 'smg':
        this.noise(out, { dur: 0.14, type: 'lowpass', freq: 3800, sweepTo: 500, gain: 0.4 });
        this.tone(out, { type: 'square', freq: 190, freqTo: 60, dur: 0.08, gain: 0.22 });
        break;
      case 'rifle':
        this.noise(out, { dur: 0.3, type: 'lowpass', freq: 3000, sweepTo: 200, gain: 0.65 });
        this.tone(out, { type: 'sawtooth', freq: 130, freqTo: 38, dur: 0.18, gain: 0.34 });
        this.noise(out, { dur: 0.06, type: 'highpass', freq: 2200, gain: 0.28 });
        break;
      case 'magnum':
        // big-bore hand cannon: long, floor-shaking report
        this.noise(out, { dur: 0.46, type: 'lowpass', freq: 2400, sweepTo: 90, gain: 0.9 });
        this.tone(out, { type: 'square', freq: 92, freqTo: 26, dur: 0.3, gain: 0.46 });
        this.noise(out, { dur: 0.07, type: 'highpass', freq: 2000, gain: 0.3 });
        this.tone(out, { type: 'sine', freq: 46, freqTo: 28, dur: 0.4, gain: 0.2, delay: 0.04 });
        break;
      case 'ak':
        // slower, heavier cycle — the Kalashnikov bark
        this.noise(out, { dur: 0.3, type: 'lowpass', freq: 2500, sweepTo: 140, gain: 0.72 });
        this.tone(out, { type: 'sawtooth', freq: 104, freqTo: 34, dur: 0.2, gain: 0.4 });
        this.noise(out, { dur: 0.05, type: 'highpass', freq: 1700, gain: 0.26 });
        break;
      case 'm16':
        // crisper, tighter report than the AK
        this.noise(out, { dur: 0.18, type: 'lowpass', freq: 3600, sweepTo: 320, gain: 0.5 });
        this.tone(out, { type: 'square', freq: 148, freqTo: 52, dur: 0.1, gain: 0.28 });
        this.noise(out, { dur: 0.05, type: 'highpass', freq: 2600, gain: 0.26 });
        break;
      case 'bazooka':
        // heavy mechanical thunk, then the motor's roaring whoosh
        this.tone(out, { type: 'square', freq: 70, freqTo: 30, dur: 0.25, gain: 0.5 });
        this.noise(out, { dur: 0.9, type: 'bandpass', freq: 600, sweepTo: 2200, q: 0.6, gain: 0.55 });
        this.noise(out, { dur: 0.35, type: 'lowpass', freq: 1200, sweepTo: 150, gain: 0.6 });
        break;
      case 'rocket':
        // sharper ignition crack + a rising electronic chirp from the seeker
        this.noise(out, { dur: 0.08, type: 'highpass', freq: 2400, gain: 0.35 });
        this.noise(out, { dur: 0.7, type: 'bandpass', freq: 900, sweepTo: 3200, q: 0.9, gain: 0.45 });
        this.tone(out, { type: 'sawtooth', freq: 110, freqTo: 40, dur: 0.22, gain: 0.32 });
        this.tone(out, { type: 'sine', freq: 1500, freqTo: 2600, dur: 0.12, gain: 0.06, delay: 0.02 });
        break;
      case 'antimatter':
        // reality tearing: a falling sub-bass and an inverted shimmer
        this.tone(out, { type: 'sine', freq: 220, freqTo: 28, dur: 0.9, gain: 0.55 });
        this.tone(out, { type: 'sawtooth', freq: 1800, freqTo: 90, dur: 0.6, gain: 0.08 });
        this.noise(out, { dur: 0.6, type: 'bandpass', freq: 3000, sweepTo: 200, q: 4, gain: 0.18 });
        break;
      case 'sniper':
        // supersonic crack + long rolling tail that fills the hall
        this.noise(out, { dur: 0.06, type: 'highpass', freq: 2800, gain: 0.42 });
        this.noise(out, { dur: 0.85, type: 'lowpass', freq: 3000, sweepTo: 70, gain: 0.85 });
        this.tone(out, { type: 'square', freq: 82, freqTo: 24, dur: 0.5, gain: 0.42 });
        this.tone(out, { type: 'sine', freq: 40, freqTo: 26, dur: 0.7, gain: 0.24, delay: 0.03 });
        break;
    }
  }

  /** Big positional blast for rockets — volume scales with size. */
  explosion(pos: THREE.Vector3, size = 1) {
    if (!this.ctx) return;
    const out = this.panner(pos, 80);
    this.noise(out, { dur: 1.3 * size, type: 'lowpass', freq: 1800, sweepTo: 60, gain: 0.95 });
    this.tone(out, { type: 'sine', freq: 70, freqTo: 22, dur: 1.0 * size, gain: 0.7 });
    this.noise(out, { dur: 0.12, type: 'highpass', freq: 1500, gain: 0.4 });
    // debris patter
    for (let i = 0; i < 4; i++) {
      this.noise(out, { dur: 0.06, type: 'bandpass', freq: rand(800, 2400), gain: 0.08, delay: 0.25 + i * rand(0.08, 0.2) });
    }
  }

  /** Anti-matter: the projector winding up. */
  chargeHum() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.tone(out, { type: 'sawtooth', freq: 60, freqTo: 420, dur: 0.7, gain: 0.08, attack: 0.3 });
    this.tone(out, { type: 'sine', freq: 120, freqTo: 840, dur: 0.7, gain: 0.07, attack: 0.3 });
  }

  /** Anomaly birth: low throbbing suction centred on the singularity. */
  anomalyOpen(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 60);
    this.tone(out, { type: 'sine', freq: 38, freqTo: 30, dur: 4.2, gain: 0.55, attack: 0.4 });
    this.tone(out, { type: 'sawtooth', freq: 76, freqTo: 52, dur: 4.0, gain: 0.08, attack: 0.6 });
    this.noise(out, { dur: 4.0, type: 'bandpass', freq: 300, sweepTo: 1600, q: 2, gain: 0.12 });
  }

  anomalyCollapse(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 80);
    this.tone(out, { type: 'sine', freq: 400, freqTo: 18, dur: 1.2, gain: 0.7 });
    this.noise(out, { dur: 0.9, type: 'lowpass', freq: 3000, sweepTo: 40, gain: 0.8 });
  }

  lockTone(locked: boolean) {
    if (!this.ctx) return;
    this.tone(this.sfxBus!, { type: 'square', freq: locked ? 1760 : 1180, dur: locked ? 0.18 : 0.05, gain: 0.05 });
  }

  distantShot(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 70);
    this.noise(out, { dur: 0.3, type: 'lowpass', freq: 700, gain: 0.4 });
  }

  dryFire() {
    if (!this.ctx) return;
    this.tone(this.sfxBus!, { type: 'square', freq: 1400, freqTo: 700, dur: 0.04, gain: 0.10 });
  }

  reload(kind: ShotKind, phase: 'out' | 'in' | 'rack') {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    if (phase === 'out') {
      this.noise(out, { dur: 0.07, type: 'bandpass', freq: 900, gain: 0.22 });
      this.tone(out, { type: 'square', freq: 500, freqTo: 240, dur: 0.05, gain: 0.08 });
    } else if (phase === 'in') {
      this.noise(out, { dur: 0.06, type: 'bandpass', freq: 1300, gain: 0.24 });
      if (kind === 'shotgun') this.noise(out, { dur: 0.06, type: 'bandpass', freq: 800, gain: 0.2, delay: 0.12 });
    } else {
      this.noise(out, { dur: 0.09, type: 'bandpass', freq: 2000, q: 2, gain: 0.3 });
      this.tone(out, { type: 'square', freq: 800, freqTo: 300, dur: 0.07, gain: 0.12, delay: 0.02 });
    }
  }

  /** Blade whoosh — light blades whistle high, heavy ones tear lower. */
  swing(heavy: boolean) {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, {
      dur: heavy ? 0.22 : 0.15,
      type: 'bandpass',
      freq: heavy ? 500 : 900,
      sweepTo: heavy ? 1600 : 2600,
      q: 1.6,
      gain: heavy ? 0.16 : 0.11,
    });
  }

  pump(delay = 0) {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, { dur: 0.08, type: 'bandpass', freq: 700, gain: 0.3, delay });
    this.noise(out, { dur: 0.08, type: 'bandpass', freq: 1100, gain: 0.3, delay: delay + 0.11 });
  }

  weaponSwitch() {
    if (!this.ctx) return;
    this.noise(this.sfxBus!, { dur: 0.08, type: 'bandpass', freq: 600, gain: 0.14 });
  }

  impactWall(pos: THREE.Vector3, hard = false) {
    if (!this.ctx) return;
    const out = this.panner(pos, 40);
    this.noise(out, { dur: 0.12, type: 'bandpass', freq: hard ? 2400 : 700, gain: 0.22 });
    if (hard) this.tone(out, { type: 'triangle', freq: 2400, freqTo: 900, dur: 0.07, gain: 0.05 });
  }

  hitFlesh(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 40);
    this.noise(out, { dur: 0.14, type: 'lowpass', freq: 800, sweepTo: 200, gain: 0.4 });
    this.tone(out, { type: 'sine', freq: 140, freqTo: 60, dur: 0.1, gain: 0.2 });
  }

  // -------------------------------------------------------------- player
  footstep(running: boolean, crouched: boolean) {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, {
      dur: running ? 0.11 : 0.09,
      type: 'lowpass',
      freq: crouched ? 240 : 340,
      gain: crouched ? 0.05 : running ? 0.16 : 0.10,
    });
  }

  jumpLand() {
    if (!this.ctx) return;
    this.noise(this.sfxBus!, { dur: 0.14, type: 'lowpass', freq: 260, gain: 0.2 });
    this.tone(this.sfxBus!, { type: 'sine', freq: 90, freqTo: 45, dur: 0.12, gain: 0.12 });
  }

  hurt() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.tone(out, { type: 'sawtooth', freq: 220, freqTo: 70, dur: 0.22, gain: 0.16 });
    this.noise(out, { dur: 0.2, type: 'lowpass', freq: 900, gain: 0.22 });
  }

  exhaustedBreath() {
    if (!this.ctx) return;
    this.noise(this.sfxBus!, { dur: 0.5, type: 'bandpass', freq: 700, q: 1.4, gain: 0.07 });
  }

  heal() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, { dur: 0.3, type: 'bandpass', freq: 500, gain: 0.12 });
    this.tone(out, { type: 'sine', freq: 520, freqTo: 760, dur: 0.25, gain: 0.06, delay: 0.15 });
  }

  // -------------------------------------------------------------- world
  doorMove(open: boolean, pos: THREE.Vector3, locked = false) {
    if (!this.ctx) return;
    const out = this.panner(pos, 34);
    if (locked) {
      this.tone(out, { type: 'square', freq: 210, dur: 0.09, gain: 0.14 });
      this.tone(out, { type: 'square', freq: 160, dur: 0.12, gain: 0.14, delay: 0.13 });
      return;
    }
    // servo + slab scrape
    this.tone(out, { type: 'sawtooth', freq: open ? 90 : 110, freqTo: open ? 150 : 70, dur: 0.7, gain: 0.05 });
    this.noise(out, { dur: 0.7, type: 'bandpass', freq: 500, sweepTo: open ? 900 : 350, gain: 0.1 });
    this.noise(out, { dur: 0.08, type: 'lowpass', freq: 300, gain: 0.2, delay: 0.68 });
  }

  pickup() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.tone(out, { type: 'triangle', freq: 660, dur: 0.07, gain: 0.12 });
    this.tone(out, { type: 'triangle', freq: 990, dur: 0.1, gain: 0.12, delay: 0.07 });
  }

  keycard() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.tone(out, { type: 'square', freq: 1180, dur: 0.07, gain: 0.08 });
    this.tone(out, { type: 'square', freq: 1560, dur: 0.12, gain: 0.08, delay: 0.09 });
  }

  crateOpen() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, { dur: 0.25, type: 'bandpass', freq: 400, sweepTo: 900, gain: 0.18 });
    this.tone(out, { type: 'triangle', freq: 180, freqTo: 90, dur: 0.15, gain: 0.1, delay: 0.05 });
  }

  generatorStart() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.tone(out, { type: 'sawtooth', freq: 40, freqTo: 82, dur: 1.6, gain: 0.16 });
    this.noise(out, { dur: 1.2, type: 'lowpass', freq: 400, sweepTo: 900, gain: 0.1 });
    this.tone(out, { type: 'square', freq: 900, dur: 0.06, gain: 0.08, delay: 0.2 });
    this.tone(out, { type: 'square', freq: 900, dur: 0.06, gain: 0.08, delay: 0.55 });
  }

  powerSurge() {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    this.noise(out, { dur: 0.4, type: 'highpass', freq: 3000, gain: 0.12 });
    this.tone(out, { type: 'sawtooth', freq: 60, freqTo: 220, dur: 0.5, gain: 0.12 });
  }

  uiClick() {
    if (!this.ctx) return;
    this.tone(this.sfxBus!, { type: 'triangle', freq: 740, freqTo: 520, dur: 0.06, gain: 0.1 });
  }

  noteOpen() {
    if (!this.ctx) return;
    this.noise(this.sfxBus!, { dur: 0.22, type: 'bandpass', freq: 1600, q: 1, gain: 0.08 });
  }

  stinger(intensity = 1) {
    if (!this.ctx) return;
    const out = this.sfxBus!;
    // dissonant string cluster swell
    [196, 207.6, 392, 415.3].forEach((f, i) => {
      this.tone(out, { type: 'sawtooth', freq: f * rand(0.99, 1.01), dur: 1.8, gain: 0.028 * intensity, attack: 0.5, delay: i * 0.05 });
    });
    this.noise(out, { dur: 1.4, type: 'bandpass', freq: 3000, sweepTo: 500, q: 3, gain: 0.05 * intensity });
  }

  alarmLoop(): () => void {
    if (!this.ctx) return () => undefined;
    this.alarm?.stop();
    const ctx = this.ctx;
    const loop = this.createLoop(this.sfxBus!);
    const osc = loop.source(ctx.createOscillator());
    osc.type = 'triangle';
    osc.frequency.value = 620;
    const lfo = loop.source(ctx.createOscillator());
    lfo.frequency.value = 0.9;
    const lfoG = loop.node(ctx.createGain());
    lfoG.gain.value = 140;
    lfo.connect(lfoG).connect(osc.frequency);
    osc.connect(loop.gain);
    osc.start();
    lfo.start();
    smoothAudioParam(loop.gain.gain, 0.045, ctx.currentTime, 0.06);
    this.alarm = loop;
    return () => {
      loop.stop();
      if (this.alarm === loop) this.alarm = null;
    };
  }

  // -------------------------------------------------------------- enemies
  /** Creates a looping positional voice for an enemy. Returns a handle. */
  enemyVoice(kind: EnemyVoiceKind): EnemyVoice {
    const voice = new EnemyVoice(
      this.ctx, this.sfxBus, kind, this.listenerPosition,
      (output) => this.createLoop(output),
      (ended) => this.voices.delete(ended),
    );
    if (this.ctx) this.voices.add(voice);
    return voice;
  }

  enemyAttack(kind: EnemyVoiceKind, pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 44);
    if (kind === 'runner') {
      this.tone(out, { type: 'sawtooth', freq: 700, freqTo: 180, dur: 0.3, gain: 0.22 });
      this.noise(out, { dur: 0.25, type: 'bandpass', freq: 1400, sweepTo: 500, gain: 0.2 });
    } else if (kind === 'heavy') {
      this.tone(out, { type: 'sawtooth', freq: 90, freqTo: 40, dur: 0.5, gain: 0.4 });
      this.noise(out, { dur: 0.4, type: 'lowpass', freq: 500, gain: 0.3 });
    } else if (kind === 'watcher') {
      this.noise(out, { dur: 0.7, type: 'bandpass', freq: 2600, sweepTo: 700, q: 4, gain: 0.3 });
      this.tone(out, { type: 'sawtooth', freq: 880, freqTo: 220, dur: 0.6, gain: 0.12 });
    } else {
      this.tone(out, { type: 'sawtooth', freq: 130, freqTo: 60, dur: 0.45, gain: 0.3 });
      this.noise(out, { dur: 0.4, type: 'bandpass', freq: 600, sweepTo: 200, gain: 0.22 });
    }
  }

  enemyDie(kind: EnemyVoiceKind, pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 44);
    const base = kind === 'heavy' ? 70 : kind === 'watcher' ? 500 : 160;
    this.tone(out, { type: 'sawtooth', freq: base * 1.6, freqTo: base * 0.4, dur: 0.9, gain: 0.3 });
    this.noise(out, { dur: 0.7, type: 'lowpass', freq: 900, sweepTo: 120, gain: 0.3 });
  }

  enemyStep(kind: EnemyVoiceKind, pos: THREE.Vector3) {
    if (!this.ctx) return;
    const out = this.panner(pos, 30);
    const heavy = kind === 'heavy';
    this.noise(out, { dur: heavy ? 0.16 : 0.08, type: 'lowpass', freq: heavy ? 200 : 300, gain: heavy ? 0.5 : 0.2 });
    if (heavy) this.tone(out, { type: 'sine', freq: 60, freqTo: 34, dur: 0.14, gain: 0.2 });
  }

  /** Keep the room tone, but retire everything belonging to the previous run. */
  reset() {
    for (const voice of [...this.voices]) voice.dispose();
    this.stopLiveSources();
    this.stopFanHum();
    this.genHum?.stop(0.1);
    this.genHum = null;
    this.alarm?.stop();
    this.alarm = null;
    this.setBuzz(null, 0);
    this.danger = 0;
    this.heartTimer = 0;
    this.ambientTimer = 6;
  }

  /** React remounts and hot updates must not leave an old audio graph running. */
  dispose() {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.started = false;
    liveEngines.delete(this);
    const ctx = this.ctx;
    const master = this.master;
    const bus = this.sfxBus;
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.noiseBuf = null;
    this.buzzSrc = null;
    if (!ctx) return;

    const close = () => {
      for (const loop of [...this.loops]) loop.stop(0);
      this.stopLiveSources();
      master?.disconnect();
      bus?.disconnect();
      if (ctx.state !== 'closed') {
        void ctx.close().catch((error: unknown) => console.warn('[AUDIO] Close failed:', error));
      }
    };
    if (ctx.state === 'running' && master) {
      smoothAudioParam(master.gain, 0, ctx.currentTime, 0.025);
      window.setTimeout(close, 50);
    } else {
      close();
    }
  }
}

function lerpRate(danger: number): number {
  return 1.05 - danger * 0.55; // seconds between beats
}

/** Pink noise used only by enveloped one-shot effects, never looped. */
function makeEffectNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    data[i] = pink * 0.11;
  }
  return buf;
}

/** Nearby entities get a filtered tonal voice; distant ones allocate no oscillators. */
export class EnemyVoice {
  private loop: AudioLoop | null = null;
  private pan: PannerNode | null = null;
  private readonly baseGain: number;
  private updatedAt = -Infinity;
  private disposed = false;

  constructor(
    private readonly ctx: AudioContext | null,
    private readonly bus: GainNode | null,
    private readonly kind: EnemyVoiceKind,
    private readonly listener: THREE.Vector3,
    private readonly createLoop: (output: AudioNode) => AudioLoop,
    private readonly onDispose: (voice: EnemyVoice) => void,
  ) {
    this.baseGain = { stalker: 0.42, runner: 0.36, watcher: 0.5, heavy: 0.55 }[kind];
    this.disposed = !ctx || !bus;
  }

  private start(pos: THREE.Vector3) {
    const ctx = this.ctx!;
    const kind = this.kind;
    const pan = ctx.createPanner();
    const loop = this.createLoop(pan);
    loop.node(pan);
    this.pan = pan;
    this.loop = loop;
    this.pan.panningModel = 'equalpower';
    this.pan.distanceModel = 'linear';
    this.pan.refDistance = 2.5;
    this.pan.maxDistance = 32;
    this.pan.rolloffFactor = 1;
    this.pan.positionX.value = pos.x;
    this.pan.positionY.value = pos.y;
    this.pan.positionZ.value = pos.z;
    this.pan.connect(this.bus!);

    const filter = loop.node(ctx.createBiquadFilter());
    filter.type = 'lowpass';
    filter.frequency.value = { stalker: 550, runner: 900, watcher: 2600, heavy: 320 }[kind];
    filter.Q.value = 0.5;
    const breath = loop.node(ctx.createGain());
    breath.gain.value = 0.8;
    const breathing = loop.source(ctx.createOscillator());
    breathing.frequency.value = kind === 'runner' ? 2.8 : 0.45;
    const breathAmount = loop.node(ctx.createGain());
    breathAmount.gain.value = kind === 'watcher' ? 0.06 : 0.16;
    breathing.connect(breathAmount).connect(breath.gain);
    filter.connect(breath).connect(loop.gain);
    breathing.start();

    const mk = (type: OscillatorType, freq: number, g: number, lfoFreq?: number, lfoAmt?: number) => {
      const o = loop.source(ctx.createOscillator());
      o.type = type;
      o.frequency.value = freq;
      const og = loop.node(ctx.createGain());
      og.gain.value = g;
      if (lfoFreq && lfoAmt) {
        const lfo = loop.source(ctx.createOscillator());
        lfo.frequency.value = lfoFreq;
        const lg = loop.node(ctx.createGain());
        lg.gain.value = lfoAmt;
        lfo.connect(lg).connect(o.frequency);
        lfo.start();
      }
      o.connect(og).connect(filter);
      o.start();
    };

    switch (kind) {
      case 'stalker': // wet breathing + low moan
        mk('triangle', 64, 0.10, 0.14, 9);
        mk('sine', 128, 0.04, 0.23, 20);
        break;
      case 'runner': // rapid panting rasp
        mk('triangle', 210, 0.045, 2.6, 40);
        mk('sine', 96, 0.04, 3.1, 12);
        break;
      case 'watcher': // near-silent reversed-string shimmer
        mk('sine', 1244, 0.016, 0.07, 60);
        mk('sine', 1866, 0.010, 0.05, 90);
        break;
      case 'heavy': // deep engine-like growl
        mk('triangle', 44, 0.24, 0.4, 6);
        mk('sine', 66.5, 0.12, 0.31, 5);
        break;
    }
  }

  update(pos: THREE.Vector3, active: number, agitated: number) {
    if (this.disposed || !this.ctx || this.ctx.state !== 'running') return;
    // Hysteresis keeps a voice from repeatedly restarting at the hearing boundary.
    const range = this.loop ? 32 : 29;
    const a = clamp(active, 0, 1);
    if (a < 0.08 || pos.distanceToSquared(this.listener) >= range * range) {
      this.loop?.stop(0.12);
      this.loop = null;
      this.pan = null;
      this.updatedAt = -Infinity;
      return;
    }
    if (!this.loop) this.start(pos);
    const t = this.ctx.currentTime;
    if (t - this.updatedAt < 0.05) return;
    this.updatedAt = t;
    smoothAudioParam(this.pan!.positionX, pos.x, t);
    smoothAudioParam(this.pan!.positionY, pos.y, t);
    smoothAudioParam(this.pan!.positionZ, pos.z, t);
    const target = this.baseGain * a * (0.55 + clamp(agitated, 0, 1) * 0.45);
    smoothAudioParam(this.loop!.gain.gain, target, t, 0.12);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loop?.stop();
    this.loop = null;
    this.pan = null;
    this.onDispose(this);
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const engine of [...liveEngines]) engine.dispose();
  });
}
