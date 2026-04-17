/**
 * Bot Action Mutex for Mindcraft-McGavin
 *
 * Serializes all bot-state-mutating operations (pathfinding, digging,
 * placing, tossing) so that LLM-issued commands, AutoRecovery flows, and
 * mode-triggered behaviors do not race each other.
 *
 * Properties:
 *   - FIFO: waiters resume in arrival order.
 *   - Reentrant by async context: functions called from inside a locked
 *     region inherit the lock (AsyncLocalStorage) and do not deadlock.
 *   - Observable: every acquire/release is logged with a label so the
 *     tmux buffer makes contention visible.
 *
 * Usage:
 *     import { withBotLock } from './bot_mutex.js';
 *
 *     await withBotLock('safeToss', async () => {
 *         // ...any sequence of bot.dig / bot.pathfinder / bot.placeBlock...
 *     });
 *
 * Inside the callback, nested withBotLock() calls become no-ops — they
 * just run the inner fn directly because the current async context
 * already owns the lock. That makes it safe to wrap every public skill
 * and every recovery entry point without worrying about layering.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

class BotActionMutex {
    constructor() {
        this._holderToken = null;
        this._holderLabel = null;
        this._queue = [];
        this._acquireCount = 0;
    }

    get isHeld() {
        return this._holderToken !== null;
    }

    get heldBy() {
        return this._holderLabel;
    }

    get queueDepth() {
        return this._queue.length;
    }

    /**
     * Acquire the lock, run fn, release. Reentrant: if the calling async
     * context already holds the lock, fn runs immediately without re-acquiring.
     *
     * @param {string} label - short identifier for logs (e.g. 'safeToss', 'cmd:!digDown')
     * @param {() => Promise<T>} fn - async work to run under the lock
     * @returns {Promise<T>}
     */
    async withLock(label, fn) {
        const store = als.getStore();

        // Reentrant: this async chain is already inside a locked region
        if (store && store.token === this._holderToken) {
            // Nested call — just run, don't re-acquire
            return await fn();
        }

        // Wait our turn
        const enterT = Date.now();
        let queued = false;
        while (this._holderToken !== null) {
            queued = true;
            await new Promise((resolve) => {
                this._queue.push(resolve);
            });
        }

        // Acquire
        const token = Symbol(label);
        this._holderToken = token;
        this._holderLabel = label;
        const id = ++this._acquireCount;
        const qd = this._queue.length;
        const waitMs = queued ? Date.now() - enterT : 0;
        console.log(`[BotMutex] #${id} acquired: ${label}${qd > 0 ? ` (queue: ${qd})` : ''}${queued ? ` wait=${waitMs}ms` : ''}`);

        try {
            return await als.run({ token, label }, fn);
        } finally {
            this._holderToken = null;
            this._holderLabel = null;
            console.log(`[BotMutex] #${id} released: ${label}`);
            const next = this._queue.shift();
            if (next) next();
        }
    }
}

export const botMutex = new BotActionMutex();

/**
 * Convenience wrapper: `await withBotLock('label', async () => {...})`.
 */
export const withBotLock = (label, fn) => botMutex.withLock(label, fn);
