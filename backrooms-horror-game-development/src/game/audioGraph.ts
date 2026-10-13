/** Retarget automation without accumulating old ramps or jumping mid-wave. */
export function smoothAudioParam(param: AudioParam, value: number, now: number, seconds = 0.05) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(now);
  } else {
    const current = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
  }
  param.linearRampToValueAtTime(value, now + seconds);
}

/** Finish at actual zero before stopping a source, not at a nonzero floor. */
export function scheduleEnvelope(gain: AudioParam, start: number, duration: number, peak: number, attack = 0.008): number {
  const end = start + Math.max(0.02, duration);
  gain.setValueAtTime(0, start);
  gain.linearRampToValueAtTime(Math.max(0.0001, peak), start + Math.min(attack, duration * 0.4));
  gain.exponentialRampToValueAtTime(0.0001, end);
  gain.linearRampToValueAtTime(0, end + 0.02);
  return end + 0.025;
}

/** A looping sound owns every oscillator, modulator, filter, and gain it uses. */
export class AudioLoop {
  readonly gain: GainNode;
  private nodes = new Set<AudioNode>();
  private sources = new Set<AudioScheduledSourceNode>();
  private stopping = false;
  private disposed = false;

  constructor(
    private readonly ctx: AudioContext,
    output: AudioNode,
    private readonly onDispose: (loop: AudioLoop) => void,
  ) {
    this.gain = this.node(ctx.createGain());
    this.gain.gain.value = 0;
    this.gain.connect(output);
  }

  node<T extends AudioNode>(node: T): T {
    this.nodes.add(node);
    return node;
  }

  source<T extends AudioScheduledSourceNode>(source: T): T {
    this.node(source);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (this.stopping && this.sources.size === 0) this.finish();
    };
    return source;
  }

  stop(release = 0.05) {
    if (this.disposed) return;
    if (release <= 0 || this.ctx.state !== 'running' || this.sources.size === 0) {
      this.finish();
      return;
    }
    if (this.stopping) return;
    this.stopping = true;
    const now = this.ctx.currentTime;
    smoothAudioParam(this.gain.gain, 0, now, release);
    for (const source of this.sources) source.stop(now + release + 0.005);
  }

  private finish() {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Source may already have ended. */ }
    }
    for (const node of this.nodes) node.disconnect();
    this.sources.clear();
    this.nodes.clear();
    this.onDispose(this);
  }
}