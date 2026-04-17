/**
 * PathTelemetry — pathfinder lifecycle telemetry (BT-6).
 *
 * Problem
 * =======
 * `mineflayer-pathfinder` drives every `!goToCoords`, `!goToPlayer`,
 * `!collectBlock` movement, and every BT-5 PATHFIND_RETRY recovery.
 * Today the only trace a reader gets in the tmux buffer is the skill's
 * `[Skill] skill="goToPosition" outcome=...` record (BT-7) — opaque
 * success/failure with no window into WHY a path succeeded, partialed,
 * or timed out. The pathfinder emits rich events (`goal_updated`,
 * `path_update`, `path_reset`, `goal_reached`, `path_stop`) but nothing
 * consumes them. Principle 8 (fail loudly, informatively) is violated
 * at the single largest source of bot locomotion failures.
 *
 * Solution
 * ========
 * One `[Path]` structured log line per pathfinder event, plus an
 * append to `data/path-stream.jsonl`. Same two-sink pattern as every
 * other BT observability module (StateTicker, DamageStream, RecallLog,
 * SkillLifecycle).
 *
 * Module-level singleton (not a class)
 * ------------------------------------
 * Same shape as RecallLog + SkillLifecycle: pathfinder is a single
 * object per bot, and there is exactly one bot per process. State
 * (session counters, sink config) lives in module closures. Agent
 * calls `hookPathTelemetry(agent)` once on spawn; everything else is
 * event-driven. Rule 9 (simplicity first).
 *
 * Events instrumented (verified against node_modules/mineflayer-pathfinder/index.js)
 * ---------------------------------------------------------------------------------
 *   goal_updated(goal, dynamic) — new goal set; increments paths_started,
 *     records {target, dynamic} into a live "current path" slot.
 *   path_update(results)         — pathfinder computed a path or failed.
 *     results.status ∈ {success, partial, partialSuccess, noPath, timeout}.
 *     Each distinct status increments its own counter. partial and
 *     partialSuccess still progress; noPath and timeout surface WHY a
 *     goal failed — the long-missing signal.
 *   path_reset(reason)            — pathfinder had to replan. Reasons
 *     from the plugin: 'goal_updated', 'stuck', 'dig_error',
 *     'predicting_new_path', 'stopped'. Each increments its own
 *     per-reason counter.
 *   path_stop                     — pathfinder stopped cleanly (goal
 *     cleared / stop() called). Passive book-keeping; no side effect
 *     on counters except `paths_stopped`.
 *   goal_reached(goal)            — pathfinder reached the goal.
 *     Increments paths_completed.
 *
 * Session counters exposed via getPathStats()
 * -------------------------------------------
 *   {
 *     paths_started, paths_completed, paths_stopped,
 *     path_updates: { success, partial, partialSuccess, noPath, timeout, other },
 *     resets: { stuck, goal_updated, dig_error, predicting_new_path, stopped, other },
 *     current: { target?, dynamic, started_at } | null,
 *     last: { event, t, ...fields } | null
 *   }
 *
 * Consumption
 * ===========
 * - `state_ticker._snapshot()` reads `getPathStats()` and attaches a
 *   compact `path:` field on every 1-Hz pulse. Same pattern as BT-5
 *   auto_recovery.
 * - A future `!path-stats` debug command can dump the full stats blob
 *   (same shape as BT-5 `!recovery-stats`). Out of scope for BT-6.
 *
 * Philosophy alignment
 * ====================
 * - Principle 1 (reduce LLM reliance): closes the diagnosis loop for
 *   pathfinder failures — the LLM no longer needs to re-reason "why
 *   couldn't I reach that tree?" from a bare "failed" skill record.
 * - Principle 5 (finish the migration): completes the observability
 *   perimeter. Every core subsystem now has a structured stream.
 * - Principle 8 (fail loudly, informatively): `noPath` and `timeout`
 *   now leave a timestamped, greppable record in two sinks.
 *
 * Rule alignment
 * ==============
 * - Rule 5 (no adverse effects): additive only. Pure listeners on
 *   pathfinder events — no `pathfinder.goto`, no `bot.setControlState`.
 *   Grep the file for any bot-mutating API: zero matches.
 * - Rule 7 (complete the perimeter): hooked at spawn same place
 *   StateTicker starts; safe for soft reconnects because `_hooked`
 *   gates re-installation.
 * - Rule 9 (simplicity first): one stateless emitter, no injection.
 *
 * Non-throwing
 * ============
 * Every listener body is wrapped; any failure is caught and
 * throttle-logged. A broken counter or write can never propagate
 * into the pathfinder event pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILE_PATH = 'data/path-stream.jsonl';
const ERROR_LOG_THROTTLE_MS = 10_000;

// --- Module-private mutable state. Set once; configurable via
//     configurePathTelemetry() at agent init.
let _enabled = true;
let _logToConsole = true;
let _logToFile = true;
let _filePath = DEFAULT_FILE_PATH;
let _dirEnsured = false;
let _lastWriteErrorAt = 0;
let _lastEmitErrorAt = 0;

// --- Hook gating. Pathfinder is a single per-bot object; we install
//     listeners exactly once. Re-calling hookPathTelemetry() on a soft
//     reconnect is idempotent — it detects the prior install and bails.
let _hookedPathfinder = null;

// --- Session counters. Reset only by process restart.
const _stats = _freshStats();

function _freshStats() {
    return {
        paths_started: 0,
        paths_completed: 0,
        paths_stopped: 0,
        path_updates: {
            success: 0,
            partial: 0,
            partialSuccess: 0,
            noPath: 0,
            timeout: 0,
            other: 0,
        },
        resets: {
            stuck: 0,
            goal_updated: 0,
            dig_error: 0,
            predicting_new_path: 0,
            stopped: 0,
            other: 0,
        },
        current: null,
        last: null,
    };
}

/**
 * Optional runtime configuration.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]          master switch (default true)
 * @param {boolean} [opts.log_to_console]   default true
 * @param {boolean} [opts.log_to_file]      default true
 * @param {string}  [opts.file_path]        default 'data/path-stream.jsonl'
 */
