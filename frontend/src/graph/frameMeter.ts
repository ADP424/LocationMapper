/**
 * How many elements this machine can vector-draw inside a frame.
 *
 * Nothing about that number can be known statically — it depends on the GPU, the
 * device pixel ratio and whether the user is on battery. So it is measured: the
 * interval between consecutive Cytoscape `render` events, while rendering is
 * continuous, *is* the frame time.
 */
export class DrawBudget {
  private ema = 16;
  private value = 1500;
  private last = 0;

  sample(now: number) {
    if (this.last && now - this.last < 120) {
      this.ema = this.ema * 0.85 + (now - this.last) * 0.15;
      if (this.ema > 22) this.value = Math.max(300, this.value * 0.9);
      else if (this.ema < 13) this.value = Math.min(20_000, this.value * 1.02);
    }
    this.last = now;
  }

  get elements() {
    return Math.round(this.value);
  }
  get frameMs() {
    return this.ema;
  }
}
