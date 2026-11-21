// 未保存の台帳操作があるときの「画面移動・工事を閉じる・アプリ終了」の門番。
// - 保存が成功するまで先へ進まない（保存に失敗したら進まない）
// - 失敗時は利用者に「再試行」か「編集画面へ戻る」を選んでもらう。未保存の操作は消さない
// - 同時に何度呼ばれても保存処理は1本だけ（終了操作の連打で二重保存しない）
// 保存先（ローカル／将来のクラウド）には依存しない。

export class LeaveGuard {
  /**
   * @param {{ getQueue: () => (import("./save-queue.js").SaveQueue | null), askOnFailure: (err: object, count: number) => Promise<"retry" | "stay"> }} opts
   */
  constructor({ getQueue, askOnFailure }) {
    this.getQueue = getQueue;
    this.askOnFailure = askOnFailure;
    this.running = null;
  }

  /** 未保存がなくなれば true。利用者が「戻る」を選んだら false */
  ensureSaved() {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    for (;;) {
      const q = this.getQueue();
      if (!q || !q.hasUnsaved) return true;
      await q.flush();
      if (!q.hasUnsaved) return true;
      const choice = await this.askOnFailure(q.lastError, q.pending.length);
      if (choice !== "retry") return false;
      q.failures = 0;
    }
  }
}

/**
 * アプリ終了の処理。保存が済んでから工事を閉じ、その後だけウィンドウを破棄する。
 * 連打しても同じ処理を待つだけで、二重に保存・終了しない。
 */
export function createExitHandler({ guard, closeProject, destroy, onError }) {
  let running = null;
  return () => {
    if (running) return running;
    running = (async () => {
      try {
        if (!(await guard.ensureSaved())) return false;
        await closeProject();
        await destroy();
        return true;
      } catch (e) {
        onError?.(e);
        return false;
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

const OP_LABEL = {
  Place: "写真の配置", Swap: "写真の入替え", Move: "写真の移動", Clear: "未配置へ戻す", SetBlank: "空白枠", InsertBlank: "空白の挿入",
  RemoveSlot: "枠を詰める", PlaceMany: "写真の連続配置", AddPage: "ページの追加", DeletePage: "ページの削除", RestorePage: "ページを戻す",
  MovePage: "ページの並べ替え", SetSlots: "元に戻す・やり直す", SetCaption: "台帳の文言", SetTitle: "台帳名", SetCover: "表紙",
  SetShowCover: "表紙の有無", SetViewMode: "表示方法",
};

/** 利用者向けの操作名（保存できなかった操作の説明に使う） */
export function describeOps(ops) {
  const counts = new Map();
  for (const o of ops) { const k = OP_LABEL[o.op] || "台帳の変更"; counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts].map(([k, n]) => (n > 1 ? `${k}（${n}件）` : k));
}
