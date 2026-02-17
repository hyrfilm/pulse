/**
 * pulse-sync.ts — Browser client library for the pulse protocol.
 *
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** JSON message sent by the server on every pulse. */
export interface PulseMessage {
  type: "pulse";
  seq: number;
  period_ms: number;
  now_ms: number;
  next_ms: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options passed to the PulseSyncClient constructor. */
export interface PulseSyncOptions {
  /** WebSocket URL. Defaults to ws(s)://<location.host>/ws */
  url?: string;
  /**
   * Maximum absolute prediction error (ms) that is still considered "stable".
   * @default 10
   */
  thresholdMs?: number;
  /**
   * Number of pulses in the rolling stability window used to decide lock.
   * @default 7
   */
  requiredStablePulses?: number;
  /**
   * Number of outlier pulses allowed inside the rolling stability window.
   * Useful on higher-jitter WAN links where a single spike should not reset
   * lock acquisition.
   * @default 2
   */
  allowedUnstablePulses?: number;
  /**
   * EWM smoothing factor for the arrival-bias estimate (0 < beta ≤ 1).
   * Smaller values react more slowly but are more stable.
   * @default 0.001
   */
  beta?: number;
  /**
   * Maximum absolute error used to adapt arrival bias. Larger outliers are
   * clipped for bias updates to avoid overreacting to one-off network spikes.
   * @default 25
   */
  maxBiasCorrectionMs?: number;
  /**
   * Keep lock after it is acquired and disconnect from the server immediately.
   * While disconnected, time continues locally from the lock instant.
   * @default true
   */
  stickyLock?: boolean;
}

/** Snapshot kept for each successfully processed pulse. */
export interface LastPulse {
  seq: number;
  serverNowMs: number;
  serverNextMs: number;
  periodMs: number;
  /** `performance.now()` value at the moment the message was received. */
  arrivalMonoMs: number;
}

/** Payload for `"pulse"` CustomEvent. */
export interface PulseEventDetail {
  seq: number;
  periodMs: number;
  serverNowMs: number;
  serverNextMs: number;
  arrivalMonoMs: number;
  /** `null` on the very first pulse (no prior prediction exists). */
  predictedArrivalMonoMs: number | null;
  /** Actual arrival minus predicted arrival. `null` on the first pulse. */
  errorMs: number | null;
  /** Current smoothed arrival bias. */
  biasMs: number;
  /** Number of stable pulses inside the rolling window. */
  stableCount: number;
  locked: boolean;
  /** Estimated server wall-clock time at the moment the pulse arrived. */
  estimatedServerNowMs: number | null;
  /** Elapsed local time since lock was acquired. */
  elapsedSinceLockMs: number | null;
}

/** Detail carried by the `"status"` CustomEvent. */
export interface StatusEventDetail {
  connected: boolean;
}

/** Detail carried by the `"lock"` CustomEvent. */
export interface LockEventDetail {
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Typed EventTarget helpers
// ---------------------------------------------------------------------------

/** event map for PulseSyncClient. */
export interface PulseSyncEventMap {
  pulse: CustomEvent<PulseEventDetail>;
  status: CustomEvent<StatusEventDetail>;
  lock: CustomEvent<LockEventDetail>;
}


// Client
//TODO: Refactor into the communication mechanism / calculations + predictions
export class PulseSyncClient extends EventTarget {
  readonly url: string;
  readonly thresholdMs: number;
  readonly requiredStablePulses: number;
  readonly allowedUnstablePulses: number;
  readonly beta: number;
  readonly maxBiasCorrectionMs: number;
  readonly stickyLock: boolean;

  private ws: WebSocket | null = null;

  connected: boolean = false;
  lastPulse: LastPulse | null = null;
  private lastPredictedArrivalMono: number | null = null;
  arrivalBiasMs: number = 0;
  stableCount: number = 0;
  private recentStability: boolean[] = [];
  private preserveStateOnClose: boolean = false;
  private lockOriginMonoMs: number | null = null;
  private lockOriginServerMs: number | null = null;
  locked: boolean = false;
  estimatedServerNowMs: number | null = null;

  constructor(opts: PulseSyncOptions = {}) {
    super();
    this.url = opts.url ?? defaultWSURL();
    this.thresholdMs = finiteOr(opts.thresholdMs, 5);
    this.requiredStablePulses = Math.max(1, Math.floor(finiteOr(opts.requiredStablePulses, 15)));
    this.allowedUnstablePulses = Math.max(0, Math.floor(finiteOr(opts.allowedUnstablePulses, 2)));
    this.beta = finiteOr(opts.beta, 0.05);
    this.maxBiasCorrectionMs = Math.max(0.001, finiteOr(opts.maxBiasCorrectionMs, 25));
    this.stickyLock = opts.stickyLock ?? true;
  }

  connect(): void {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.connected = true;
      this.dispatch("status", { connected: true });
    });

    ws.addEventListener("close", () => {
      const preserveState = this.preserveStateOnClose;
      this.preserveStateOnClose = false;
      this.connected = false;
      this.ws = null;
      if (!preserveState) {
        this.locked = false;
        this.stableCount = 0;
        this.recentStability = [];
        this.clearLockOrigin();
      }
      this.dispatch("status", { connected: false });
    });

