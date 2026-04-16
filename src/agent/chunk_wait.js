/**
 * ChunkWait — pauses the Agent during chunk-load / NaN-position windows.
 *
 * Problem
 * =======
 * When the server kicks a chunk-load timeout ("Timeout waiting for N chunks
 * to load after Xms") or the bot teleports / relogs, bot.entity.position
 * briefly reads NaN before chunks are streamed in. In that window:
 *   - pathfinder.goto() silently loops forever
 *   - digDown / digUp can crash or target wrong coordinates
 *   - the LLM burns tokens reasoning its way out (violates principle #1)
 *   - skill outcomes get recorded as "success" by keyword match because
 *     the guard messages don't contain any of the failure keywords — this
 *     was the regression JP flagged in #16.1 (false-positive procedural
 *     memory entries).
 *
 * Solution
 * ========
 * A watchdog attached to the Agent that monitors bot.entity.position and
 * transitions into a "held" state when position is NaN or missing. While
 * held:
 *   - agent.executeCommand() refuses non-whitelisted commands (see B3/C)
 *   - agent.recordOutcome() is skipped entirely, so procedural memory
 *     is never written during the unstable window (fixes the #16.1 bug
 *     at the source rather than patching keywords)
 *   - a single polite message is sent — throttled per player — when a
 *     player addresses the bot
 *   - skill-level #16.1 guards (digDown / digUp in skills.js) delegate
 *     their user-facing messaging to ChunkWait in commit D
 *
 * Escalation
 * ==========
 * If the held state persists past `escalationMs` (default 180s) the
 * module:
 *   1. broadcasts the escalation message to chat,
 *   2. calls agent.reconnect() to force a fresh server connection.
 *
 * Runaway protection: more than `maxReconnectsPerWindow` reconnects in
 * `reconnectWindowMs` (default 2 in 5 min) is treated as an unrecoverable
 * failure — process.exit(1) so the human sees it instead of the agent
 * burning tokens on an infinite loop (principle #8 fail loudly).
 *
 * Philosophy alignment
 * ====================
 * - #1 reduce LLM reliance: purely programmatic gating; no LLM in loop.
 * - #2 memory is cognition: skipping recordOutcome while held prevents
 *   false-positive success entries from polluting procedural memory.
 * - #4 preserve work across sessions: reconnect() is soft — Agent-level
 *   state (memory, task, history, ConfidenceEngine) persists across the
 *   bounce; only the mineflayer client is recycled.
 * - #8 fail loudly / informatively: all state transitions logged with a
 *   [ChunkWait] prefix; runaway reconnects exit rather than hide.
 *
 * Rule alignment
 * ==============
 * - Rule 1 flexibility: timeouts, whitelist, messages, and cadences are
 *   all constructor options. Consumers can retune without editing core.
 * - Rule 5 no adverse effects: watchdog interval and escalation timer
 *   are always cleared before being recreated; idempotent start()/stop().
 * - Rule 7 complete the perimeter: every entry point that could reach
 *   bot actions must consult shouldGate() and/or isHeld(). Integration
 *   points wired in commits C (agent.js executeCommand + recordOutcome
 *   + player-message ingress) and D (skills.js digDown/digUp guards).
 *
 * Usage
 * =====
 *   // In Agent.start():
 *   this.chunk_wait = new ChunkWait(this);
 *   this.chunk_wait.start();
 *
 *   // Gating a command (in executeCommand):
 *   if (this.chunk_wait?.shouldGate(raw)) { ... }
 *
 *   // Replying to a player message while held:
 *   this.chunk_wait?.notifyPlayerMessage(username);
 *
 *   // Skill-level delegation (in digDown/digUp):
 *   if (!isFinite(bot.entity.position.x)) {
 *       bot.agent?.chunk_wait?.enter('digDown: NaN position');
 *       return false;
 *   }
 */

import { log } from './connection_handler.js';

