// Auto-save with an offline buffer, Google Sheets style.
// Every cell edit is queued, merged with other edits to the same row, saved
// almost immediately, and kept on the device until the server confirms it.
// If the internet drops (load-shedding), edits wait and are sent when the
// connection returns, in the order they were made.
//
// Edits belong to the person who made them: the stored queue is namespaced by
// the staff user id, so a shared branch computer never replays one person's
// edits under another person's login. Edits that cannot be saved are kept in a
// visible "failed" list (also stored on the device) with Retry and Discard, and
// each failure fires a document-level 'app:save-failed' event.
//
// An edit that is being sent is never changed: whatever is typed for the same
// row meanwhile becomes its own queued edit, sent right after, in order.

export interface PendingEdit {
  table: string;
  rowId: string;
  changes: Record<string, unknown>;
  firstEditedAt: number;
  attempts: number;
  /** Staff user id of the person who made the edit (null when the queue has no user). */
  userId?: string | null;
}

/** One entry per row that could not be saved; kept on the device until it is retried or discarded. */
export interface FailedEdit {
  key: string;
  edit: { table: string; rowId: string; changes: Record<string, unknown>; firstEditedAt: number };
  error: string;
  at: number;
}

/** The detail of the 'app:save-failed' event (and of options.onFailed). */
export interface SaveFailure {
  key: string;
  error: Error;
  edit: { table: string; rowId: string; changes: Record<string, unknown> };
  retry: () => void;
  discard: () => void;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type Sender = (edit: PendingEdit) => Promise<void>;
export type SaveState = 'saved' | 'saving' | 'offline' | 'error';

export interface AutosaveOptions {
  store: KeyValueStore;
  send: Sender;
  storageKey?: string;
  /** Staff user id: the stored queue is namespaced by it. */
  userId?: string | null;
  debounceMs?: number;
  maxAttempts?: number;
  /** Edits that waited longer than this on the device are listed as failed instead of replayed (0 = never). */
  maxAgeMs?: number;
  onState?: (state: SaveState, pending: number, failed: number) => void;
  onFailed?: (detail: SaveFailure) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ClearOptions {
  /** Try to send waiting edits first (gives up after timeoutMs). */
  flush?: boolean;
  /** Delete the unsent edits from the device instead of keeping them. */
  discard?: boolean;
  timeoutMs?: number;
}

/** Edits left on the device after clearForUser(): `pending` are sent automatically at the next login, `failed` wait for Try again or Discard. */
export interface ClearResult {
  pending: number;
  failed: number;
}

type Resolved = Required<Pick<AutosaveOptions,
  'store' | 'send' | 'storageKey' | 'debounceMs' | 'maxAttempts' | 'maxAgeMs' | 'setTimer' | 'clearTimer'>>
  & Pick<AutosaveOptions, 'userId' | 'onState' | 'onFailed'>;

/** Errors the server will never accept (permission, validation). Not retried. */
export class PermanentSaveError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_NOTE = 'Saved on this computer before changes were tied to a login. Check it, then Retry or Discard.';
const STALE_NOTE = 'Waited on this computer for more than a day. Check it is still right, then Retry or Discard.';
const SIGNED_OUT_NOTE = 'This change was not saved because the list was opened under a login that has since signed out. Reload the page and enter it again.';

/** Queues alive in this tab, so clearForUser() can stop them at logout. */
const live = new Set<AutosaveQueue>();

const keyOf = (edit: { table: string; rowId: string }): string => `${edit.table}:${edit.rowId}`;
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e ?? 'Could not save')));

export class AutosaveQueue {
  private pending: PendingEdit[] = [];
  private timer: unknown = null;
  private flushing = false;
  /** The flush that is running now: a second flush() waits for it instead of starting another. */
  private flushRun: Promise<void> | null = null;
  /** The edit whose send is in flight. It is never merged into. */
  private sending: PendingEdit | null = null;
  private online = true;
  private isDisposed = false;
  private readonly o: Resolved;
  private readonly key: string;
  private readonly failedKey: string;
  /** [{ key, edit: { table, rowId, changes, firstEditedAt }, error, at }] — one entry per row. */
  public failed: FailedEdit[] = [];

