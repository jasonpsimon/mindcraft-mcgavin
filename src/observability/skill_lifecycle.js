/**
 * SkillLifecycle — uniform [Skill] lifecycle telemetry (BT-7).
 *
 * Problem
 * =======
 * `src/agent/library/skills.js` exports ~82 skills that the agent
 * invokes through the command dispatcher. Only 19 of them emit any
 * kind of `[Skills]` line, and each rolls its own ad-hoc format —
 * some log start, some log end, most report only through `bot.chat`
 * (which is a player-facing channel, not a developer-facing one).
 *
 * Reading the tmux buffer, it is frequently impossible to tell:
 *   - whether a skill invocation completed or hung
 *   - how long a call took
 *   - why a skill returned false ("couldn't do it") versus threw
 *   - the arguments the skill was called with
 *
 * BT-7 gives every wrapped skill one uniform structured lifecycle line
 * per invocation. Two sinks — console + `data/skill-stream.jsonl` —
 * same convention as BT-1 StateTicker, BT-2 DamageStream, BT-5
 * AutoRecovery stats.
 *
 * Log line format
 * ===============
 *   [Skill] name=<name> args=<json> ms=<int> outcome=<success|error|abort>
 *           [err_class=<ErrorName>] [notes=<string>]
 *
 * `args` is a capped JSON string (ARG_STRING_CAP chars) of the
 * skill-level arguments. The first positional is always the `bot`
 * instance — the default argSelector drops it.
 *
 * Outcome taxonomy
 * ================
 *   success — fn returned truthy or undefined, no exception
 *   error   — fn threw; original exception is re-thrown unchanged
 *             and `err_class` captures the thrown constructor name
 *   abort   — fn returned literal `false`, the mineflayer convention
 *             for "attempted the action but couldn't complete it"
 *
 * Roll-out
 * ========
 * BT-7 wraps the 11 hottest skills only (collectBlock, craftRecipe,
 * smeltItem, pickupNearbyItems, placeBlock, safeToss, safeTossBatch,
 * goToNearestBlock, digDown, digUp, equip). The remaining ~72 skills
 * migrate under BT-7b once BT-7 has live-run data. Rule 9 (simplicity
 * first) — don't wrap what we can't live-verify in one ship cycle.
 *
 * Philosophy alignment
 * ====================
 * - Principle 1 (reduce LLM reliance): mechanical wrapper, zero LLM.
 * - Principle 5 (finish migrations): rename-impl pattern is the
 *   single end-state for every wrapped skill; no dual codepath.
 * - Principle 8 (fail loudly, informatively): `abort` is a
 *   first-class outcome, not a swallow; `err_class` is named.
 *
 * Rule alignment
 * ==============
 * - Rule 5 (no adverse effects): the wrapper calls the impl with the
 *   original `this` and `args`, awaits the result, and returns it
 *   unchanged. Exceptions re-throw in the original order with the
 *   original instance. The emit path is wrapped in a try/catch so a
 *   sink failure can never propagate to the caller.
 * - Rule 7 (invariant): SkillLifecycle must not mutate bot state.
 *   `grep -E "bot\\.(dig|placeBlock|chat|toss|setControlState|attack|
 *   equip|unequip|activateItem)|pathfinder\\.goto"` on this file
 *   returns zero matches.
 */

import fs from 'node:fs';
import path from 'node:path';

const ERROR_LOG_THROTTLE_MS = 10_000;
const ARG_STRING_CAP = 80;

// Module-level singleton — wrapSkill is invoked at module-evaluation
// time (once per export) but the sink state is shared across all
// wrapped skills. Rule 9: one emitter, not one-per-wrap.
let _config = {
    log_to_console: true,
    log_to_file: true,
    file_path: 'data/skill-stream.jsonl',
};
let _initialized = false;
let _lastWriteErrorAt = 0;
let _lastEmitErrorAt = 0;

function _ensureInit() {
    if (_initialized) return;
    _initialized = true;
    if (_config.log_to_file) {
        try {
            fs.mkdirSync(path.dirname(_config.file_path), { recursive: true });
        } catch (err) {
            console.warn(`[Skill] could not create data dir for ${_config.file_path}: ${err.message} — disabling file sink`);
            _config.log_to_file = false;
        }
    }
}

