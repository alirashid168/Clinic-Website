// Auto-save with an offline buffer, Google Sheets style.
// Every cell edit is queued, merged with other edits to the same row, saved
// almost immediately, and kept on the device until the server confirms it.
// If the internet drops (load-shedding), edits wait and are sent when the
// connection returns, in the order they were made.

export interface PendingEdit {
  table: string;
  rowId: string;
  changes: Record<string, unknown>;
  firstEditedAt: number;
  attempts: number;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Sender = (edit: PendingEdit) => Promise<void>;
export type SaveState = 'saved' | 'saving' | 'offline' | 'error';

export interface AutosaveOptions {
  store: KeyValueStore;
  send: Sender;
  storageKey?: string;
  debounceMs?: number;
  maxAttempts?: number;
  onState?: (state: SaveState, pending: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Errors the server will never accept (permission, validation). Not retried. */
export class PermanentSaveError extends Error {}

export class AutosaveQueue {
  private pending: PendingEdit[] = [];
  private timer: unknown = null;
  private flushing = false;
  private online = true;
  private readonly o: Required<Omit<AutosaveOptions, 'onState'>> & Pick<AutosaveOptions, 'onState'>;
  public failed: Array<{ edit: PendingEdit; error: string }> = [];

  constructor(options: AutosaveOptions) {
    this.o = {
      storageKey: 'clinic-autosave-v1',
      debounceMs: 400,
      maxAttempts: 8,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
    try {
      const saved = this.o.store.getItem(this.o.storageKey);
      if (saved) this.pending = JSON.parse(saved) as PendingEdit[];
    } catch {
      this.pending = [];
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Record a cell change. Later edits to the same row merge into one save. */
  edit(table: string, rowId: string, field: string, value: unknown): void {
    const existing = this.pending.find((p) => p.table === table && p.rowId === rowId && p.attempts === 0);
    if (existing) existing.changes[field] = value;
    else this.pending.push({ table, rowId, changes: { [field]: value }, firstEditedAt: Date.now(), attempts: 0 });
    this.persist();
    this.schedule(this.o.debounceMs);
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (online) this.schedule(0);
    else this.emit();
  }

  /** Send everything now (e.g. before the page closes). */
  async flush(): Promise<void> {
    if (this.flushing || !this.online) {
      this.emit();
      return;
    }
    this.flushing = true;
    this.emit();
    try {
      while (this.pending.length && this.online) {
        const edit = this.pending[0];
        try {
          await this.o.send(edit);
          this.pending.shift();
          this.persist();
        } catch (err) {
          if (err instanceof PermanentSaveError) {
            this.failed.push({ edit, error: err.message });
            this.pending.shift();
            this.persist();
            continue;
          }
          edit.attempts += 1;
          this.persist();
          if (edit.attempts >= this.o.maxAttempts) {
            this.failed.push({ edit, error: err instanceof Error ? err.message : String(err) });
            this.pending.shift();
            this.persist();
            continue;
          }
          // Network trouble: back off (1s, 2s, 4s ... max 30s) and try again later.
          this.schedule(Math.min(30_000, 1000 * 2 ** (edit.attempts - 1)));
          break;
        }
      }
    } finally {
      this.flushing = false;
      this.emit();
    }
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private persist(): void {
    try {
      this.o.store.setItem(this.o.storageKey, JSON.stringify(this.pending));
    } catch {
      /* storage full or blocked: edits stay in memory */
    }
  }

  private emit(): void {
    const state: SaveState = this.failed.length
      ? 'error'
      : !this.online && this.pending.length
        ? 'offline'
        : this.pending.length || this.flushing
          ? 'saving'
          : 'saved';
    this.o.onState?.(state, this.pending.length);
  }
}
