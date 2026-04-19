// BT-7b (2026-04-19) Placement tracker — observability + cleanup primitive.
//
// Tracks every block the bot places, classifies its purpose, and exposes the
// list to the cleanup_blocks mode (which decides what to break). Mirrors the
// path_telemetry.js module pattern: closure state, configureX, hookX with a
// reference-identity idempotency gate, getXStats, two-sink output (console +
// JSONL).
//
// Public surface:
//   configurePlacementTracker({ enabled, log_to_console, log_to_file, file_path })
//   hookPlacementTracker(agent)        // idempotent
//   getPlacementStats()                 // {total, eligible, oldest_age_s, byPurpose}
//
// Bot-side state populated by this module:
//   bot._placedBlocks  -- array of {x, y, z, type, t, purpose}, FIFO cap 200
//   bot._placeIntent   -- consumed (read + cleared) on each blockPlaced event
//
// Purpose taxonomy:
//   'intentional'         set by _impl_placeBlock try/finally — never cleaned up
//   'torch'               matches a recent bot.placedTorches entry — skipped (already tracked)
//   'pathfinder-scaffold' bot.pathfinder.isMoving() at the moment of the place event
//   'unknown-llm'         everything else (default)

import fs from 'fs';
import path from 'path';

const FIFO_CAP = 200;
const PURPOSES = ['intentional', 'torch', 'pathfinder-scaffold', 'unknown-llm'];

let _config = {
    enabled: true,
    log_to_console: true,
    log_to_file: true,
    file_path: 'data/placement-stream.jsonl',
};

let _agent = null;
let _bot = null;
let _stats = {
    placed_total: 0,
    skipped_total: 0,
    cleaned_total: 0,
    by_purpose: { intentional: 0, torch: 0, 'pathfinder-scaffold': 0, 'unknown-llm': 0 },
};

let _warned = false;
function _warnOnce(msg, err) {
    if (_warned) return;
    _warned = true;
    try { console.warn(`[Placement] ${msg}: ${err && err.message}`); } catch (_) {}
}

function _writeJsonl(record) {
    if (!_config.log_to_file) return;
    try {
        const dir = path.dirname(_config.file_path);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(_config.file_path, JSON.stringify(record) + '\n');
    } catch (err) {
        _warnOnce('jsonl-write-failed', err);
    }
}

function _logConsole(line) {
    if (!_config.log_to_console) return;
    try { console.log(`[Placement] ${line}`); } catch (_) {}
}

function _resolvePurpose(bot, blockName, pos) {
    // 1. Intentional flag set by _impl_placeBlock — single-shot, consume + clear.
    if (bot._placeIntent === 'intentional') {
        bot._placeIntent = null;
        return 'intentional';
    }
    // 2. Torch tracker overlap — head of bot.placedTorches is the newest entry.
    if (Array.isArray(bot.placedTorches) && bot.placedTorches.length > 0) {
        const last = bot.placedTorches[bot.placedTorches.length - 1];
        if (last && Math.floor(last.x) === Math.floor(pos.x) &&
            Math.floor(last.y) === Math.floor(pos.y) &&
            Math.floor(last.z) === Math.floor(pos.z)) {
            return 'torch';
        }
    }
    // 3. Pathfinder active at place-time -> scaffold heuristic.
    try {
        if (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) {
            return 'pathfinder-scaffold';
        }
    } catch (_) { /* ignore */ }
    // 4. Default.
    return 'unknown-llm';
}

function _onBlockPlaced(_oldBlock, newBlock) {
    if (!_config.enabled || !_bot || !newBlock || !newBlock.position) return;
    try {
        const pos = newBlock.position;
        const purpose = _resolvePurpose(_bot, newBlock.name, pos);

        // Torch placements are already tracked by the dedicated torch list — skip.
        if (purpose === 'torch') {
            _stats.skipped_total += 1;
            _stats.by_purpose.torch += 1;
            return;
        }

        const entry = {
            x: Math.floor(pos.x),
            y: Math.floor(pos.y),
            z: Math.floor(pos.z),
            type: newBlock.name,
            t: Date.now(),
            purpose,
        };

        if (!Array.isArray(_bot._placedBlocks)) _bot._placedBlocks = [];
        _bot._placedBlocks.push(entry);
        if (_bot._placedBlocks.length > FIFO_CAP) {
            _bot._placedBlocks.shift();
        }

        _stats.placed_total += 1;
        _stats.by_purpose[purpose] = (_stats.by_purpose[purpose] || 0) + 1;

        const record = {
            t: new Date(entry.t).toISOString(),
            event: 'placed',
            type: entry.type,
            x: entry.x, y: entry.y, z: entry.z,
            purpose,
            tracked_size: _bot._placedBlocks.length,
        };
        _writeJsonl(record);
        _logConsole(`placed type=${entry.type} pos=(${entry.x},${entry.y},${entry.z}) purpose=${purpose} tracked=${_bot._placedBlocks.length}`);
    } catch (err) {
        _warnOnce('blockPlaced-handler-failed', err);
    }
}

function _onDeath() {
    if (!_bot) return;
    const before = Array.isArray(_bot._placedBlocks) ? _bot._placedBlocks.length : 0;
    _bot._placedBlocks = [];
    _bot._placeIntent = null;
    _logConsole(`death — cleared ${before} tracked placements`);
}

function _onRespawn() {
    // Same handling as death — coords may now refer to a different dimension/world.
    _onDeath();
}

// Public: write a cleanup record (called by the cleanup_blocks mode).
export function recordCleanup({ x, y, z, type, purpose, age_s, ok }) {
    _stats.cleaned_total += 1;
    const record = {
        t: new Date().toISOString(),
        event: ok ? 'cleaned' : 'cleanup-skipped',
        type, x, y, z, purpose, age_s,
    };
    _writeJsonl(record);
    _logConsole(`${record.event} type=${type} pos=(${x},${y},${z}) purpose=${purpose} age=${age_s}s`);
}

export function configurePlacementTracker(opts = {}) {
    _config = { ..._config, ...opts };
}

export function hookPlacementTracker(agent) {
    if (!agent || !agent.bot) return;
    const bot = agent.bot;
    // Idempotency gate — same bot reference means we've already hooked.
    if (bot._hookedPlacementTracker === bot) return;
    bot._hookedPlacementTracker = bot;

    _agent = agent;
    _bot = bot;
    if (!Array.isArray(bot._placedBlocks)) bot._placedBlocks = [];
    if (typeof bot._placeIntent === 'undefined') bot._placeIntent = null;

    bot.on('blockPlaced', _onBlockPlaced);
    bot.on('death', _onDeath);
    bot.on('respawn', _onRespawn);
    _logConsole('hooked');
}

export function getPlacementStats() {
    const list = (_bot && Array.isArray(_bot._placedBlocks)) ? _bot._placedBlocks : [];
    const now = Date.now();
    const eligible = list.filter(e => e.purpose !== 'intentional').length;
    const oldest = list.length > 0 ? Math.floor((now - list[0].t) / 1000) : 0;
    return {
        total: list.length,
        eligible,
        oldest_age_s: oldest,
        by_purpose: { ..._stats.by_purpose },
        placed_total: _stats.placed_total,
        cleaned_total: _stats.cleaned_total,
        skipped_total: _stats.skipped_total,
    };
}
