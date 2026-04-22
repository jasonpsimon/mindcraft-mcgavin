// src/oracle/structure_oracle.js
//
// BT-7f: Seed-aware Structure Oracle.
//
// Uses cubiomes (compiled to WASM) to resolve structure positions deterministically
// from the world seed. Consumes level.dat via seed_discovery.js — no user input
// required on setups where the bot process shares a filesystem with the server.
//
// Observability module contract (see CLAUDE.md "module pattern"):
//   - Closure state: _oracleActive, _mcVersionId, _seedLo/Hi, _initialSweepCount,
//     _lastResolutions (ring buffer), _warned, _hookedAgent
//   - configureOracle(opts)   — called once with settings at boot
//   - hookOracle(agent)        — idempotent via agent._hookedOracle reference gate
//   - getOracleStats()         — read-only counters
//   - getOracleSnapshot()      — StateTicker-safe getter (no seed value)
//   - getStructuresNear(x, z, radiusRegions, types?) — on-demand resolver
//   - JSONL sink: data/oracle-stream.jsonl (one line per resolution)
//
// Graceful-disable perimeter (Rule 7 "Complete the perimeter"):
//   Every public export short-circuits when _oracleActive === false. Discovery
//   failure (no level.dat, seed missing, unknown mc_version, WASM load fail)
//   must leave the module in the inactive state; consumers must accept
//   empty/null results without crashing.
//
// Security: the seed value never flows to JSONL, stdout, StateTicker, or any
// log line. Only diagnostics (source, mc_version string, level_name) are logged.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverWorldContext } from './seed_discovery.js';
import { registerFromOracle } from '../agent/poi_memory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Module state (closure) ------------------------------------------------

let _oracleActive = false;
let _warnedDisable = false;

let _mcVersionId = null;      // cubiomes MC_* enum value
let _mcVersionStr = null;     // original "1.21" / "1.21.4" string
let _worldPath = null;
let _seedSource = null;

let _seedLo = 0;
let _seedHi = 0;

let _wasmModule = null;       // emscripten-compiled instance
let _wasm_findNearestStructure = null;
let _wasm_oracleResultX = null;
let _wasm_oracleResultZ = null;

let _initialSweepCount = 0;
let _resolutionsSinceBoot = 0;
let _lastResolutions = [];    // bounded ring buffer for diagnostics

let _jsonlPath = null;

const _opts = {
    worldPath: null,          // overrides auto-discovery
    initialSweepRadius: 32,   // regions (~16 chunks each for villages)
    initialSweepTypes: ['village', 'outpost', 'ancient_city', 'mansion', 'monument', 'trail_ruins'],
    jsonlSink: true,
    jsonlFilename: 'data/oracle-stream.jsonl',
    wasmDir: null,            // resolved from __dirname if null
};

// ---- Structure type catalog (name → cubiomes enum ID) -----------------------
// Values verified against cubiomes e61f905 (April 2026) via compiled probe.

const STRUCTURE_IDS = {
    feature: 0,
    desert_pyramid: 1,
    jungle_temple: 2,
    jungle_pyramid: 2,
    swamp_hut: 3,
    igloo: 4,
    village: 5,
    ocean_ruin: 6,
    shipwreck: 7,
    monument: 8,
    mansion: 9,
    outpost: 10,
    ruined_portal: 11,
    ruined_portal_n: 12,
    ancient_city: 13,
    treasure: 14,
    mineshaft: 15,
    desert_well: 16,
    geode: 17,
    fortress: 18,
    bastion: 19,
    end_city: 20,
    end_gateway: 21,
    end_island: 22,
    trail_ruins: 23,
    trial_chambers: 24,
};

// ---- MC version mapping (level.dat "1.21" → cubiomes MC_* enum ID) ----------

const MC_VERSION_IDS = {
    '1.19': 24,
    '1.19.2': 23,
    '1.19.4': 24,
    '1.20': 25,
    '1.20.6': 25,
    '1.21': 28,
    '1.21.1': 26,
    '1.21.3': 27,
    '1.21.4': 28,
    '1.21.5': 28,
};

function _resolveMcVersionId(versionStr) {
    if (!versionStr) return null;
    // Exact match first
    if (MC_VERSION_IDS[versionStr] !== undefined) return MC_VERSION_IDS[versionStr];
    // Strip patch digits and retry (e.g., "1.21.2" → "1.21")
    const m = /^(\d+\.\d+)/.exec(versionStr);
    if (m && MC_VERSION_IDS[m[1]] !== undefined) return MC_VERSION_IDS[m[1]];
    return null;
}

// ---- Configure + hook -------------------------------------------------------