export function configurePathTelemetry(opts = {}) {
    if (typeof opts.enabled === 'boolean') _enabled = opts.enabled;
    if (typeof opts.log_to_console === 'boolean') _logToConsole = opts.log_to_console;
    if (typeof opts.log_to_file === 'boolean') _logToFile = opts.log_to_file;
    if (typeof opts.file_path === 'string' && opts.file_path) _filePath = opts.file_path;
    _dirEnsured = false;
}

/**
 * Install listeners on `agent.bot.pathfinder`. Called from agent.js at
 * the same mount point StateTicker starts. Idempotent: if the same
 * pathfinder instance has already been hooked, this is a no-op.
 *
 * @param {Agent} agent  mindcraft Agent (reads agent.bot.pathfinder).
 * @returns {boolean}    true if listeners were attached this call,
 *                       false if already hooked or pathfinder missing.
 */
export function hookPathTelemetry(agent) {
    if (!_enabled) return false;
    try {
        const pf = agent?.bot?.pathfinder;
        if (!pf || typeof pf.on !== 'function') {
            // Pathfinder plugin isn't loaded — not an error, just skip.
            return false;
        }
        if (_hookedPathfinder === pf) {
            return false;
        }
        _hookedPathfinder = pf;

        pf.on('goal_updated', (goal, dynamic) => _onGoalUpdated(goal, dynamic));
        pf.on('path_update', (results) => _onPathUpdate(results));
        pf.on('path_reset', (reason) => _onPathReset(reason));
        pf.on('path_stop', () => _onPathStop());
        pf.on('goal_reached', (goal) => _onGoalReached(goal));
        return true;
    } catch (err) {
        _throttleWarn(`[Path] hook error: ${err?.message ?? err}`);
        return false;
    }
}

/**
 * Snapshot of cumulative session stats. Consumed by StateTicker.
 * Returns a shallow clone so callers can't mutate internals.
 */
export function getPathStats() {
    return {
        paths_started: _stats.paths_started,
        paths_completed: _stats.paths_completed,
        paths_stopped: _stats.paths_stopped,
        path_updates: { ..._stats.path_updates },
        resets: { ..._stats.resets },
        current: _stats.current ? { ..._stats.current } : null,
        last: _stats.last ? { ..._stats.last } : null,
    };
}

// -----------------------------------------------------------------------------
// Event handlers — each wrapped try/catch. On failure, emit throttled warn.
// -----------------------------------------------------------------------------

function _onGoalUpdated(goal, dynamic) {
    try {
        _stats.paths_started++;
        const target = _goalTarget(goal);
        _stats.current = {
            target,
            dynamic: !!dynamic,
            started_at: Date.now(),
        };
        _emit({
            event: 'goal_updated',
            target,
            dynamic: !!dynamic,
            paths_started: _stats.paths_started,
        });
    } catch (err) {
        _throttleWarn(`[Path] goal_updated handler error: ${err?.message ?? err}`);
    }
}

function _onPathUpdate(results) {
    try {
        const status = results?.status ?? 'other';
        const bucket = _stats.path_updates[status] !== undefined ? status : 'other';
        _stats.path_updates[bucket]++;
        const record = {
            event: 'path_update',
            status,
            cost: _num(results?.cost),
            time: _num(results?.time),
            visited_nodes: _num(results?.visitedNodes),
            generated_nodes: _num(results?.generatedNodes),
            path_len: Array.isArray(results?.path) ? results.path.length : null,
        };
        _emit(record);
    } catch (err) {
        _throttleWarn(`[Path] path_update handler error: ${err?.message ?? err}`);
    }
}

