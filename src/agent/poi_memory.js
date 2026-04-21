// BT-31 (2026-04-20): POI location memory — auto-capture of notable world features.
//
// Two-tier detection mirroring #7c / #7d:
//   - 60s scanner: bot.findBlocks over POI signature catalog + polls
//     bot.protectedZones[] to stamp village / player_base POIs that #7 /
//     #7c / #7d already registered.
//   - blockUpdate watcher: catches just-placed signatures (newly-lit nether
//     portals, just-placed beacons/lodestones) with sub-second latency.
//
// Dedup by {type, dimension, x_bucket=floor(x/16), z_bucket=floor(z/16)}.
// Persistence: bots/<profile>/poi_memory.json (not MemoryBank — separate
// semantics from user-named !rememberHere places).
//
// Observability: JSONL sink at data/poi-stream.jsonl (one line per
// register/update/dedup event). StateTicker reads getPoiSnapshot()
// (try/catch → null, no bot mutation — Rule 7 clean).
//
// Mount in agent.js spawn handler AFTER startEvents(), BEFORE
// escapeProtectedZone, via hookPoiMemory(agent). Idempotent on soft
// reconnect via bot._hookedPoiMemory reference-identity gate.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { dirname } from 'path';

// --- Configuration ---
const DEFAULTS = {
    enabled: true,
    scannerIntervalMs: 60_000,
    scannerInitialDelayMs: 15_000,
    scannerRadius: 96,
    scannerMaxResults: 256,
    watcherWindowMs: 10 * 60_000,
    dedupBucket: 16,
    maxEntries: 500,
    contextTopN: 8,
    contextMaxDistance: 256,
    saveDebounceMs: 5_000,
    clusterThresholdNetherBricks: 8,
    clusterRadius: 12,
};
let cfg = { ...DEFAULTS };

// --- Signature catalog ---
// block name → { type, subtype, clusterGated?: true }
// cluster-gated entries require ≥ clusterThresholdNetherBricks blocks in a
// clusterRadius-block cluster to promote (filters incidental placements).
const POI_SIGNATURES = {
    nether_portal:        { type: 'portal',    subtype: 'nether' },
    end_portal:           { type: 'portal',    subtype: 'end' },
    end_portal_frame:     { type: 'structure', subtype: 'stronghold' },
    beacon:               { type: 'landmark',  subtype: 'beacon' },
    conduit:              { type: 'landmark',  subtype: 'conduit' },
    lodestone:            { type: 'landmark',  subtype: 'lodestone' },
    nether_bricks:        { type: 'structure', subtype: 'fortress',      clusterGated: true },
    reinforced_deepslate: { type: 'structure', subtype: 'ancient_city' },
    copper_bulb:          { type: 'structure', subtype: 'trial_chamber' },
    copper_grate:         { type: 'structure', subtype: 'trial_chamber' },
};

// Replaceable blocks (for blockUpdate double-sided filter — only count
// placements where oldBlock was air / water / replaceable).
const REPLACEABLE_OLD = new Set([
    'air', 'cave_air', 'void_air', 'water', 'lava',
    'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern',
    'snow', 'vine', 'dead_bush', 'seagrass',
]);

// --- Module state ---
let _stats = {
    registered: 0,
    updated: 0,
    dedup_hits: 0,
    scanner_ticks: 0,
    watcher_events: 0,
    watcher_promoted: 0,
    last_scan_ms: 0,
    load_error: null,
    save_error: null,
};
let _saveTimer = null;
let _watcherWindow = [];  // sliding window for cluster-gated watcher promotions

export function configurePoiMemory(opts = {}) {
    cfg = { ...cfg, ...opts };
}

export function getPoiStats() {
    return { ..._stats };
}

/**
 * Read-only snapshot for StateTicker. Returns null on any failure so the
 * ticker can move on — never mutates bot state (Rule 7).
 */
export function getPoiSnapshot(agent) {
    try {
        const bot = agent && agent.bot;
        if (!bot || !bot._poiCatalog) return null;
        const count = bot._poiCatalog.length;
        const by_type = {};
        for (const p of bot._poiCatalog) {
            by_type[p.type] = (by_type[p.type] || 0) + 1;
        }
        return {
            count,
            by_type,
            scanner_ticks: _stats.scanner_ticks,
            watcher_events: _stats.watcher_events,
        };
    } catch {
        return null;
    }
}

