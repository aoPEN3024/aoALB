// 台帳の自動保存キュー。
// - 操作は画面へ即時反映し、ここでは短い待ち時間（既定700ms）でまとめて1回保存する。
// - 同じ台帳の保存は常に1本だけ。保存中に増えた操作は次回へまとめる（自分自身との競合を起こさない）。
// - 入力不正など再試行しても直らない失敗は再試行せず、利用者へ知らせる。
// - 一時的な失敗は間隔を広げて最大5回まで再試行し、それでも失敗したら「保存できていません」を表示して止める。

export const SaveStatus = Object.freeze({
  saved: "saved",       // 保存済み
  pending: "pending",   // 未保存（まもなく保存）
  saving: "saving",     // 保存中
  error: "error",       // 保存できていません
});

const PERMANENT = new Set(["invalid", "not_found", "corrupt", "needs_confirmation"]);

export class SaveQueue {
  /**
   * @param {(ops: object[]) => Promise<object>} send 保存処理（結果に新しい台帳を含む）
   * @param {{delay?: number, maxRetries?: number, onStatus?: Function, onSaved?: Function, onRejected?: Function, setTimer?: Function, clearTimer?: Function}} opts
   */
  constructor(send, opts = {}) {
    this.send = send;
    this.delay = opts.delay ?? 700;
    this.maxRetries = opts.maxRetries ?? 5;
    this.onStatus = opts.onStatus || (() => {});
    this.onSaved = opts.onSaved || (() => {});
    this.onRejected = opts.onRejected || (() => {});
    this.setTimer = opts.setTimer || ((f, ms) => setTimeout(f, ms));
    this.clearTimer = opts.clearTimer || (t => clearTimeout(t));
    this.pending = [];
    this.inflight = null;
    this.timer = null;
    this.failures = 0;
    this.status = SaveStatus.saved;
    this.lastError = null;
  }

  setStatus(s, err = null) { this.status = s; this.lastError = err; this.onStatus(s, err); }

  /** 操作を追加。immediate なら待たずに保存する */
  push(ops, immediate = false) {
    this.pending.push(...ops);
    this.setStatus(SaveStatus.pending);
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, immediate ? 0 : this.delay);
  }

  get hasUnsaved() { return this.pending.length > 0 || !!this.inflight; }

  /** 今ある操作をすべて保存し終えるまで待つ */
  async flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    while (this.inflight || this.pending.length) {
      if (this.inflight) { try { await this.inflight; } catch { /* 下で扱う */ } if (this.status === SaveStatus.error) return false; continue; }
      const batch = this.pending.splice(0);
      this.setStatus(SaveStatus.saving);
      this.inflight = this.send(batch).then(result => {
        this.failures = 0;
        this.inflight = null;
        this.onSaved(result, this.pending.length > 0);
        if (!this.pending.length) this.setStatus(SaveStatus.saved);
      }, err => {
        this.inflight = null;
        const kind = err?.kind || "internal";
        if (PERMANENT.has(kind)) {
          // 直らない失敗：この操作は保存しない（画面は保存済みの状態へ戻す）
          this.onRejected(err, batch);
          this.setStatus(this.pending.length ? SaveStatus.pending : SaveStatus.saved, err);
          return;
        }
        // 一時的な失敗：操作を先頭へ戻して後で再試行（消さない）
        this.pending.unshift(...batch);
        this.failures += 1;
        if (this.failures >= this.maxRetries) { this.setStatus(SaveStatus.error, err); return; }
        const wait = Math.min(30000, 500 * 2 ** this.failures) * (0.8 + Math.random() * 0.4);
        this.setStatus(SaveStatus.pending, err);
        this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, wait);
      });
      await this.inflight?.catch?.(() => {});
      if (this.status === SaveStatus.error) return false; // 再試行の上限：利用者の「再試行」を待つ
      if (this.timer) return true; // 再試行待ち
    }
    return this.status !== SaveStatus.error;
  }

  /** 「再試行」ボタン */
  retry() { this.failures = 0; return this.flush(); }
}