  constructor(options: AutosaveOptions) {
    this.o = {
      storageKey: 'clinic-autosave-v1',
      debounceMs: 400,
      maxAttempts: 8,
      maxAgeMs: DAY_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
    const uid = this.o.userId ? String(this.o.userId) : '';
    this.key = uid ? `${this.o.storageKey}:${uid}` : this.o.storageKey;
    this.failedKey = `${this.key}:failed`;
    this.pending = this.read<PendingEdit>(this.key);
    this.failed = this.read<FailedEdit>(this.failedKey).filter((f) => f && f.edit && f.key);

    // Edits saved before the queue was per-user have no owner: never send them automatically.
    if (uid) {
      const orphans = this.read<PendingEdit>(this.o.storageKey);
      if (orphans.length) {
        for (const edit of orphans) this.addFailed(edit, LEGACY_NOTE, false);
        this.remove(this.o.storageKey);
      }
    }

    // Edits that waited too long on the device (power cut overnight) are shown, not replayed blindly.
    const now = Date.now();
    const fresh: PendingEdit[] = [];
    for (const edit of this.pending) {
      if (this.o.maxAgeMs && edit.firstEditedAt && now - edit.firstEditedAt > this.o.maxAgeMs) this.addFailed(edit, STALE_NOTE, false);
      else fresh.push(edit);
    }
    if (fresh.length !== this.pending.length) {
      this.pending = fresh;
      this.persist();
    }
    live.add(this);
  }

  get userId(): string | null {
    return this.o.userId || null;
  }

  /** True once the person who opened this queue has logged out (clearForUser) or it was replaced. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get failedCount(): number {
    return this.failed.length;
  }

  /** Copies of the edits that could not be saved: [{ key, table, rowId, changes, error, at }]. */
  get failedEdits(): Array<{ key: string; table: string; rowId: string; changes: Record<string, unknown>; error: string; at: number }> {
    return this.failed.map((f) => ({ key: f.key, table: f.edit.table, rowId: f.edit.rowId, changes: { ...f.edit.changes }, error: f.error, at: f.at }));
  }

  /** Record a cell change. Later edits to the same row merge into one save, unless that save is already being sent. */
  edit(table: string, rowId: string, field: string, value: unknown): void {
    if (this.isDisposed) {
      // The person who opened this queue has logged out: never save under someone else, and never fail silently.
      this.announce({
        key: `${table}:${rowId}`,
        error: new Error(SIGNED_OUT_NOTE),
        edit: { table, rowId, changes: { [field]: value } },
        retry: () => globalThis.location?.reload?.(),
        discard: () => {},
      });
      this.o.onState?.('error', 0, 1);
      return;
    }
    const existing = this.pending.find((p) => p.table === table && p.rowId === rowId && p.attempts === 0 && p !== this.sending);
    if (existing) existing.changes[field] = value;
    else this.pending.push({ table, rowId, changes: { [field]: value }, firstEditedAt: Date.now(), attempts: 0, userId: this.o.userId || null });

    // A new value for a field replaces the failed one: that part of the error is resolved.
    const f = this.failed.find((x) => x.key === `${table}:${rowId}`);
    if (f && field in f.edit.changes) {
      delete f.edit.changes[field];
      if (!Object.keys(f.edit.changes).length) this.failed = this.failed.filter((x) => x !== f);
      this.persistFailed();
    }
    this.persist();
    this.schedule(this.o.debounceMs);
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (this.isDisposed) return;
    if (online) this.schedule(0);
    else this.emit();
  }

  /**
   * Send everything now (e.g. before the page closes). If a flush is already running, this waits for that
   * one (it also sends whatever was queued behind the edit in flight), so logout can wait for a save in progress.
   */
  flush(): Promise<void> {
    if (this.isDisposed) return Promise.resolve();
    if (this.flushRun) return this.flushRun;
    if (!this.online) {
      this.emit();
      return Promise.resolve();
    }
    const run: Promise<void> = this.drain().finally(() => {
      if (this.flushRun === run) this.flushRun = null;
    });
    this.flushRun = run;
    return run;
  }

  private async drain(): Promise<void> {
    this.flushing = true;
    this.emit();
    try {
      while (this.pending.length && this.online && !this.isDisposed) {
        const edit = this.pending[0];
        this.sending = edit;
        try {
          // The sender gets a copy, so nothing typed meanwhile can change what is being sent.
          await this.o.send({ ...edit, changes: { ...edit.changes } });
          this.finish(edit);
        } catch (err) {
          if (err instanceof PermanentSaveError) {
            this.finish(edit);
            this.addFailed(edit, err, true);
            continue;
          }
          edit.attempts += 1;
          this.persist();
          if (edit.attempts >= this.o.maxAttempts) {
            this.finish(edit);
            this.addFailed(edit, err, true);
            continue;
          }
          // Network trouble: back off (1s, 2s, 4s ... max 30s) and try again later.
          this.schedule(Math.min(30_000, 1000 * 2 ** (edit.attempts - 1)));
          break;
        } finally {
          this.sending = null;
        }
      }
    } finally {
      this.flushing = false;
      this.emit();
    }
  }

  /** Take a sent (or given-up) edit out of the queue. */
  private finish(edit: PendingEdit): void {
    const i = this.pending.indexOf(edit);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.persist();
  }

  /** Put a failed edit (or all of them, when no key is given) back in the queue and send it. */
  retryFailed(key?: string): void {
    if (this.isDisposed) return;
    const picked = this.failed.filter((f) => key === undefined || f.key === key);
    if (!picked.length) return;
    this.failed = this.failed.filter((f) => !picked.includes(f));
    for (const f of picked) {
      const existing = this.pending.find((p) => keyOf(p) === f.key && p.attempts === 0 && p !== this.sending);
      // Anything typed since the failure is newer, so it wins over the retried values.
      if (existing) existing.changes = { ...f.edit.changes, ...existing.changes };
      else this.pending.push({ table: f.edit.table, rowId: f.edit.rowId, changes: { ...f.edit.changes }, firstEditedAt: Date.now(), attempts: 0, userId: this.o.userId || null });
    }
    this.persist();
    this.persistFailed();
    this.emit();
    this.schedule(0);
  }

  /** Drop a failed edit (or all of them, when no key is given). */
  discardFailed(key?: string): void {
    this.failed = this.failed.filter((f) => key !== undefined && f.key !== key);
    this.persistFailed();
    this.emit();
  }

  /** Stop timers and forget the queue in memory. Unsent edits stay on the device under this user's key. */
  dispose(): void {
    this.isDisposed = true;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    live.delete(this);
  }

  /** Remove this user's stored edits (pending and failed) from the device. */
  forget(): void {
    this.pending = [];
    this.failed = [];
    this.remove(this.key);
    this.remove(this.failedKey);
  }

  private schedule(ms: number): void {
    if (this.isDisposed) return;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private addFailed(edit: { table: string; rowId: string; changes: Record<string, unknown>; firstEditedAt?: number }, err: unknown, announce: boolean): void {
    const error = typeof err === 'string' ? err : asError(err).message;
    const key = keyOf(edit);
    const at = Date.now();
    const prev = this.failed.find((f) => f.key === key);
    if (prev) {
      prev.edit.changes = { ...prev.edit.changes, ...edit.changes };
      prev.error = error;
      prev.at = at;
    } else this.failed.push({ key, edit: { table: edit.table, rowId: edit.rowId, changes: { ...edit.changes }, firstEditedAt: edit.firstEditedAt || at }, error, at });
    this.persistFailed();
    // After logout the person is gone: the entry is kept for their next login, but no message is shown to whoever is there now.
    if (!announce || this.isDisposed) return;
    const entry = this.failed.find((f) => f.key === key) as FailedEdit;
    this.announce({
      key,
      error: new Error(error),
      edit: { table: entry.edit.table, rowId: entry.edit.rowId, changes: { ...entry.edit.changes } },
      retry: () => this.retryFailed(key),
      discard: () => this.discardFailed(key),
    });
  }

  /** Tells the page about a failed save: options.onFailed(detail) and a bubbling 'app:save-failed' event on document. */
  private announce(detail: SaveFailure): void {
    try {
      this.o.onFailed?.(detail);
    } catch { /* a listener error never breaks saving */ }
    try {
      // Dispatched on document with bubbles, so listeners on document and on window both hear it.
      if (typeof document !== 'undefined' && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('app:save-failed', { bubbles: true, detail }));
    } catch { /* no DOM (tests) */ }
  }

  private read<T>(key: string): T[] {
    try {
      const saved = this.o.store.getItem(key);
      const list: unknown = saved ? JSON.parse(saved) : [];
      return Array.isArray(list) ? (list as T[]) : [];
    } catch {
      return [];
    }
  }

  private remove(key: string): void {
    try {
      if (this.o.store.removeItem) this.o.store.removeItem(key);
      else this.o.store.setItem(key, '[]');
    } catch { /* storage blocked */ }
  }

  private persist(): void {
    try {
      this.o.store.setItem(this.key, JSON.stringify(this.pending));
    } catch {
      /* storage full or blocked: edits stay in memory */
    }
  }

  private persistFailed(): void {
    try {
      if (this.failed.length) this.o.store.setItem(this.failedKey, JSON.stringify(this.failed));
      else this.remove(this.failedKey);
    } catch { /* storage full or blocked */ }
  }

  private emit(): void {
    const state: SaveState = this.failed.length
      ? 'error'
      : !this.online && this.pending.length
        ? 'offline'
        : this.pending.length || this.flushing
          ? 'saving'
          : 'saved';
    this.o.onState?.(state, this.pending.length, this.failed.length);
  }
}

/**
 * Call at logout (and idle logout). Stops every queue in this tab so nothing is
 * sent under the next person's login. Pass { flush: true } BEFORE signing out
 * to try to send waiting edits first (waits for a save already in progress too;
 * gives up after timeoutMs). Unsent edits stay on this computer under their
 * owner's key and are sent the next time that same person opens the Aaj ki
 * List; { discard: true } deletes them instead.
 * Resolves to the edits still waiting, split by what happens to them:
 * `pending` are sent automatically at the next login (within a day), `failed`
 * are listed on the Aaj ki List and wait for Try again or Discard.
 */
export async function clearForUser({ flush = false, discard = false, timeoutMs = 5000 }: ClearOptions = {}): Promise<ClearResult> {
  const queues = [...live];
  if (flush) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.allSettled(queues.map((q) => q.flush())), limit]);
    clearTimeout(timer);
  }
  const left: ClearResult = { pending: 0, failed: 0 };
  for (const q of queues) {
    q.dispose();
    if (discard) q.forget();
    left.pending += q.pendingCount;
    left.failed += q.failedCount;
  }
  return left;
}