    ws.addEventListener("message", (ev: MessageEvent<string>) => {
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isPulseMessage(msg)) return;
      this.handlePulse(msg);
    });
  }

  disconnect(preserveLock: boolean = false): void {
    if (!this.ws) return;
    this.preserveStateOnClose = preserveLock && this.locked;
    this.ws.close();
    this.ws = null;
    this.connected = false;
  }

  /**
   * Estimated server wall-clock time right now (ms since Unix epoch).
   * Returns `null` when not locked or no pulse has been received.
   */
  serverNowMs(): number | null {
    if (!this.locked) return null;
    if (this.lockOriginMonoMs !== null && this.lockOriginServerMs !== null) {
      const elapsed = performance.now() - this.lockOriginMonoMs;
      return this.lockOriginServerMs + elapsed;
    }
    if (!this.lastPulse) return null;
    const elapsed = performance.now() - this.lastPulse.arrivalMonoMs;
    return this.lastPulse.serverNowMs + elapsed;
  }

  /**
   * Local elapsed time (ms) since lock was acquired.
   * Returns `null` when not locked.
   */
  elapsedSinceLockMs(): number | null {
    if (!this.locked || this.lockOriginMonoMs === null) return null;
    return Math.max(0, performance.now() - this.lockOriginMonoMs);
  }

  /**
   * Predicted monotonic timestamp (`performance.now()` basis) of the next
   * pulse arrival. Returns `null` when no pulse has been received yet.
   */
  predictNextArrivalMonoMs(): number | null {
    if (!this.lastPulse) return null;
    return this.lastPulse.arrivalMonoMs + this.lastPulse.periodMs + this.arrivalBiasMs;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  //TODO: sticky-lock is a terrible name for this, come with something else
  private handlePulse(pulse: PulseMessage): void {
    // In sticky-lock mode we keep local time once lock is acquired.
    if (this.stickyLock && this.locked) return;

    const arrivalMonoMs = performance.now();
    const previousPrediction = this.lastPredictedArrivalMono;
    let errorMs: number | null = null;

    if (previousPrediction !== null) {
      errorMs = arrivalMonoMs - previousPrediction;
      const correction = clamp(errorMs, -this.maxBiasCorrectionMs, this.maxBiasCorrectionMs);
      this.arrivalBiasMs += this.beta * correction;
    }

    const periodMs = finiteOr(pulse.period_ms, 1000);
    this.lastPulse = {
      seq: pulse.seq,
      serverNowMs: finiteOr(pulse.now_ms, 0),
      serverNextMs: finiteOr(pulse.next_ms, 0),
      periodMs,
      arrivalMonoMs,
    };

    this.lastPredictedArrivalMono = this.predictNextArrivalMonoMs();

    this.updateStability(errorMs);

    const wasLocked = this.locked;
    this.locked =
      this.recentStability.length >= this.requiredStablePulses &&
      this.stableCount >= this.stabilityTarget();
    if (!wasLocked && this.locked) {
      this.captureLockOrigin(arrivalMonoMs);
      this.dispatch("lock", { locked: true });
      if (this.stickyLock) {
        this.disconnect(true);
      }
    } else if (wasLocked && !this.locked) {
      this.clearLockOrigin();
      this.dispatch("lock", { locked: false });
    }

    this.estimatedServerNowMs = this.serverNowMs();

    this.dispatch("pulse", {
      seq: pulse.seq,
      periodMs,
      serverNowMs: this.lastPulse.serverNowMs,
      serverNextMs: this.lastPulse.serverNextMs,
      arrivalMonoMs,
      predictedArrivalMonoMs: previousPrediction,
      errorMs,
      biasMs: this.arrivalBiasMs,
      stableCount: this.stableCount,
      locked: this.locked,
      estimatedServerNowMs: this.estimatedServerNowMs,
      elapsedSinceLockMs: this.elapsedSinceLockMs(),
    } satisfies PulseEventDetail);
  }

  private updateStability(errorMs: number | null): void {
    if (errorMs === null) return;

    const isStable = Math.abs(errorMs) <= this.thresholdMs;
    this.recentStability.push(isStable);
    if (this.recentStability.length > this.requiredStablePulses) {
      this.recentStability.shift();
    }

    this.stableCount = this.recentStability.filter(Boolean).length;
  }

  // Typed wrapper so callers get compile-time checking on event names.
  addEventListener<K extends keyof PulseSyncEventMap>(
    type: K,
    listener: (ev: PulseSyncEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
  }

  private dispatch<K extends keyof PulseSyncEventMap>(
    type: K,
    detail: PulseSyncEventMap[K] extends CustomEvent<infer D> ? D : never,
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private stabilityTarget(): number {
    return Math.max(1, this.requiredStablePulses - this.allowedUnstablePulses);
  }

  private captureLockOrigin(arrivalMonoMs: number): void {
    if (!this.lastPulse) return;
    this.lockOriginMonoMs = arrivalMonoMs;
    this.lockOriginServerMs = this.lastPulse.serverNowMs;
  }

  private clearLockOrigin(): void {
    this.lockOriginMonoMs = null;
    this.lockOriginServerMs = null;
  }
}

//TODO: Move somewhere else maybe?
function defaultWSURL(): string {
  if (location.protocol === "file:") return "ws://localhost:8080/ws";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isPulseMessage(v: unknown): v is PulseMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>)["type"] === "pulse"
  );
}