function _onPathReset(reason) {
    try {
        const r = typeof reason === 'string' ? reason : 'other';
        const bucket = _stats.resets[r] !== undefined ? r : 'other';
        _stats.resets[bucket]++;
        _emit({ event: 'path_reset', reason: r });
    } catch (err) {
        _throttleWarn(`[Path] path_reset handler error: ${err?.message ?? err}`);
    }
}

function _onPathStop() {
    try {
        _stats.paths_stopped++;
        const elapsed = _stats.current?.started_at
            ? Date.now() - _stats.current.started_at
            : null;
        _emit({ event: 'path_stop', elapsed_ms: elapsed });
        _stats.current = null;
    } catch (err) {
        _throttleWarn(`[Path] path_stop handler error: ${err?.message ?? err}`);
    }
}

function _onGoalReached(goal) {
    try {
        _stats.paths_completed++;
        const target = _goalTarget(goal);
        const elapsed = _stats.current?.started_at
            ? Date.now() - _stats.current.started_at
            : null;
        _emit({
            event: 'goal_reached',
            target,
            elapsed_ms: elapsed,
            paths_completed: _stats.paths_completed,
        });
        _stats.current = null;
    } catch (err) {
        _throttleWarn(`[Path] goal_reached handler error: ${err?.message ?? err}`);
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Extract a coordinate target from a mineflayer-pathfinder goal. Goal
 * shapes vary (GoalNear, GoalBlock, GoalXZ, GoalY, GoalFollow, ...).
 * Return null when the goal exposes no coordinate form we recognize —
 * rather than throwing.
 */
function _goalTarget(goal) {
    try {
        if (!goal) return null;
        if (typeof goal.x === 'number' && typeof goal.z === 'number') {
            return {
                x: Math.round(goal.x),
                y: typeof goal.y === 'number' ? Math.round(goal.y) : null,
                z: Math.round(goal.z),
            };
        }
        if (goal.pos && typeof goal.pos.x === 'number') {
            return {
                x: Math.round(goal.pos.x),
                y: Math.round(goal.pos.y),
                z: Math.round(goal.pos.z),
            };
        }
    } catch (_) { /* fall through */ }
    return null;
}

function _num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function _emit(record) {
    if (!_enabled) return;
    try {
        const normalized = { t: new Date().toISOString(), ...record };
        _stats.last = normalized;
        if (_logToConsole) _emitConsole(normalized);
        if (_logToFile) _emitFile(normalized);
    } catch (err) {
        _throttleWarn(`[Path] emit error: ${err?.message ?? err}`);
    }
}

function _emitConsole(r) {
    const parts = [`event=${r.event}`];
    for (const [k, v] of Object.entries(r)) {
        if (k === 't' || k === 'event') continue;
        parts.push(_fmt(k, v));
    }
    console.log(`[Path] ${parts.join(' ')}`);
}

function _fmt(key, val) {
    if (val === null || val === undefined) return `${key}=?`;
    if (typeof val === 'object') {
        // targets, etc. — inline compact JSON.
        return `${key}=${JSON.stringify(val)}`;
    }
    if (typeof val === 'string') {
        return val.includes(' ') ? `${key}="${val}"` : `${key}=${val}`;
    }
    return `${key}=${val}`;
}

function _emitFile(r) {
    if (!_dirEnsured) {
        try {
            fs.mkdirSync(path.dirname(_filePath), { recursive: true });
            _dirEnsured = true;
        } catch (err) {
            _throttleWarn(`[Path] could not create data dir for ${_filePath}: ${err.message} — disabling file sink`);
            _logToFile = false;
            return;
        }
    }
    fs.appendFile(_filePath, JSON.stringify(r) + '\n', (err) => {
        if (!err) return;
        _throttleWarn(`[Path] file write error (${_filePath}): ${err.message}`);
    });
}

function _throttleWarn(msg) {
    const now = Date.now();
    if (now - _lastEmitErrorAt > ERROR_LOG_THROTTLE_MS) {
        _lastEmitErrorAt = now;
        console.warn(msg);
    }
}

// Test-only helpers (unused in production, kept out of the public export
// names so consumers don't reach for them).
export const __test__ = {
    reset() {
        Object.assign(_stats, _freshStats());
        _hookedPathfinder = null;
        _enabled = true;
        _logToConsole = true;
        _logToFile = true;
        _filePath = DEFAULT_FILE_PATH;
        _dirEnsured = false;
    },
};
