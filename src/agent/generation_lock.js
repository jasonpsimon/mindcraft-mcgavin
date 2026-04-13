/**
 * GenerationLock — Priority-aware serialization for LLM calls.
 *
 * Ensures only one LLM generation runs at a time against a single-threaded
 * inference backend (LM Studio).  Waiters are drained in priority order:
 *
 *   PLAYER  (1)  — player chat responses
 *   SELF    (2)  — self-prompt loop cycles
 *   MEMORY  (3)  — memory summarization (runs when idle)
 *
 * Design goals:
 *   • Zero structural changes to existing call sites — callers wrap their
 *     work in `await lock.run(priority, fn)`.
 *   • No starvation — every queued request eventually runs.
 *   • Transparent logging for debugging concurrency in the field.
 *   • Fully testable — no singletons, no side effects at import time.
 */

export const Priority = Object.freeze({
    PLAYER: 1,
    SELF:   2,
    MEMORY: 3,
});

const PRIORITY_LABELS = {
    [Priority.PLAYER]: 'PLAYER',
    [Priority.SELF]:   'SELF',
    [Priority.MEMORY]: 'MEMORY',
};

export class GenerationLock {
    constructor() {
        /** @type {boolean} */
        this._held = false;

        /** @type {string|null} Label of the current holder for logging */
        this._holder = null;

        /**
         * Waiters sorted by priority on drain.  Each entry:
         *   { priority: number, resolve: Function, label: string }
         * @type {Array}
         */
        this._queue = [];

        /** Monotonic counter for logging */
        this._seq = 0;
    }

    /** True when a generation is in progress. */
    get isHeld() {
        return this._held;
    }

    /** Human-readable label for whoever holds the lock, or null. */
    get holder() {
        return this._holder;
    }

    /** Number of waiters currently queued. */
    get queueDepth() {
        return this._queue.length;
    }

    /**
     * Execute `fn` while holding the lock.  If the lock is already held,
     * the call awaits its turn — higher-priority waiters go first.
     *
     * @param {number} priority  One of Priority.PLAYER | SELF | MEMORY
     * @param {Function} fn      Async function to run under the lock
     * @returns {Promise<*>}     Whatever `fn` returns
     */
    async run(priority, fn) {
        const id = ++this._seq;
        const label = PRIORITY_LABELS[priority] || `PRI-${priority}`;

        if (this._held) {
            console.log(`[GenLock] #${id} (${label}) queued — lock held by ${this._holder} [depth ${this._queue.length + 1}]`);
            await this._enqueue(priority, label);
        }

        // --- We now own the lock ---
        this._held = true;
        this._holder = `${label}:#${id}`;
        console.log(`[GenLock] #${id} (${label}) acquired`);

        try {
            return await fn();
        } finally {
            this._release(id, label);
        }
    }

    /**
     * Returns a promise that resolves when the lock is available.
     * Inserts into the wait queue (drained by priority on release).
     */
    _enqueue(priority, label) {
        return new Promise((resolve) => {
            this._queue.push({ priority, resolve, label });
        });
    }

    /**
     * Release the lock and wake the highest-priority waiter, if any.
     */
    _release(id, label) {
        if (this._queue.length === 0) {
            this._held = false;
            this._holder = null;
            console.log(`[GenLock] #${id} (${label}) released — lock free`);
            return;
        }

        // Sort ascending by priority value (lower = higher priority)
        this._queue.sort((a, b) => a.priority - b.priority);
        const next = this._queue.shift();
        console.log(`[GenLock] #${id} (${label}) released — waking ${next.label} [remaining ${this._queue.length}]`);
        // Transfer ownership before resolving to avoid a gap
        next.resolve();
    }
}
