// BT-7f (2026-04-19) Door/fence-gate tracker + close primitive.
//
// Wraps bot.activateBlock at hook time so every door/gate the bot opens is
// recorded into bot._openedDoors. The close_doors mode reads that list and
// re-activates each entry once the bot has moved on. Mirrors the
// placement_tracker.js shape: closure state, configureX, hookX with
// reference-identity idempotency gate, getXStats, recordClose helper.
//
// Scope:
//   IN:  *_door (wooden), *_fence_gate
//   OUT: iron_door (needs redstone), *_trapdoor (rare, different UX),
//        player-opened doors (not routed through bot.activateBlock)
//
// Public surface:
//   configureDoorTracker({ enabled, log_to_console, log_to_file, file_path })
//   hookDoorTracker(agent)          // idempotent
//   getDoorStats()
//   recordDoorClose({ x, y, z, type, age_s, ok, reason })
//
// Bot-side state populated by this module:
//   bot._openedDoors  -- array of {x, y, z, type, t}, FIFO cap 50

import fs from 'fs';
import path from 'path';

const FIFO_CAP = 50;

function _isDoor(name) {
    if (!name) return false;
    if (name === 'iron_door') return false;
    return name.endsWith('_door');
}
function _isFenceGate(name) {
    return !!name && name.endsWith('_fence_gate');
}
function _isTrackable(name) {
    return _isDoor(name) || _isFenceGate(name);
}

function _isOpen(block) {
    if (!block) return false;
    try {
        const props = (typeof block.getProperties === 'function')
            ? block.getProperties()
            : (block._properties || {});
        // Minecraft state value is the string "true" / "false".
        return props.open === true || props.open === 'true';
    } catch (_) {
        return false;
    }
}

let _config = {
    enabled: true,
    log_to_console: true,
    log_to_file: true,
    file_path: 'data/door-stream.jsonl',
};

let _agent = null;
let _bot = null;
let _stats = {
    opened_total: 0,
    closed_total: 0,
    skipped_total: 0,
};

let _warned = false;
function _warnOnce(msg, err) {
    if (_warned) return;
    _warned = true;
    try { console.warn(`[Doors] ${msg}: ${err && err.message}`); } catch (_) {}
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
    try { console.log(`[Doors] ${line}`); } catch (_) {}
}

function _onDeath() {
    if (!_bot) return;
    const before = Array.isArray(_bot._openedDoors) ? _bot._openedDoors.length : 0;
    _bot._openedDoors = [];
    _logConsole(`death — cleared ${before} tracked doors`);
}

function _recordOpenedIfNew(block) {
    if (!_bot || !block || !block.position) return;
    const name = block.name;
    if (!_isTrackable(name)) return;
    // Only record if the block is now OPEN (caller already confirmed the flip).
    const pos = block.position;
    const entry = {
        x: Math.floor(pos.x),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z),
        type: name,
        t: Date.now(),
    };
    if (!Array.isArray(_bot._openedDoors)) _bot._openedDoors = [];
    // Dedup: if this exact coord is already tracked, refresh timestamp only.
    const existing = _bot._openedDoors.findIndex(e =>
        e.x === entry.x && e.y === entry.y && e.z === entry.z);
    if (existing !== -1) {
        _bot._openedDoors[existing].t = entry.t;
        return;
    }
    _bot._openedDoors.push(entry);
    if (_bot._openedDoors.length > FIFO_CAP) _bot._openedDoors.shift();
    _stats.opened_total += 1;

    _writeJsonl({
        t: new Date(entry.t).toISOString(),
        event: 'opened',
        type: entry.type,
        x: entry.x, y: entry.y, z: entry.z,
        tracked_size: _bot._openedDoors.length,
    });
    _logConsole(`opened type=${entry.type} pos=(${entry.x},${entry.y},${entry.z}) tracked=${_bot._openedDoors.length}`);
}

function _wrapActivateBlock(bot) {
    if (bot._origActivateBlock) return; // already wrapped
    const orig = bot.activateBlock;
    if (typeof orig !== 'function') return;
    bot._origActivateBlock = orig;
    bot.activateBlock = async function (block, ...rest) {
        // Sample state BEFORE the call so we can detect a real flip.
        let wasOpen = false;
        let trackable = false;
        try {
            if (block && _isTrackable(block.name)) {
                trackable = true;
                wasOpen = _isOpen(block);
            }
        } catch (_) { /* ignore */ }
        const ret = await orig.call(bot, block, ...rest);
        if (trackable) {
            try {
                // Re-read the block fresh — the `block` arg may be stale.
                const pos = block.position;
                const fresh = pos ? bot.blockAt(pos) : block;
                const nowOpen = _isOpen(fresh);
                if (!wasOpen && nowOpen) {
                    _recordOpenedIfNew(fresh || block);
                }
            } catch (err) {
                _warnOnce('activate-hook-failed', err);
            }
        }
        return ret;
    };
}

// Public: called by close_doors mode.
export function recordDoorClose({ x, y, z, type, age_s, ok, reason }) {
    if (ok) _stats.closed_total += 1;
    else _stats.skipped_total += 1;
    _writeJsonl({
        t: new Date().toISOString(),
        event: ok ? 'closed' : 'close-skipped',
        type, x, y, z,
        age_s,
        reason: reason || null,
    });
    _logConsole(`${ok ? 'closed' : 'close-skipped'} type=${type} pos=(${x},${y},${z}) age=${age_s}s${reason ? ' reason=' + reason : ''}`);
}

export function configureDoorTracker(opts = {}) {
    _config = { ..._config, ...opts };
}

export function hookDoorTracker(agent) {
    if (!agent || !agent.bot) return;
    const bot = agent.bot;
    if (bot._hookedDoorTracker === bot) return;
    bot._hookedDoorTracker = bot;

    _agent = agent;
    _bot = bot;
    if (!Array.isArray(bot._openedDoors)) bot._openedDoors = [];

    _wrapActivateBlock(bot);
    bot.on('death', _onDeath);
    bot.on('respawn', _onDeath);
    _logConsole('hooked');
}

export function getDoorStats() {
    const list = (_bot && Array.isArray(_bot._openedDoors)) ? _bot._openedDoors : [];
    const now = Date.now();
    const oldest = list.length > 0 ? Math.floor((now - list[0].t) / 1000) : 0;
    return {
        total: list.length,
        oldest_age_s: oldest,
        opened_total: _stats.opened_total,
        closed_total: _stats.closed_total,
        skipped_total: _stats.skipped_total,
    };
}

// Exported helper for the close_doors mode so the mode doesn't need to
// re-implement the door-type/open-state predicates.
export const doorHelpers = {
    isTrackable: _isTrackable,
    isOpen: _isOpen,
};
