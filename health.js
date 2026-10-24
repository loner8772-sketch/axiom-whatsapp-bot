export class Health {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.startedAt = now();
    this.state = 'starting'; // starting | connecting | open | closed | logged_out
    this.since = now();
    this.reconnects = 0;
    this.lastError = '';
    this.lastMessageAt = 0;
  }
  set(state) { if (state !== this.state) { this.state = state; this.since = this.now(); } }
  noteReconnect() { this.reconnects += 1; }
  noteError(e) { this.lastError = String(e?.message || e).slice(0, 200); }
  noteMessage() { this.lastMessageAt = this.now(); }
  stateAgeMs() { return this.now() - this.since; }
  /** Healthy = connected, or still within a grace period while (re)connecting. */
  isHealthy(graceMs = 5 * 60 * 1000) {
    if (this.state === 'open') return true;
    if (this.state === 'logged_out') return false;
    return this.stateAgeMs() < graceMs;
  }
  snapshot() {
    return {
      state: this.state,
      healthy: this.isHealthy(),
      uptimeSec: Math.floor((this.now() - this.startedAt) / 1000),
      stateAgeSec: Math.floor(this.stateAgeMs() / 1000),
      reconnects: this.reconnects,
      lastMessageAt: this.lastMessageAt || null,
    };
  }
}
