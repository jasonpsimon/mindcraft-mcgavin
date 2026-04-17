/**
 * StateTicker — structured pulse stream for bot observability (BT-1).
 *
 * Problem
 * =======
 * The bot's live state — position, velocity, health, food, inventory,
 * pathfinder goal, mutex holder, current self-prompt goal, nearby
 * entities — is rich, but log output is event-driven. During quiet
 * success (pathing, walking, mining without incident) emission drops
 * to near zero and all that state never leaves the process. Every
 * subsequent observability need — verification, debugging, any future
 * visualizer — pays a one-off `console.log` instrumentation tax that
 * gets ripped out afterward.
 *
 * Solution
 * ========
 * Timer-driven module that emits, on a fixed interval (default 1 Hz),
 * one structured JSON record capturing the bot's live state. Two sinks:
 *   - `[StateTicker] {json}` log line — fits existing prefix convention
 *   - append to `data/state-stream.jsonl` — replayable, plottable,
 *     consumable by future tooling with zero bot-side changes
 *
 * Philosophy alignment
 * ====================
 * - Principle 1 (reduce LLM reliance): 100% code, no LLM round-trip.
 * - Principle 2 (memory is cognition): first observability layer that
 *   agents/humans can reason about without asking the LLM.
 * - Principle 8 (fail loudly, informatively): extends "fail loudly"
 *   with its dual — succeed observably. Tick errors are throttled but
 *   never swallowed; file-write errors are surfaced the same way.
 *
 * Rule alignment
 * ==============
 * - Rule 1 (flexible): interval, console/file sinks, and file path are
 *   all parameterized via settings. No hard-coded constants in hot paths.
 * - Rule 5 (no adverse effects): purely additive. Read-only access to
 *   `bot.*` getters; no mutating APIs called. Tick body wrapped in
 *   try/catch so a transient read failure can never propagate.
 * - Rule 7 (complete the perimeter): the invariant here is
 *   "StateTicker must never mutate bot state." Enforced by calling
 *   only getter-shaped APIs and documented in this header. A grep of
 *   this file for `bot\.(dig|placeBlock|chat|toss)\|pathfinder\.goto`
 *   should return zero matches — that's the ongoing audit hook.
 *
 * Wiring
 * ======
 * Created and started in `Agent.bot.once('spawn', ...)` handler. Stored
 * as `agent.state_ticker`. Stopped in `Agent.cleanKill()`. Survives soft
 * reconnects: the ticker stays attached to the Agent across a mineflayer
 * client recycle; during the unstable window it falls back to emitting
 * `{t, held:true}` records (NaN-position guard + ChunkWait probe) rather
 * than crashing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { botMutex } from '../agent/bot_mutex.js';

// Hostile mob types counted toward `nearby_threats`. Kept as a module-level
// Set so adding a new hostile requires one data entry, not a code change
// (Rule 1). Excludes neutrals (wolf, iron_golem, llama, panda, etc.).
const HOSTILE_MOB_NAMES = new Set([
    'zombie', 'zombie_villager', 'husk', 'drowned',
    'skeleton', 'stray', 'wither_skeleton',
    'creeper', 'spider', 'cave_spider',
    'witch', 'enderman', 'endermite',
    'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
    'phantom', 'slime', 'magma_cube',
    'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
    'guardian', 'elder_guardian',
    'warden', 'shulker',
]);

// Distance cap for entity scanning. 24 blocks is just past normal mob AI
// activation range; farther entities rarely affect immediate behavior.
const NEARBY_ENTITY_RANGE = 24;

// Error-log throttle: at most one warning per this many ms, per source.
// Prevents a persistent failure mode from filling the log.
const ERROR_LOG_THROTTLE_MS = 10_000;

export class StateTicker {
    /**
     * @param {Agent} agent  The mindcraft Agent — ticker reads `agent.bot`,
     *                       `agent.self_prompter`, `agent.chunk_wait`.
     * @param {object} options
     * @param {number} [options.interval_ms=1000]     Emit cadence. <=0 disables.
     * @param {boolean} [options.log_to_console=true] Emit `[StateTicker] ...` log lines.
     * @param {boolean} [options.log_to_file=true]    Append JSONL to disk.
     * @param {string}  [options.file_path='data/state-stream.jsonl']
     */
    constructor(agent, options = {}) {
        this.agent = agent;
        this.intervalMs = options.interval_ms ?? 1000;
        this.logToConsole = options.log_to_console ?? true;
        this.logToFile = options.log_to_file ?? true;
        this.filePath = options.file_path ?? 'data/state-stream.jsonl';

        this._timer = null;
        this._lastTickErrorAt = 0;
        this._lastWriteErrorAt = 0;
    }

    /**
     * Start emitting. Idempotent: if already running, stops and restarts
     * cleanly so reconnect paths don't leak timers. Safe to call multiple
     * times.
     */
    start() {
        this.stop();

        if (this.intervalMs <= 0) {
            console.log('[StateTicker] disabled (interval_ms <= 0)');
            return;
        }

        if (this.logToFile) {
            try {
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            } catch (err) {
                // Directory creation failure is non-fatal — we just disable the
                // file sink and keep console logging. Log once, loudly.
                console.warn(`[StateTicker] could not create data dir for ${this.filePath}: ${err.message} — disabling file sink`);
                this.logToFile = false;
            }
        }

        this._timer = setInterval(() => this._tick(), this.intervalMs);
        // unref() lets the Node process exit cleanly if the ticker is the
        // only remaining handle — critical for clean shutdown paths.
        if (typeof this._timer.unref === 'function') this._timer.unref();

        console.log(`[StateTicker] started: interval=${this.intervalMs}ms console=${this.logToConsole} file=${this.logToFile ? this.filePath : 'off'}`);
    }

    /**
     * Stop emitting. Idempotent.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            console.log('[StateTicker] stopped');
        }
    }

    /** Per-tick wrapper — all exceptions throttled, never propagate. */
    _tick() {
        try {
            const record = this._snapshot();
            this._emit(record);
        } catch (err) {
            const now = Date.now();
            if (now - this._lastTickErrorAt > ERROR_LOG_THROTTLE_MS) {
                this._lastTickErrorAt = now;
                console.warn(`[StateTicker] tick error: ${err.message}`);
            }
        }
    }

    /**
     * Build a single state record. Read-only: touches no bot-mutating APIs.
     * Fields that cannot be cleanly read surface as `null` rather than
     * throwing — the ticker's job is to emit *something* every tick.
     */
    _snapshot() {
        const agent = this.agent;
        const bot = agent?.bot;
        const t = new Date().toISOString();

        // NaN / pre-spawn / ChunkWait-held guard. During these windows
        // bot.entity.position can read NaN (chunk streaming) or be missing
        // entirely (not-yet-spawned). Emit a minimal record instead of
        // burning through getters that would throw.
        const pos = bot?.entity?.position;
        const posFinite = pos
            && Number.isFinite(pos.x)
            && Number.isFinite(pos.y)
            && Number.isFinite(pos.z);
        const chunkHeld = typeof agent?.chunk_wait?.isHeld === 'function'
            ? agent.chunk_wait.isHeld()
            : false;

        if (!posFinite || chunkHeld) {
            return {
                t,
                held: true,
                reason: chunkHeld ? 'chunk_wait' : 'nan_position',
            };
        }

        const vel = bot.entity.velocity;

        // Pathfinder state. mineflayer-pathfinder exposes `.goal` (current
        // target) and `.isMoving()` (actively pathing). Either may be
        // undefined depending on plugin init order — default to null/false.
        const pf = bot.pathfinder;
        const pfActive = !!(pf && (
            (typeof pf.isMoving === 'function' && pf.isMoving()) || pf.goal
        ));
        const pfTarget = pf?.goal ? this._goalTarget(pf.goal) : null;

        // Inventory: top 3 stacks by count. Cheap; avoids dumping the full
        // slot list on every pulse.
        const items = typeof bot.inventory?.items === 'function'
            ? bot.inventory.items()
            : [];
        const topItems = [...items]
            .sort((a, b) => (b?.count ?? 0) - (a?.count ?? 0))
            .slice(0, 3)
            .map(it => `${it.name}:${it.count}`);

        // Nearby entities within NEARBY_ENTITY_RANGE. Count hostiles
        // separately. Returns the closest 3 for the record payload.
        const nearby = [];
        let threats = 0;
        const botPos = bot.entity.position;
        const entitiesMap = bot.entities;
        if (entitiesMap) {
            for (const key in entitiesMap) {
                const e = entitiesMap[key];
                if (!e || e === bot.entity || !e.position) continue;
                // Skip non-mob entities (items, experience orbs, projectiles).
                // mineflayer `type` values include 'player', 'mob', 'hostile',
                // 'passive', 'object'. Players are relevant to keep visible.
                if (e.type !== 'mob' && e.type !== 'hostile' && e.type !== 'player') continue;
                const dx = e.position.x - botPos.x;
                const dy = e.position.y - botPos.y;
                const dz = e.position.z - botPos.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > NEARBY_ENTITY_RANGE) continue;
                const name = e.name || e.username || e.displayName || 'unknown';
                nearby.push({ type: name, dist: Number(d.toFixed(1)) });
                if (HOSTILE_MOB_NAMES.has(name)) threats++;
            }
        }
        nearby.sort((a, b) => a.dist - b.dist);

        // Self-prompter goal. Active → emit the prompt text; inactive → null.
        const sp = agent?.self_prompter;
        const spActive = typeof sp?.isActive === 'function' ? sp.isActive() : false;
        const goal = spActive ? (sp?.prompt ?? null) : null;
        const goalQueueDepth = Array.isArray(sp?.goalQueue) ? sp.goalQueue.length : 0;

        // Mutex (read-only getters — safe).
        const mutex = {
            holder: botMutex?.heldBy ?? null,
            queue: botMutex?.queueDepth ?? 0,
        };

        // BT-5: AutoRecovery dispatcher stats (read-only getter). Compact
        // summary — invocation/match counts, match rate, recovered count,
        // and the last invocation's pattern+outcome. Full per-pattern
        // breakdown is available via `!recovery-stats` debug command.
        let auto_recovery = null;
        try {
            const ar = agent?.auto_recovery;
            if (ar && typeof ar.getStats === 'function') {
                const s = ar.getStats();
                auto_recovery = {
                    invocations: s.invocations,
                    matched: s.matched,
                    match_rate: s.match_rate,
                    recovered: s.recovered,
                    last: s.last,
                };
            }
        } catch (_) {
            // Any stats-read failure degrades to null — ticker never throws.
            auto_recovery = null;
        }

        return {
            t,
            pos: {
                x: Number(pos.x.toFixed(2)),
                y: Number(pos.y.toFixed(2)),
                z: Number(pos.z.toFixed(2)),
            },
            vel: vel ? {
                x: Number(vel.x.toFixed(3)),
                y: Number(vel.y.toFixed(3)),
                z: Number(vel.z.toFixed(3)),
            } : null,
            health: bot.health ?? null,
            food: bot.food ?? null,
            dimension: bot.game?.dimension ?? null,
            goal,
            goal_queue: goalQueueDepth,
            pathfinder: { active: pfActive, target: pfTarget },
            mutex,
            inventory: { count: items.length, top: topItems },
            nearby_entities: nearby.slice(0, 3),
            nearby_threats: threats,
            auto_recovery,
            // v1 placeholders — downstream BTs will wire these:
            //   BT-3 (LLM telemetry) exposes last prompter token count →
            //         context_tokens can cache prompter.lastContextTokens.
            //   BT-7 (skill lifecycle) exposes last completed skill →
            //         last_command can read that.
            last_command: null,
            context_tokens: null,
        };
    }

    /**
     * Extract a coordinate target from a mineflayer-pathfinder goal.
     * Goal shapes vary (GoalNear, GoalBlock, GoalXZ, GoalY, ...): some
     * expose x/y/z directly, some don't. Return null when the goal has
     * no coordinate form we recognize rather than throwing.
     */
    _goalTarget(goal) {
        try {
            if (typeof goal.x === 'number' && typeof goal.z === 'number') {
                return {
                    x: Math.round(goal.x),
                    y: Math.round(goal.y ?? 0),
                    z: Math.round(goal.z),
                };
            }
        } catch (_) {
            // shape-specific property access threw — treat as unrecognized
        }
        return null;
    }

    /**
     * Emit the record to the configured sinks. File writes are async and
     * fire-and-forget; a write error is logged (throttled) but never
     * propagated — we'd rather the bot keep running with silent file
     * loss than crash on a full disk.
     */
    _emit(record) {
        const line = JSON.stringify(record);
        if (this.logToConsole) {
            console.log(`[StateTicker] ${line}`);
        }
        if (this.logToFile) {
            fs.appendFile(this.filePath, line + '\n', (err) => {
                if (!err) return;
                const now = Date.now();
                if (now - this._lastWriteErrorAt > ERROR_LOG_THROTTLE_MS) {
                    this._lastWriteErrorAt = now;
                    console.warn(`[StateTicker] file write error (${this.filePath}): ${err.message}`);
                }
            });
        }
    }
}