/**
 * Build the "Known POIs" context string for ContextBuilder. Returns a
 * compact multi-line string (or empty string if nothing relevant).
 * Filters by current bot dimension; top-N nearest within contextMaxDistance.
 */
export function getPoiContext(agent) {
    try {
        const bot = agent && agent.bot;
        if (!bot || !bot._poiCatalog || bot._poiCatalog.length === 0) return '';
        const dim = _botDimension(bot);
        const pos = bot.entity && bot.entity.position;
        if (!pos) return '';

        const relevant = [];
        for (const p of bot._poiCatalog) {
            if (p.dimension !== dim) continue;
            const dx = p.pos[0] - pos.x;
            const dz = p.pos[2] - pos.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > cfg.contextMaxDistance) continue;
            relevant.push({ p, d });
        }
        if (relevant.length === 0) return '';
        relevant.sort((a, b) => a.d - b.d);
        const top = relevant.slice(0, cfg.contextTopN);
        const lines = top.map(({ p, d }) => {
            const [x, y, z] = p.pos;
            const label = p.subtype ? `${p.type}/${p.subtype}` : p.type;
            return `  - ${label} @ (${x}, ${y}, ${z})  [~${Math.round(d)}b away]`;
        });
        return `Known POIs nearby (${dim}):\n${lines.join('\n')}`;
    } catch {
        return '';
    }
}

/**
 * Idempotent hook. Safe on soft reconnect via reference-identity gate.
 */
export function hookPoiMemory(agent) {
    const bot = agent && agent.bot;
    if (!bot) return;
    if (!cfg.enabled) return;
    if (bot._hookedPoiMemory === bot) return;
    bot._hookedPoiMemory = bot;

    _initJsonlSink();
    _loadCatalog(agent);

    // --- Watcher: bot.on('blockUpdate') ---
    try {
        bot.on('blockUpdate', (oldBlock, newBlock) => {
            try {
                _onBlockUpdate(agent, oldBlock, newBlock);
            } catch (err) {
                console.warn('[POI] watcher handler failed:', err.message);
            }
        });
    } catch (err) {
        console.warn('[POI] failed to attach blockUpdate watcher:', err.message);
    }

    // --- Scanner: setInterval ---
    setTimeout(() => {
        try { _runScan(agent); } catch (err) { console.warn('[POI] initial scan failed:', err.message); }
    }, cfg.scannerInitialDelayMs);

    setInterval(() => {
        try { _runScan(agent); } catch (err) { console.warn('[POI] periodic scan failed:', err.message); }
    }, cfg.scannerIntervalMs);
}

// --- Internals ---

function _botDimension(bot) {
    try {
        return (bot.game && bot.game.dimension) || 'minecraft:overworld';
    } catch {
        return 'minecraft:overworld';
    }
}

function _poiPath(agent) {
    try {
        return `./bots/${agent.name}/poi_memory.json`;
    } catch {
        return './bots/default/poi_memory.json';
    }
}

function _loadCatalog(agent) {
    const bot = agent.bot;
    bot._poiCatalog = [];
    const fp = _poiPath(agent);
    try {
        if (existsSync(fp)) {
            const raw = readFileSync(fp, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                bot._poiCatalog = data.filter(_isValidRecord);
            } else if (data && Array.isArray(data.entries)) {
                bot._poiCatalog = data.entries.filter(_isValidRecord);
            }
        }
    } catch (err) {
        _stats.load_error = err.message;
        console.warn(`[POI] load failed (${fp}):`, err.message);
    }
}

function _isValidRecord(r) {
    return r && typeof r.type === 'string' && Array.isArray(r.pos) && r.pos.length === 3 && typeof r.dimension === 'string';
}

function _scheduleSave(agent) {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        _saveCatalog(agent);
    }, cfg.saveDebounceMs);
}

function _saveCatalog(agent) {
    const bot = agent.bot;
    if (!bot || !bot._poiCatalog) return;
    const fp = _poiPath(agent);
    try {
        const dir = dirname(fp);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        // Cap to maxEntries (drop oldest first_seen).
        let entries = bot._poiCatalog;
        if (entries.length > cfg.maxEntries) {
            entries = [...entries].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)).slice(0, cfg.maxEntries);
            bot._poiCatalog = entries;
        }
        writeFileSync(fp, JSON.stringify({ version: 1, entries }, null, 2));
    } catch (err) {
        _stats.save_error = err.message;
        console.warn(`[POI] save failed (${fp}):`, err.message);
    }
}