export class ChunkWait {
    /**
     * @param {Object} agent The Agent instance. Must expose `.name`, `.bot`,
     *                       and `.reconnect(reason)`.
     * @param {Object} [opts] Tunables (see module docstring).
     */
    constructor(agent, opts = {}) {
        this.agent = agent;

        // Transient state
        this._held = false;
        this._holdStart = 0;
        this._lastReason = null;
        this._escalationTimer = null;
        this._watchdog = null;
        this._playerMessageThrottle = new Map(); // player -> ts of last reply
        this._reconnectHistory = [];             // timestamps of soft reconnects

        // Tunables (Rule 1 flexibility)
        this.WATCHDOG_INTERVAL_MS   = opts.watchdogIntervalMs   ?? 500;
        this.ESCALATION_MS          = opts.escalationMs         ?? 180_000;
        this.PLAYER_MSG_THROTTLE_MS = opts.playerMsgThrottleMs  ?? 30_000;
        this.RECONNECT_WINDOW_MS    = opts.reconnectWindowMs    ?? 300_000;
        this.MAX_RECONNECTS         = opts.maxReconnectsPerWindow ?? 2;

        // Whitelist: commands the player can issue while held. Startswith
        // match so command arguments don't need to be enumerated.
        this.COMMAND_WHITELIST = new Set(opts.commandWhitelist ?? [
            '!stop',
            '!goal',
            '!clearGoal',
            '!endGoal',
            '!setMode',
            '!stats',
            '!help',
        ]);

        // Player-facing messages
        this.MSG_HOLD = opts.messageHold
            ?? "I'm sorry, I can't yet. I need to wait until all the chunks have loaded first. It won't take but a minute or so…";
        this.MSG_ESCALATE = opts.messageEscalate
            ?? "The chunks are still not loading, let me force a chunk reload. Give me one second, I will be right back…";
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Start (or restart) the watchdog interval. Idempotent — safe to call
     * multiple times. Rule 5: always clears the existing interval before
     * creating a new one so reconnects don't leak timers.
     */
    start() {
        if (this._watchdog) {
            clearInterval(this._watchdog);
            this._watchdog = null;
        }
        this._watchdog = setInterval(() => this._tick(), this.WATCHDOG_INTERVAL_MS);
        log(this.agent.name, `[ChunkWait] Watchdog started (${this.WATCHDOG_INTERVAL_MS}ms tick, ${this.ESCALATION_MS/1000}s escalation cap).`);
    }

    /**
     * Stop the watchdog and clear any pending escalation timer. Intended
     * for Agent shutdown. Leaves _reconnectHistory intact so start() can
     * resume counting if reused.
     */
    stop() {
        if (this._watchdog)        { clearInterval(this._watchdog);        this._watchdog = null; }
        if (this._escalationTimer) { clearTimeout(this._escalationTimer);   this._escalationTimer = null; }
        this._held = false;
        this._holdStart = 0;
        this._playerMessageThrottle.clear();
    }

    // ------------------------------------------------------------------
    // Public API — consulted by agent.js and skills.js (Rule 7 perimeter)
    // ------------------------------------------------------------------

    /** @returns {boolean} True if the Agent is currently paused. */
    isHeld() { return this._held; }

    /** @returns {string|null} The reason the current hold was entered. */
    lastReason() { return this._lastReason; }

    /**
     * Check whether a raw command string should be gated. Whitelist uses
     * startsWith so `!goal 10 cobblestone` passes just like bare `!goal`.
     *
     * @param {string} command Raw player message text (e.g. "!goal 10 wood")
     * @returns {boolean} True if the command should be refused while held.
     */
    shouldGate(command) {
        if (!this._held) return false;
        if (command == null) return true;
        const cmd = String(command).trim();
        for (const allowed of this.COMMAND_WHITELIST) {
            if (cmd.startsWith(allowed)) return false;
        }
        return true;
    }

    /**
     * Force-enter the held state. Safe to call repeatedly; the watchdog
     * calls this on NaN position, and skill-level guards (digDown/digUp)
     * call it defensively in commit D.
     *
     * @param {string} reason Short label for logs (e.g. "digDown NaN").
     */
    enter(reason) {
        if (this._held) return;
        this._held = true;
        this._holdStart = Date.now();
        this._lastReason = reason || 'unknown';
        log(this.agent.name, `[ChunkWait] ENTER held state — reason: ${this._lastReason}`);
        this._escalationTimer = setTimeout(() => this._escalate(), this.ESCALATION_MS);
    }

    /**
     * Leave the held state. Called by the watchdog once position is
     * finite again. Idempotent.
     */
    exit(reason = 'chunks-loaded') {
        if (!this._held) return;
        const durationS = ((Date.now() - this._holdStart) / 1000).toFixed(1);
        log(this.agent.name, `[ChunkWait] EXIT held state after ${durationS}s — reason: ${reason}`);
        this._held = false;
        this._holdStart = 0;
        if (this._escalationTimer) {
            clearTimeout(this._escalationTimer);
            this._escalationTimer = null;
        }
        this._playerMessageThrottle.clear();
    }

    /**
     * Called by the agent when a player message arrives while held.
     * Sends the polite hold message, throttled per player so a chatty
     * player doesn't flood the chat with the same explanation.
     *
     * @param {string} playerName
     */
    notifyPlayerMessage(playerName) {
        if (!this._held) return;
        if (!playerName) return;
        const now = Date.now();
        const last = this._playerMessageThrottle.get(playerName) || 0;
        if (now - last < this.PLAYER_MSG_THROTTLE_MS) return;
        this._playerMessageThrottle.set(playerName, now);
        this._sayToPlayer(playerName, this.MSG_HOLD);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    _tick() {
        const bot = this.agent?.bot;
        if (!bot) return; // Agent between reconnects; nothing to check.
        const posOk = this._positionOk(bot);
        if (!this._held && !posOk) {
            this.enter('watchdog: bot.entity.position NaN or missing');
        } else if (this._held && posOk) {
            this.exit('watchdog: position finite');
        }
    }

    _positionOk(bot) {
        const p = bot?.entity?.position;
        if (!p) return false;
        return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    }

    async _escalate() {
        if (!this._held) return;
        log(this.agent.name, `[ChunkWait] ESCALATE — ${this.ESCALATION_MS/1000}s cap reached; forcing soft reconnect.`);

        // Runaway protection — prune old entries, then check the window.
        const now = Date.now();
        this._reconnectHistory = this._reconnectHistory.filter(t => now - t < this.RECONNECT_WINDOW_MS);
        if (this._reconnectHistory.length >= this.MAX_RECONNECTS) {
            log(this.agent.name,
                `[ChunkWait] RUNAWAY: ${this._reconnectHistory.length} reconnects in ${this.RECONNECT_WINDOW_MS/1000}s window — exiting (fail loudly, principle #8).`);
            // Fail loudly so tmux / human sees it instead of an infinite loop.
            process.exit(1);
        }
        this._reconnectHistory.push(now);

        // Tell the chat what's about to happen. Wrapped so a chat failure
        // doesn't block the reconnect itself.
        try {
            if (this.agent.bot && typeof this.agent.bot.chat === 'function') {
                this.agent.bot.chat(this.MSG_ESCALATE);
            }
        } catch (e) {
            console.warn('[ChunkWait] chat escalation message threw:', e.message);
        }

        // Clear local held state *before* bouncing so the watchdog on the
        // new connection starts from a clean slate (it will re-enter if
        // the new session is also chunk-stalled).
        this._held = false;
        this._holdStart = 0;
        if (this._escalationTimer) {
            clearTimeout(this._escalationTimer);
            this._escalationTimer = null;
        }
        this._playerMessageThrottle.clear();

        try {
            await this.agent.reconnect(`ChunkWait escalation after ${this.ESCALATION_MS/1000}s`);
        } catch (e) {
            console.error('[ChunkWait] agent.reconnect() failed:', e);
        }
    }

    _sayToPlayer(playerName, message) {
        const bot = this.agent?.bot;
        if (!bot || typeof bot.chat !== 'function') return;
        try {
            // /tell so only the player who spoke sees the reply. Falls back
            // to open chat silently if /tell is not available on the server.
            bot.chat(`/tell ${playerName} ${message}`);
        } catch (e) {
            console.warn('[ChunkWait] _sayToPlayer threw:', e.message);
        }
    }
}
