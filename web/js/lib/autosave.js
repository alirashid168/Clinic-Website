// GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.
// (2026-10-07 audit fixes were made here directly because src/lib is not in this
// repository: port the per-user queue, clearForUser() and the failed-edit list
// back to autosave.ts before the next build.)
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
/** Errors the server will never accept (permission, validation). Not retried. */
export class PermanentSaveError extends Error {
}
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_NOTE = 'Saved on this computer before changes were tied to a login. Check it, then Retry or Discard.';
const STALE_NOTE = 'Waited on this computer for more than a day. Check it is still right, then Retry or Discard.';
const SIGNED_OUT_NOTE = 'This change was not saved because the list was opened under a login that has since signed out. Reload the page and enter it again.';
/** Queues alive in this tab, so clearForUser() can stop them at logout. */
const live = new Set();
const keyOf = (edit) => `${edit.table}:${edit.rowId}`;
const asError = (e) => (e instanceof Error ? e : new Error(String(e ?? 'Could not save')));
export class AutosaveQueue {
    pending = [];
    timer = null;
    flushing = false;
    online = true;
    disposed = false;
    o;
    /** [{ key, edit: { table, rowId, changes, firstEditedAt }, error, at }] — one entry per row. */
    failed = [];
    constructor(options) {
        this.o = {
            storageKey: 'clinic-autosave-v1',
            debounceMs: 400,
            maxAttempts: 8,
            maxAgeMs: DAY_MS,
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (h) => clearTimeout(h),
            ...options,
        };
        const uid = this.o.userId ? String(this.o.userId) : '';
        this.key = uid ? `${this.o.storageKey}:${uid}` : this.o.storageKey;
        this.failedKey = `${this.key}:failed`;
        this.pending = this.read(this.key);
        this.failed = this.read(this.failedKey).filter((f) => f && f.edit && f.key);
        // Edits saved before the queue was per-user have no owner: never send them automatically.
        if (uid) {
            const orphans = this.read(this.o.storageKey);
            if (orphans.length) {
                for (const edit of orphans)
                    this.addFailed(edit, LEGACY_NOTE, false);
                this.remove(this.o.storageKey);
            }
        }
        // Edits that waited too long on the device (power cut overnight) are shown, not replayed blindly.
        const now = Date.now();
        const fresh = [];
        for (const edit of this.pending) {
            if (this.o.maxAgeMs && edit.firstEditedAt && now - edit.firstEditedAt > this.o.maxAgeMs)
                this.addFailed(edit, STALE_NOTE, false);
            else
                fresh.push(edit);
        }
        if (fresh.length !== this.pending.length) {
            this.pending = fresh;
            this.persist();
        }
        live.add(this);
    }
    get userId() {
        return this.o.userId || null;
    }
    get pendingCount() {
        return this.pending.length;
    }
    get failedCount() {
        return this.failed.length;
    }
    /** Copies of the edits that could not be saved: [{ key, table, rowId, changes, error, at }]. */
    get failedEdits() {
        return this.failed.map((f) => ({ key: f.key, table: f.edit.table, rowId: f.edit.rowId, changes: { ...f.edit.changes }, error: f.error, at: f.at }));
    }
    /** Record a cell change. Later edits to the same row merge into one save. */
    edit(table, rowId, field, value) {
        if (this.disposed) {
            // The person who opened this queue has logged out: never save under someone else, and never fail silently.
            this.announce({
                key: `${table}:${rowId}`,
                error: new Error(SIGNED_OUT_NOTE),
                edit: { table, rowId, changes: { [field]: value } },
                retry: () => globalThis.location?.reload?.(),
                discard: () => { },
            });
            this.o.onState?.('error', 0, 1);
            return;
        }
        const existing = this.pending.find((p) => p.table === table && p.rowId === rowId && p.attempts === 0);
        if (existing)
            existing.changes[field] = value;
        else
            this.pending.push({ table, rowId, changes: { [field]: value }, firstEditedAt: Date.now(), attempts: 0, userId: this.o.userId || null });
        // A new value for a field replaces the failed one: that part of the error is resolved.
        const f = this.failed.find((x) => x.key === `${table}:${rowId}`);
        if (f && field in f.edit.changes) {
            delete f.edit.changes[field];
            if (!Object.keys(f.edit.changes).length)
                this.failed = this.failed.filter((x) => x !== f);
            this.persistFailed();
        }
        this.persist();
        this.schedule(this.o.debounceMs);
    }
    setOnline(online) {
        this.online = online;
        if (this.disposed)
            return;
        if (online)
            this.schedule(0);
        else
            this.emit();
    }
    /** Send everything now (e.g. before the page closes). */
    async flush() {
        if (this.disposed)
            return;
        if (this.flushing || !this.online) {
            this.emit();
            return;
        }
        this.flushing = true;
        this.emit();
        try {
            while (this.pending.length && this.online && !this.disposed) {
                const edit = this.pending[0];
                try {
                    await this.o.send(edit);
                    this.pending.shift();
                    this.persist();
                }
                catch (err) {
                    if (err instanceof PermanentSaveError) {
                        this.pending.shift();
                        this.persist();
                        this.addFailed(edit, err, true);
                        continue;
                    }
                    edit.attempts += 1;
                    this.persist();
                    if (edit.attempts >= this.o.maxAttempts) {
                        this.pending.shift();
                        this.persist();
                        this.addFailed(edit, err, true);
                        continue;
                    }
                    // Network trouble: back off (1s, 2s, 4s ... max 30s) and try again later.
                    this.schedule(Math.min(30_000, 1000 * 2 ** (edit.attempts - 1)));
                    break;
                }
            }
        }
        finally {
            this.flushing = false;
            this.emit();
        }
    }
    /** Put a failed edit (or all of them, when no key is given) back in the queue and send it. */
    retryFailed(key) {
        if (this.disposed)
            return;
        const picked = this.failed.filter((f) => key === undefined || f.key === key);
        if (!picked.length)
            return;
        this.failed = this.failed.filter((f) => !picked.includes(f));
        for (const f of picked) {
            const existing = this.pending.find((p) => keyOf(p) === f.key && p.attempts === 0);
            // Anything typed since the failure is newer, so it wins over the retried values.
            if (existing)
                existing.changes = { ...f.edit.changes, ...existing.changes };
            else
                this.pending.push({ table: f.edit.table, rowId: f.edit.rowId, changes: { ...f.edit.changes }, firstEditedAt: Date.now(), attempts: 0, userId: this.o.userId || null });
        }
        this.persist();
        this.persistFailed();
        this.emit();
        this.schedule(0);
    }
    /** Drop a failed edit (or all of them, when no key is given). */
    discardFailed(key) {
        this.failed = this.failed.filter((f) => key !== undefined && f.key !== key);
        this.persistFailed();
        this.emit();
    }
    /** Stop timers and forget the queue in memory. Unsent edits stay on the device under this user's key. */
    dispose() {
        this.disposed = true;
        if (this.timer !== null)
            this.o.clearTimer(this.timer);
        this.timer = null;
        live.delete(this);
    }
    /** Remove this user's stored edits (pending and failed) from the device. */
    forget() {
        this.pending = [];
        this.failed = [];
        this.remove(this.key);
        this.remove(this.failedKey);
    }
    schedule(ms) {
        if (this.disposed)
            return;
        if (this.timer !== null)
            this.o.clearTimer(this.timer);
        this.timer = this.o.setTimer(() => {
            this.timer = null;
            void this.flush();
        }, ms);
    }
    addFailed(edit, err, announce) {
        const error = typeof err === 'string' ? err : asError(err).message;
        const key = keyOf(edit);
        const at = Date.now();
        const prev = this.failed.find((f) => f.key === key);
        if (prev) {
            prev.edit.changes = { ...prev.edit.changes, ...edit.changes };
            prev.error = error;
            prev.at = at;
        }
        else
            this.failed.push({ key, edit: { table: edit.table, rowId: edit.rowId, changes: { ...edit.changes }, firstEditedAt: edit.firstEditedAt || at }, error, at });
        this.persistFailed();
        if (!announce)
            return;
        const entry = this.failed.find((f) => f.key === key);
        this.announce({
            key,
            error: new Error(error),
            edit: { table: entry.edit.table, rowId: entry.edit.rowId, changes: { ...entry.edit.changes } },
            retry: () => this.retryFailed(key),
            discard: () => this.discardFailed(key),
        });
    }
    /** Tells the page about a failed save: options.onFailed(detail) and a bubbling 'app:save-failed' event on document. */
    announce(detail) {
        try {
            this.o.onFailed?.(detail);
        }
        catch { /* a listener error never breaks saving */ }
        try {
            // Dispatched on document with bubbles, so listeners on document and on window both hear it.
            if (typeof document !== 'undefined' && typeof CustomEvent === 'function')
                document.dispatchEvent(new CustomEvent('app:save-failed', { bubbles: true, detail }));
        }
        catch { /* no DOM (tests) */ }
    }
    read(key) {
        try {
            const saved = this.o.store.getItem(key);
            const list = saved ? JSON.parse(saved) : [];
            return Array.isArray(list) ? list : [];
        }
        catch {
            return [];
        }
    }
    remove(key) {
        try {
            if (this.o.store.removeItem)
                this.o.store.removeItem(key);
            else
                this.o.store.setItem(key, '[]');
        }
        catch { /* storage blocked */ }
    }
    persist() {
        try {
            this.o.store.setItem(this.key, JSON.stringify(this.pending));
        }
        catch {
            /* storage full or blocked: edits stay in memory */
        }
    }
    persistFailed() {
        try {
            if (this.failed.length)
                this.o.store.setItem(this.failedKey, JSON.stringify(this.failed));
            else
                this.remove(this.failedKey);
        }
        catch { /* storage full or blocked */ }
    }
    emit() {
        const state = this.failed.length
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
 * to try to send waiting edits first (gives up after timeoutMs). Unsent edits
 * stay on this computer under their owner's key and are sent the next time that
 * same person opens the Aaj ki List; { discard: true } deletes them instead.
 * Resolves to the number of edits still waiting (pending + failed).
 */
export async function clearForUser({ flush = false, discard = false, timeoutMs = 5000 } = {}) {
    const queues = [...live];
    if (flush) {
        let timer;
        const limit = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
        await Promise.race([Promise.allSettled(queues.map((q) => q.flush())), limit]);
        clearTimeout(timer);
    }
    let left = 0;
    for (const q of queues) {
        q.dispose();
        if (discard)
            q.forget();
        left += q.pendingCount + q.failedCount;
    }
    return left;
}