function _initJsonlSink() {
    try {
        if (!existsSync('./data')) mkdirSync('./data', { recursive: true });
    } catch { /* ignore */ }
}

function _jsonl(event) {
    try {
        appendFileSync('./data/poi-stream.jsonl', JSON.stringify(event) + '\n');
    } catch { /* silent per infrastructure convention */ }
}

function _bucketKey(type, dimension, x, z) {
    const bx = Math.floor(x / cfg.dedupBucket);
    const bz = Math.floor(z / cfg.dedupBucket);
    return `${type}|${dimension}|${bx},${bz}`;
}

function _findExisting(bot, type, dimension, x, z) {
    const key = _bucketKey(type, dimension, x, z);
    for (const p of bot._poiCatalog) {
        if (p._key === key) return p;
    }
    return null;
}

function _register(agent, record, source) {
    const bot = agent.bot;
    const [x, y, z] = record.pos;
    const key = _bucketKey(record.type, record.dimension, x, z);
    const existing = _findExisting(bot, record.type, record.dimension, x, z);
    const now = Date.now();

    if (existing) {
        existing.last_seen = now;
        existing.confidence = Math.min(1, (existing.confidence || 0.5) + 0.05);
        _stats.dedup_hits++;
        _jsonl({ ts: now, kind: 'dedup', type: record.type, subtype: record.subtype, pos: record.pos, dimension: record.dimension, source });
        _scheduleSave(agent);
        return 'dedup';
    }

    const entry = {
        _key: key,
        type: record.type,
        subtype: record.subtype || null,
        pos: [Math.round(x), Math.round(y), Math.round(z)],
        dimension: record.dimension,
        first_seen: now,
        last_seen: now,
        source,
        confidence: 0.6,
        signals: record.signals || 1,
    };
    bot._poiCatalog.push(entry);
    _stats.registered++;
    _jsonl({ ts: now, kind: 'register', type: entry.type, subtype: entry.subtype, pos: entry.pos, dimension: entry.dimension, source, signals: entry.signals });
    console.log(`[POI] register ${entry.type}${entry.subtype ? '/' + entry.subtype : ''} @ (${entry.pos[0]}, ${entry.pos[2]}) ${entry.dimension} source=${source}`);
    _scheduleSave(agent);
    return 'register';
}

// --- Scanner ---

function _runScan(agent) {
    const bot = agent.bot;
    if (!bot || !bot.entity) return;
    _stats.scanner_ticks++;
    _stats.last_scan_ms = Date.now();

    _stampFromZones(agent);
    _scanSignatureBlocks(agent);
}

function _stampFromZones(agent) {
    const bot = agent.bot;
    if (!Array.isArray(bot.protectedZones)) return;
    const dim = _botDimension(bot);
    for (const z of bot.protectedZones) {
        if (!z || typeof z.x !== 'number' || typeof z.z !== 'number') continue;
        const y = (typeof z.yMin === 'number' && typeof z.yMax === 'number')
            ? Math.round((z.yMin + z.yMax) / 2)
            : (bot.entity.position.y | 0);
        if (z.type === 'village') {
            _register(agent, {
                type: 'village', subtype: null, pos: [z.x, y, z.z], dimension: dim, signals: 1,
            }, 'village_scanner');
        } else if (z.type === 'player_base') {
            _register(agent, {
                type: 'player_base', subtype: null, pos: [z.x, y, z.z], dimension: dim, signals: 1,
            }, 'zone');
        }
    }
}