export function configureOracle(opts) {
    const o = opts || {};
    if (typeof o.worldPath === 'string') _opts.worldPath = o.worldPath;
    if (Number.isFinite(o.initialSweepRadius)) _opts.initialSweepRadius = o.initialSweepRadius;
    if (Array.isArray(o.initialSweepTypes)) _opts.initialSweepTypes = o.initialSweepTypes.slice();
    if (typeof o.jsonlSink === 'boolean') _opts.jsonlSink = o.jsonlSink;
    if (typeof o.jsonlFilename === 'string') _opts.jsonlFilename = o.jsonlFilename;
    if (typeof o.wasmDir === 'string') _opts.wasmDir = o.wasmDir;
}

function _warnDisable(reason) {
    if (_warnedDisable) return;
    _warnedDisable = true;
    console.warn('[Oracle] disabled: ' + reason);
}

function _note(msg) {
    console.log('[Oracle] ' + msg);
}

async function _loadWasm() {
    const wasmDir = _opts.wasmDir || path.resolve(__dirname, 'cubiomes_wasm');
    const glueJs = path.join(wasmDir, 'cubiomes_oracle.cjs');
    const wasmFile = path.join(wasmDir, 'cubiomes_oracle.wasm');
    if (!fs.existsSync(glueJs) || !fs.existsSync(wasmFile)) {
        throw new Error('cubiomes_wasm artifacts missing at ' + wasmDir);
    }
    const mod = await import(glueJs);
    const factory = mod.default || mod.CubiomesModule || mod;
    const instance = await factory({
        locateFile: (p) => (p.endsWith('.wasm') ? wasmFile : p),
    });
    _wasmModule = instance;
    _wasm_findNearestStructure = instance.cwrap(
        'findNearestStructure', 'number',
        ['number', 'number', 'number', 'number', 'number', 'number', 'number']
    );
    _wasm_oracleResultX = instance.cwrap('oracleResultX', 'number', []);
    _wasm_oracleResultZ = instance.cwrap('oracleResultZ', 'number', []);
    // Sanity check
    const selfTest = instance.cwrap('selfTest', 'number', []);
    if (selfTest() !== 4242) {
        throw new Error('selfTest mismatch');
    }
}

export function hookOracle(agent) {
    if (!agent || !agent.bot) return;
    if (agent._hookedOracle) return;
    agent._hookedOracle = true;

    // Fire-and-forget async init. All public exports stay inactive until init
    // completes (or fails). Callers must accept empty results gracefully.
    _asyncInit(agent).catch((err) => {
        _warnDisable('init threw: ' + (err && err.message ? err.message : String(err)));
    });
}

async function _asyncInit(agent) {
    // 1. Discover seed + mc_version
    let ctx;
    try {
        ctx = await discoverWorldContext({ worldPath: _opts.worldPath });
    } catch (e) {
        _warnDisable('level.dat read threw: ' + e.message);
        return;
    }
    if (!ctx) {
        _warnDisable('no level.dat found (world_path override: ' + (_opts.worldPath || 'none') + ')');
        return;
    }

    const mcId = _resolveMcVersionId(ctx.mc_version);
    if (mcId === null) {
        _warnDisable('unsupported mc_version ' + JSON.stringify(ctx.mc_version));
        return;
    }

    // 2. Load WASM
    try {
        await _loadWasm();
    } catch (e) {
        _warnDisable('wasm load failed: ' + e.message);
        return;
    }

    // 3. Latch seed into Lo/Hi halves (seed never logged)
    const seed = ctx.seed;
    const mask32 = 0xffffffffn;
    _seedLo = Number(seed & mask32) >>> 0;
    _seedHi = Number((seed >> 32n) & mask32) | 0;

    _mcVersionId = mcId;
    _mcVersionStr = ctx.mc_version;
    _worldPath = ctx.world_path;
    _seedSource = ctx.source;

    // 4. Prepare JSONL sink
    if (_opts.jsonlSink) {
        _jsonlPath = path.resolve(process.cwd(), _opts.jsonlFilename);
        try {
            fs.mkdirSync(path.dirname(_jsonlPath), { recursive: true });
        } catch (e) {
            // non-fatal; next append will fail loudly
        }
    }

    _oracleActive = true;
    _note(`loaded source=level.dat mc=${_mcVersionStr} world=${path.basename(_worldPath)}`);

    // 5. Initial sweep around spawn
    try {
        await _runInitialSweep(agent);
    } catch (e) {
        console.warn('[Oracle] initial sweep error: ' + e.message);
    }
}

function _lookupTypeId(name) {
    if (typeof name !== 'string') return null;
    const key = name.trim().toLowerCase();
    const id = STRUCTURE_IDS[key];
    return (id === undefined) ? null : id;
}

function _emitJsonl(obj) {
    if (!_jsonlPath) return;
    try {
        fs.appendFileSync(_jsonlPath, JSON.stringify(obj) + '\n');
    } catch (e) {
        // swallow; sink is best-effort
    }
}