/**
 * Override the emit config. Intended for tests and for flipping
 * sinks off in CI. Subsequent emits will re-run directory setup.
 */
export function configureSkillLifecycle(options = {}) {
    _config = { ..._config, ...options };
    _initialized = false;
}

function _stringifyArgs(args) {
    try {
        const s = JSON.stringify(args, (_k, v) => {
            if (typeof v === 'function') return '[fn]';
            if (v && typeof v === 'object') {
                const cn = v.constructor && v.constructor.name;
                if (cn && cn !== 'Object' && cn !== 'Array') return `[${cn}]`;
            }
            return v;
        });
        if (s == null) return '[]';
        if (s.length > ARG_STRING_CAP) return s.slice(0, ARG_STRING_CAP - 3) + '...';
        return s;
    } catch (_) {
        return '[unserializable]';
    }
}

function _emit(record) {
    _ensureInit();
    try {
        const line = JSON.stringify(record);
        if (_config.log_to_console) {
            let msg = `[Skill] name=${record.name} args=${record.args_str} ms=${record.ms} outcome=${record.outcome}`;
            if (record.err_class) msg += ` err_class=${record.err_class}`;
            if (record.notes) msg += ` notes=${record.notes}`;
            console.log(msg);
        }
        if (_config.log_to_file) {
            fs.appendFile(_config.file_path, line + '\n', (err) => {
                if (!err) return;
                const now = Date.now();
                if (now - _lastWriteErrorAt > ERROR_LOG_THROTTLE_MS) {
                    _lastWriteErrorAt = now;
                    console.warn(`[Skill] file write error (${_config.file_path}): ${err.message}`);
                }
            });
        }
    } catch (err) {
        const now = Date.now();
        if (now - _lastEmitErrorAt > ERROR_LOG_THROTTLE_MS) {
            _lastEmitErrorAt = now;
            console.warn(`[Skill] emit error: ${err.message}`);
        }
    }
}

/**
 * Wrap a skill function with lifecycle telemetry.
 *
 * The returned function has the same shape as `fn`: it accepts the
 * same positional args, awaits the impl, and returns whatever the
 * impl returned. Exceptions propagate unchanged.
 *
 * @param {string} name  Canonical skill name; must match the export identifier.
 * @param {Function} fn  The `async function _impl_X(...)` implementation.
 * @param {object} [options]
 * @param {Function} [options.argSelector]
 *   (args) => serializableArgs. Default drops the first positional
 *   (bot) and keeps the rest. Pass a custom selector when the bot is
 *   not the first positional, or to strip a large literal.
 * @param {Function} [options.notesSelector]
 *   (args, result) => string | null. Optional hook for attaching a
 *   short free-form note to the log line (e.g. "placed via cheat").
 * @returns {Function} async wrapper with identical signature to fn.
 */
export function wrapSkill(name, fn, options = {}) {
    const argSelector = options.argSelector || ((args) => args.slice(1));
    const notesSelector = options.notesSelector || null;
    return async function skillLifecycleWrapper(...args) {
        const t0 = Date.now();
        let outcome = 'success';
        let err_class = null;
        let result;
        try {
            result = await fn.apply(this, args);
            if (result === false) outcome = 'abort';
        } catch (err) {
            outcome = 'error';
            err_class = (err && err.constructor && err.constructor.name) || 'Error';
            const ms = Date.now() - t0;
            let args_str;
            try { args_str = _stringifyArgs(argSelector(args)); } catch (_) { args_str = '[argselector-failed]'; }
            _emit({
                t: new Date().toISOString(),
                name,
                args_str,
                ms,
                outcome,
                err_class,
                notes: null,
            });
            throw err;
        }
        const ms = Date.now() - t0;
        let args_str;
        try { args_str = _stringifyArgs(argSelector(args)); } catch (_) { args_str = '[argselector-failed]'; }
        let notes = null;
        if (notesSelector) {
            try { notes = notesSelector(args, result); } catch (_) { notes = null; }
        }
        _emit({
            t: new Date().toISOString(),
            name,
            args_str,
            ms,
            outcome,
            err_class: null,
            notes,
        });
        return result;
    };
}