function _scanSignatureBlocks(agent) {
    const bot = agent.bot;
    const registry = bot.registry;
    if (!registry) return;

    const nameToId = {};
    for (const name of Object.keys(POI_SIGNATURES)) {
        const b = registry.blocksByName[name];
        if (b) nameToId[b.id] = name;
    }
    const ids = Object.keys(nameToId).map((n) => +n);
    if (ids.length === 0) return;
    const idSet = new Set(ids);

    let positions;
    try {
        positions = bot.findBlocks({
            matching: (block) => idSet.has(block.type),
            maxDistance: cfg.scannerRadius,
            count: cfg.scannerMaxResults,
        });
    } catch (err) {
        console.warn('[POI] findBlocks failed:', err.message);
        return;
    }
    if (!positions || positions.length === 0) return;

    const dim = _botDimension(bot);

    // Group positions by signature (so we can cluster-gate where needed).
    const byName = {};
    for (const pos of positions) {
        const block = bot.blockAt(pos);
        if (!block) continue;
        const sigName = nameToId[block.type];
        if (!sigName) continue;
        (byName[sigName] || (byName[sigName] = [])).push(pos);
    }

    for (const [name, posList] of Object.entries(byName)) {
        const sig = POI_SIGNATURES[name];
        if (sig.clusterGated) {
            // Cluster pass — only promote clusters above threshold.
            const clusters = _clusterPositions(posList, cfg.clusterRadius);
            for (const c of clusters) {
                if (c.count < cfg.clusterThresholdNetherBricks) continue;
                _register(agent, {
                    type: sig.type,
                    subtype: sig.subtype,
                    pos: [c.centerX, c.centerY, c.centerZ],
                    dimension: dim,
                    signals: c.count,
                }, 'scanner');
            }
        } else {
            // Non-cluster — dedup bucket handles repeats; pick first of each bucket.
            const seen = new Set();
            for (const pos of posList) {
                const key = _bucketKey(sig.type, dim, pos.x, pos.z);
                if (seen.has(key)) continue;
                seen.add(key);
                _register(agent, {
                    type: sig.type,
                    subtype: sig.subtype,
                    pos: [pos.x, pos.y, pos.z],
                    dimension: dim,
                    signals: 1,
                }, 'scanner');
            }
        }
    }
}

function _clusterPositions(positions, radius) {
    const clusters = [];
    const r2 = radius * radius;
    for (const p of positions) {
        let matched = null;
        for (const c of clusters) {
            const dx = c.centerX - p.x;
            const dz = c.centerZ - p.z;
            if (dx * dx + dz * dz <= r2) { matched = c; break; }
        }
        if (matched) {
            matched.count++;
            // Running centroid update.
            matched.centerX = Math.round(matched.centerX + (p.x - matched.centerX) / matched.count);
            matched.centerY = Math.round(matched.centerY + (p.y - matched.centerY) / matched.count);
            matched.centerZ = Math.round(matched.centerZ + (p.z - matched.centerZ) / matched.count);
        } else {
            clusters.push({ centerX: p.x, centerY: p.y, centerZ: p.z, count: 1 });
        }
    }
    return clusters;
}

// --- Watcher ---

function _onBlockUpdate(agent, oldBlock, newBlock) {
    if (!newBlock) return;
    const newName = newBlock.name;
    const sig = POI_SIGNATURES[newName];
    if (!sig) return;

    // Double-sided filter: only count placements where oldBlock was
    // air/water/replaceable. Drops 99%+ of non-placement blockUpdate events
    // (water flow, redstone state, furnace state, leaf decay, etc.)
    const oldName = oldBlock && oldBlock.name;
    if (!oldName || !REPLACEABLE_OLD.has(oldName)) return;

    _stats.watcher_events++;

    const bot = agent.bot;
    const dim = _botDimension(bot);
    const now = Date.now();

    if (sig.clusterGated) {
        // Append to sliding window; prune; cluster; promote if threshold met.
        _watcherWindow.push({ name: newName, x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z, ts: now });
        const cutoff = now - cfg.watcherWindowMs;
        _watcherWindow = _watcherWindow.filter((e) => e.ts >= cutoff);

        const same = _watcherWindow.filter((e) => e.name === newName);
        const clusters = _clusterPositions(same, cfg.clusterRadius);
        for (const c of clusters) {
            if (c.count < cfg.clusterThresholdNetherBricks) continue;
            const existing = _findExisting(bot, sig.type, dim, c.centerX, c.centerZ);
            if (existing) continue;
            _register(agent, {
                type: sig.type, subtype: sig.subtype,
                pos: [c.centerX, c.centerY, c.centerZ],
                dimension: dim, signals: c.count,
            }, 'watcher');
            _stats.watcher_promoted++;
        }
    } else {
        const pos = newBlock.position;
        _register(agent, {
            type: sig.type, subtype: sig.subtype,
            pos: [pos.x, pos.y, pos.z],
            dimension: dim, signals: 1,
        }, 'watcher');
        _stats.watcher_promoted++;
    }
}