function _pushResolution(entry) {
    _resolutionsSinceBoot++;
    _lastResolutions.push(entry);
    if (_lastResolutions.length > 64) _lastResolutions.shift();
}

async function _runInitialSweep(agent) {
    const bot = agent && agent.bot;
    if (!bot || !bot.entity || !bot.entity.position) return;
    const px = Math.floor(bot.entity.position.x);
    const pz = Math.floor(bot.entity.position.z);
    const radius = _opts.initialSweepRadius;

    for (const typeName of _opts.initialSweepTypes) {
        const typeId = _lookupTypeId(typeName);
        if (typeId === null) continue;
        try {
            const pos = _wasmFind(typeId, px, pz, radius);
            if (pos) {
                const record = {
                    type: 'structure',
                    subtype: typeName,
                    pos: [pos.x, 64, pos.z], // Y unknown from cubiomes; 64 is surface placeholder
                    dimension: bot.game && bot.game.dimension ? bot.game.dimension : 'overworld',
                    confidence: 0.6,
                    first_seen: Date.now(),
                    last_seen: Date.now(),
                    signals: 1,
                };
                try {
                    registerFromOracle(agent, record);
                } catch (e) {
                    // POI module missing or failed — don't crash oracle
                }
                _emitJsonl({
                    ts: Date.now(),
                    event: 'initial_sweep',
                    subtype: typeName,
                    pos: [pos.x, pos.z],
                    origin: [px, pz],
                    radius_regions: radius,
                });
                _pushResolution({ subtype: typeName, pos: [pos.x, pos.z], via: 'initial_sweep' });
                _initialSweepCount++;
            }
        } catch (e) {
            console.warn(`[Oracle] sweep failed for ${typeName}: ${e.message}`);
        }
    }
    _note(`initial sweep complete; ${_initialSweepCount}/${_opts.initialSweepTypes.length} resolved`);
}

function _wasmFind(typeId, blockX, blockZ, radiusRegions) {
    const ok = _wasm_findNearestStructure(
        typeId, _mcVersionId,
        _seedLo, _seedHi,
        blockX, blockZ, radiusRegions
    );
    if (!ok) return null;
    return { x: _wasm_oracleResultX(), z: _wasm_oracleResultZ() };
}

// ---- Public query API -------------------------------------------------------

export function getStructuresNear(blockX, blockZ, radiusRegions, types) {
    if (!_oracleActive) return [];
    const list = Array.isArray(types) && types.length > 0
        ? types
        : ['village', 'outpost', 'ancient_city', 'mansion', 'monument', 'trail_ruins', 'stronghold'];
    const results = [];
    for (const typeName of list) {
        const typeId = _lookupTypeId(typeName);
        if (typeId === null) continue;
        try {
            const pos = _wasmFind(typeId, blockX, blockZ, radiusRegions || 16);
            if (pos) {
                const entry = {
                    subtype: typeName,
                    x: pos.x,
                    z: pos.z,
                    distance: Math.round(Math.hypot(pos.x - blockX, pos.z - blockZ)),
                };
                results.push(entry);
                _emitJsonl({
                    ts: Date.now(),
                    event: 'query',
                    subtype: typeName,
                    pos: [pos.x, pos.z],
                    origin: [blockX, blockZ],
                    radius_regions: radiusRegions || 16,
                });
                _pushResolution({ subtype: typeName, pos: [pos.x, pos.z], via: 'query' });
            }
        } catch (e) {
            // per-type failure shouldn't abort the batch
        }
    }
    return results;
}

export function getOracleStats() {
    return {
        active: _oracleActive,
        mc_version: _mcVersionStr,
        initial_sweep_count: _initialSweepCount,
        resolutions_since_boot: _resolutionsSinceBoot,
    };
}

export function getOracleSnapshot() {
    // StateTicker-safe; never includes the seed value.
    if (!_oracleActive) return null;
    return {
        active: true,
        mc_version: _mcVersionStr,
        source: _seedSource,
        resolutions: _resolutionsSinceBoot,
        last_resolutions: _lastResolutions.slice(-5),
    };
}

// Test hook — do NOT use in production. Intended for unit-test scaffolding.
export function _resetOracleForTests() {
    _oracleActive = false;
    _warnedDisable = false;
    _mcVersionId = null;
    _mcVersionStr = null;
    _worldPath = null;
    _seedSource = null;
    _seedLo = 0;
    _seedHi = 0;
    _wasmModule = null;
    _wasm_findNearestStructure = null;
    _wasm_oracleResultX = null;
    _wasm_oracleResultZ = null;
    _initialSweepCount = 0;
    _resolutionsSinceBoot = 0;
    _lastResolutions = [];
    _jsonlPath = null;
}
