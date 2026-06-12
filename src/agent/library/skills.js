import { readFileSync, existsSync } from 'fs';
import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../utils/inventory_utils.js';
import { withBotLock, botMutex } from '../bot_mutex.js';
import { wrapSkill } from '../../observability/skill_lifecycle.js';
// Re-export public API from _shared so skills.js remains the single entry point.
export { log, wait, createMovements, installSafePathfinderDefaults } from './skills/_shared.js';
// Import domain-internal helpers (not re-exported).
import {
  expandBlockFamily, BLOCK_FAMILIES,
  _isInSpawnZone, _isNearProtectedZone, _isInAnyProtectedZone,
  _equipBestToolFor, _isUnderground, _isDangerous,
  SPAWN_PROTECTION_RADIUS, SPAWN_ESCAPE_DISTANCE,
} from './skills/_shared.js';
export * from './skills/crafting.js';
import { craftRecipe } from './skills/crafting.js';
export * from './skills/combat.js';
export * from './skills/social.js';
export * from './skills/blocks.js';
export * from './skills/movement.js';
export * from './skills/inventory.js';
// Import inventory functions for internal use by remaining skills.js functions
import { equip, replaceBrokenArmor, safeToss, safeTossBatch, discard, putInChest, takeFromChest, viewChest, giveToPlayer } from './skills/inventory.js';
// Import for internal use by remaining skills.js functions
import { placeBlock, breakBlockAt, pickupNearbyItems, autoBreakStuckPlant } from './skills/blocks.js';
import { goToGoal, goToPosition, goToPlayer, moveAwayFromEntity } from './skills/movement.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;



/**
 * Load manual player-defined protected zones from `player_structures.json` at
 * the repo root. Called once at agent startup from agent.js.
 *
 * File shape (JSON):
 *   { "structures": [ { "name": "...", "x": 0, "z": 0, "radius": 32, "yMin": 40, "yMax": 90 }, ... ] }
 *
 * Graceful degradation — any failure mode leaves bot.protectedZones unchanged
 * (empty if not populated elsewhere yet) and logs clearly:
 *   - File missing → start with no manual zones (no log noise for first-time users)
 *   - JSON parse error → log and skip all
 *   - Entry missing required fields (name, x, z, radius) → log warning and skip that entry
 *   - Entry has invalid types → log warning and skip that entry
 *
 * Called from agent.js startup. Returns count of loaded zones for log context.
 */
export function loadPlayerStructures(bot) {
    if (!Array.isArray(bot.protectedZones)) bot.protectedZones = [];
    const filepath = 'player_structures.json';

    if (!existsSync(filepath)) {
        console.log('[ProtectedZone] No player_structures.json at repo root — no manual zones loaded (this is normal for fresh installs).');
        return 0;
    }

    let parsed;
    try {
        parsed = JSON.parse(readFileSync(filepath, 'utf8'));
    } catch (err) {
        console.warn(`[ProtectedZone] Failed to parse player_structures.json: ${err.message}. No manual zones loaded.`);
        return 0;
    }

    const entries = Array.isArray(parsed?.structures) ? parsed.structures : [];
    let loaded = 0, skipped = 0;
    for (const entry of entries) {
        // Validate required fields
        if (typeof entry?.name !== 'string' ||
            typeof entry?.x !== 'number' ||
            typeof entry?.z !== 'number' ||
            typeof entry?.radius !== 'number' || entry.radius <= 0) {
            console.warn(`[ProtectedZone] Skipping invalid entry: ${JSON.stringify(entry)} — missing name/x/z/radius or bad types.`);
            skipped++;
            continue;
        }
        // Optional Y bounds
        const yMin = typeof entry.yMin === 'number' ? entry.yMin : undefined;
        const yMax = typeof entry.yMax === 'number' ? entry.yMax : undefined;
        bot.protectedZones.push({
            name: entry.name,
            type: 'structure',
            x: entry.x,
            z: entry.z,
            radius: entry.radius,
            ...(yMin !== undefined ? { yMin } : {}),
            ...(yMax !== undefined ? { yMax } : {}),
        });
        loaded++;
    }

    const suffix = skipped > 0 ? ` (${skipped} skipped due to validation errors)` : '';
    console.log(`[ProtectedZone] Loaded ${loaded} manual zone(s) from player_structures.json${suffix}.`);
    return loaded;
}


// ====================================================================
// #7 Village auto-detection (2026-04-15)
//
// Detects active and abandoned villages near the bot and auto-registers
// them as protected zones with type: 'village'. Three independent signals;
// any of them triggers registration. Union keeps the detector robust to
// raided/abandoned villages (no villagers left), lost bells, or unusual
// village layouts.
//
// Signal 1 — villager entities: ≥3 villagers clustered within
//   VILLAGE_CLUSTER_RADIUS of each other. Catches active villages.
// Signal 2 — profession workstation blocks: ≥3 of the workstation list
//   clustered within VILLAGE_CLUSTER_RADIUS. Catches abandoned villages
//   where villagers died/were converted.
// Signal 3 — bell blocks: any bell within VILLAGE_SCAN_RADIUS is treated
//   as a village anchor. Bells are village-exclusive in vanilla.
//
// Zone registered as:
//   { name: 'village_<x>_<z>', type: 'village', x, z,
//     radius: VILLAGE_PROTECT_RADIUS,
//     yMin: centerY - VILLAGE_Y_BELOW,
//     yMax: centerY + VILLAGE_Y_ABOVE }
// yMin/yMax computed from the signal center's Y, so deep-mining below
// and high-building above the village aren't blocked.
//
// Dedup: before appending a new zone, check existing bot.protectedZones;
// if any zone's XZ center is within VILLAGE_DEDUP_RADIUS of the proposed
// center, skip the add (same village, or covered by a larger manual zone).
// ====================================================================

// Scan parameters (tuned per JP 2026-04-15)
const VILLAGE_SCAN_RADIUS = 128;       // how far to look for entities/blocks
const VILLAGE_CLUSTER_RADIUS = 32;     // how close signals must be to count as one village
const VILLAGE_PROTECT_RADIUS = 100;    // protected XZ radius (200x200 box)
const VILLAGE_Y_BELOW = 20;            // yMin = centerY - this
const VILLAGE_Y_ABOVE = 30;            // yMax = centerY + this
const VILLAGE_MIN_SIGNALS = 3;         // villagers or workstations needed (bell alone also triggers)
const VILLAGE_DEDUP_RADIUS = 50;       // skip registration if existing zone is within this XZ

// Profession workstation blocks that strongly indicate a village.
// Excluded: brewing_stand (too common in player bases), smithing_table (players
// use it for netherite), cauldron (also a player-base item). The included list
// covers workstations that rarely cluster outside villages.
const VILLAGE_WORKSTATIONS = [
    'bell', 'composter', 'smoker', 'loom', 'cartography_table',
    'blast_furnace', 'grindstone', 'fletching_table',
    'lectern', 'stonecutter',
];

/**
 * Cluster a list of {x, y, z} positions by proximity. Returns an array of
 * clusters; each cluster has {positions, centerX, centerY, centerZ, count}.
 * Two positions belong to the same cluster if their XZ distance ≤ radius.
 * Greedy single-pass — good enough for our small N (tens, not thousands).
 */
function _clusterPositions(positions, radius) {
    const clusters = [];
    for (const p of positions) {
        let joined = false;
        for (const c of clusters) {
            const dx = p.x - c.centerX;
            const dz = p.z - c.centerZ;
            if (dx * dx + dz * dz <= radius * radius) {
                c.positions.push(p);
                // Running average of center
                c.centerX = (c.centerX * c.count + p.x) / (c.count + 1);
                c.centerY = (c.centerY * c.count + p.y) / (c.count + 1);
                c.centerZ = (c.centerZ * c.count + p.z) / (c.count + 1);
                c.count++;
                joined = true;
                break;
            }
        }
        if (!joined) {
            clusters.push({
                positions: [p],
                centerX: p.x, centerY: p.y, centerZ: p.z,
                count: 1,
            });
        }
    }
    return clusters;
}

/**
 * True if the bot already has a zone covering (x, z) within VILLAGE_DEDUP_RADIUS.
 * Prevents duplicate registrations across periodic scans and across signal types.
 */
function _villageAlreadyRegistered(bot, x, z) {
    if (!Array.isArray(bot.protectedZones)) return false;
    for (const zone of bot.protectedZones) {
        const dx = x - zone.x;
        const dz = z - zone.z;
        if (dx * dx + dz * dz <= VILLAGE_DEDUP_RADIUS * VILLAGE_DEDUP_RADIUS) return true;
    }
    return false;
}

/**
 * Build a zone object from a detected village center and a source label.
 * Extracted so all three detection signals produce identical zone shapes.
 */
function _villageZoneFromCenter(x, y, z, source) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    const zi = Math.round(z);
    return {
        name: `village_${xi}_${zi}`,
        type: 'village',
        source, // 'villagers' | 'workstations' | 'bell' — diagnostic, not required downstream
        x: xi,
        z: zi,
        radius: VILLAGE_PROTECT_RADIUS,
        yMin: yi - VILLAGE_Y_BELOW,
        yMax: yi + VILLAGE_Y_ABOVE,
    };
}

/**
 * Detect nearby villages via three independent signals and register them to
 * bot.protectedZones. Called at startup and periodically from agent.js.
 *
 * Safe to call repeatedly — dedup prevents duplicates. Returns the number of
 * zones newly added on this invocation (0 if no new villages detected).
 *
 * Read-only with respect to the world — only reads entities and blocks,
 * never places or mines anything.
 */
function detectNearbyVillages(bot) {
    if (!Array.isArray(bot.protectedZones)) bot.protectedZones = [];
    let added = 0;

    // Signal 1 — villager entities
    try {
        const villagerPositions = [];
        for (const e of Object.values(bot.entities || {})) {
            if (!e || !e.position) continue;
            if (e.name === 'villager' || e.type === 'villager') {
                const p = e.position;
                if (bot.entity?.position?.distanceTo?.(p) > VILLAGE_SCAN_RADIUS) continue;
                villagerPositions.push({ x: p.x, y: p.y, z: p.z });
            }
        }
        const villagerClusters = _clusterPositions(villagerPositions, VILLAGE_CLUSTER_RADIUS);
        for (const c of villagerClusters) {
            if (c.count < VILLAGE_MIN_SIGNALS) continue;
            if (_villageAlreadyRegistered(bot, c.centerX, c.centerZ)) continue;
            const zone = _villageZoneFromCenter(c.centerX, c.centerY, c.centerZ, 'villagers');
            bot.protectedZones.push(zone);
            console.log(`[VillageDetect] Registered ${zone.name} via ${c.count} villagers; Y[${zone.yMin}..${zone.yMax}]`);
            added++;
        }
    } catch (err) {
        console.warn('[VillageDetect] Villager scan failed:', err.message);
    }

    // Signals 2 & 3 — workstation blocks (including bell)
    try {
        const workstationIds = VILLAGE_WORKSTATIONS
            .map(n => mc.getBlockId(n))
            .filter(id => typeof id === 'number');
        if (workstationIds.length === 0) return added; // mcdata not ready; bail gracefully

        const positions = bot.findBlocks({
            matching: workstationIds,
            maxDistance: VILLAGE_SCAN_RADIUS,
            count: 100,
        });
        if (!positions || positions.length === 0) return added;

        // Separate bells from other workstations — bell alone is enough
        const bellId = mc.getBlockId('bell');
        const bellPositions = [];
        const otherPositions = [];
        for (const p of positions) {
            const block = bot.blockAt(p);
            if (!block) continue;
            const item = { x: p.x, y: p.y, z: p.z };
            if (block.type === bellId || block.name === 'bell') bellPositions.push(item);
            else otherPositions.push(item);
        }

        // Signal 3 — every bell is its own village anchor
        for (const b of bellPositions) {
            if (_villageAlreadyRegistered(bot, b.x, b.z)) continue;
            const zone = _villageZoneFromCenter(b.x, b.y, b.z, 'bell');
            bot.protectedZones.push(zone);
            console.log(`[VillageDetect] Registered ${zone.name} via bell; Y[${zone.yMin}..${zone.yMax}]`);
            added++;
        }

        // Signal 2 — ≥3 non-bell workstations clustered
        const workstationClusters = _clusterPositions(otherPositions, VILLAGE_CLUSTER_RADIUS);
        for (const c of workstationClusters) {
            if (c.count < VILLAGE_MIN_SIGNALS) continue;
            if (_villageAlreadyRegistered(bot, c.centerX, c.centerZ)) continue;
            const zone = _villageZoneFromCenter(c.centerX, c.centerY, c.centerZ, 'workstations');
            bot.protectedZones.push(zone);
            console.log(`[VillageDetect] Registered ${zone.name} via ${c.count} workstations; Y[${zone.yMin}..${zone.yMax}]`);
            added++;
        }
    } catch (err) {
        console.warn('[VillageDetect] Block scan failed:', err.message);
    }

    return added;
}

/**
 * Start periodic village scanning. Fires once immediately, then every
 * VILLAGE_SCAN_INTERVAL_MS. Returns the interval handle so the caller can
 * clear it on shutdown (not strictly required — the bot tends to restart
 * rather than shut down cleanly).
 */
const VILLAGE_SCAN_INTERVAL_MS = 30_000; // 30s cadence
function startVillageScanner(bot) {
    // Fire once immediately after first chunk load has populated entities
    setTimeout(() => {
        try { detectNearbyVillages(bot); } catch (err) { console.warn('[VillageDetect] Initial scan failed:', err.message); }
    }, 5000);

    // Periodic thereafter
    return setInterval(() => {
        try { detectNearbyVillages(bot); } catch (err) { console.warn('[VillageDetect] Periodic scan failed:', err.message); }
    }, VILLAGE_SCAN_INTERVAL_MS);
}

// Exports for agent.js startup wiring
export { detectNearbyVillages, startVillageScanner };

// === BT-7c (2026-04-19): heuristic auto-detection of player-built structures ===
// Complements the village detector. Scans chunks around the bot for clusters of
// strongly player-characteristic blocks (stone bricks, wool, concrete, redstone,
// banners, beds, doors, glass panes). Clusters above the signal threshold
// register a protected zone of type='player_base'. Dedups against existing
// zones so re-scans are idempotent.

const PLAYER_SCAN_RADIUS = 64;
const PLAYER_CLUSTER_RADIUS = 12;
const PLAYER_MIN_SIGNALS = 6;
const PLAYER_PROTECT_RADIUS = 40;
const PLAYER_Y_BELOW = 20;
const PLAYER_Y_ABOVE = 30;
const PLAYER_DEDUP_RADIUS = 30;

const PLAYER_CHARACTERISTIC_BLOCKS = [
    'stone_bricks',
    'mossy_stone_bricks',
    'cracked_stone_bricks',
    'chiseled_stone_bricks',
    'polished_granite',
    'polished_diorite',
    'polished_andesite',
    'polished_blackstone',
    'polished_blackstone_bricks',
    // Doors
    'oak_door',
    'spruce_door',
    'birch_door',
    'jungle_door',
    'acacia_door',
    'dark_oak_door',
    'mangrove_door',
    'cherry_door',
    'bamboo_door',
    'crimson_door',
    'warped_door',
    'iron_door',
    // Glass panes
    'glass_pane',
    'white_stained_glass_pane',
    'orange_stained_glass_pane',
    'magenta_stained_glass_pane',
    'light_blue_stained_glass_pane',
    'yellow_stained_glass_pane',
    'lime_stained_glass_pane',
    'pink_stained_glass_pane',
    'gray_stained_glass_pane',
    'light_gray_stained_glass_pane',
    'cyan_stained_glass_pane',
    'purple_stained_glass_pane',
    'blue_stained_glass_pane',
    'brown_stained_glass_pane',
    'green_stained_glass_pane',
    'red_stained_glass_pane',
    'black_stained_glass_pane',
    // Wool
    'white_wool',
    'orange_wool',
    'magenta_wool',
    'light_blue_wool',
    'yellow_wool',
    'lime_wool',
    'pink_wool',
    'gray_wool',
    'light_gray_wool',
    'cyan_wool',
    'purple_wool',
    'blue_wool',
    'brown_wool',
    'green_wool',
    'red_wool',
    'black_wool',
    // Concrete
    'white_concrete',
    'orange_concrete',
    'magenta_concrete',
    'light_blue_concrete',
    'yellow_concrete',
    'lime_concrete',
    'pink_concrete',
    'gray_concrete',
    'light_gray_concrete',
    'cyan_concrete',
    'purple_concrete',
    'blue_concrete',
    'brown_concrete',
    'green_concrete',
    'red_concrete',
    'black_concrete',
    // Redstone mechanisms
    'redstone_lamp',
    'redstone_torch',
    'repeater',
    'comparator',
    'piston',
    'sticky_piston',
    'observer',
    'hopper',
    'dispenser',
    'dropper',
    'lever',
    'note_block',
    // Banners
    'white_banner',
    'orange_banner',
    'magenta_banner',
    'light_blue_banner',
    'yellow_banner',
    'lime_banner',
    'pink_banner',
    'gray_banner',
    'light_gray_banner',
    'cyan_banner',
    'purple_banner',
    'blue_banner',
    'brown_banner',
    'green_banner',
    'red_banner',
    'black_banner',
    // Beds
    'white_bed',
    'orange_bed',
    'magenta_bed',
    'light_blue_bed',
    'yellow_bed',
    'lime_bed',
    'pink_bed',
    'gray_bed',
    'light_gray_bed',
    'cyan_bed',
    'purple_bed',
    'blue_bed',
    'brown_bed',
    'green_bed',
    'red_bed',
    'black_bed',
];

function _playerBaseAlreadyRegistered(bot, x, z) {
    if (!Array.isArray(bot.protectedZones)) return false;
    for (const z0 of bot.protectedZones) {
        const dx = (z0.x ?? 0) - x;
        const dz = (z0.z ?? 0) - z;
        if (dx * dx + dz * dz <= PLAYER_DEDUP_RADIUS * PLAYER_DEDUP_RADIUS) return true;
    }
    return false;
}

function _playerBaseZoneFromCenter(x, y, z, signalCount) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    const zi = Math.round(z);
    return {
        name: `player_base_${xi}_${zi}`,
        type: 'player_base',
        x: xi,
        z: zi,
        radius: PLAYER_PROTECT_RADIUS,
        yMin: yi - PLAYER_Y_BELOW,
        yMax: yi + PLAYER_Y_ABOVE,
        source: `auto-detect (${signalCount} signals)`,
    };
}

/**
 * Scan for clusters of player-characteristic blocks around the bot. Registers
 * each qualifying cluster as a protected zone in bot.protectedZones.
 * @param {MinecraftBot} bot
 * @returns {number} number of new zones registered this scan.
 */
function detectNearbyPlayerStructures(bot) {
    let registered = 0;
    try {
        const registry = bot.registry;
        if (!registry) return 0;

        // Resolve block name list -> numeric id list (some blocks may not exist
        // in this mineflayer data version — skip silently).
        const ids = [];
        for (const name of PLAYER_CHARACTERISTIC_BLOCKS) {
            const b = registry.blocksByName[name];
            if (b) ids.push(b.id);
        }
        if (ids.length === 0) return 0;
        const idSet = new Set(ids);

        const positions = bot.findBlocks({
            matching: (block) => idSet.has(block.type),
            maxDistance: PLAYER_SCAN_RADIUS,
            count: 512,
        });
        if (!positions || positions.length === 0) return 0;

        const clusters = _clusterPositions(positions, PLAYER_CLUSTER_RADIUS);
        for (const c of clusters) {
            if (c.count < PLAYER_MIN_SIGNALS) continue;
            if (_playerBaseAlreadyRegistered(bot, c.centerX, c.centerZ)) continue;
            const zone = _playerBaseZoneFromCenter(c.centerX, c.centerY, c.centerZ, c.count);
            if (!Array.isArray(bot.protectedZones)) bot.protectedZones = [];
            bot.protectedZones.push(zone);
            log(bot, `[PlayerStructureScan] Detected player-built cluster at (${zone.x}, ${zone.z}) — ${c.count} signals; registering zone ${zone.name} (radius ${PLAYER_PROTECT_RADIUS})`);
            registered++;
        }
    } catch (err) {
        console.warn('[PlayerStructureScan] scan failed:', err.message);
    }
    return registered;
}

const PLAYER_STRUCTURE_SCAN_INTERVAL_MS = 30_000;
function startPlayerStructureScanner(bot) {
    setTimeout(() => {
        try { detectNearbyPlayerStructures(bot); } catch (err) { console.warn('[PlayerStructureScan] Initial scan failed:', err.message); }
    }, 10_000);

    return setInterval(() => {
        try { detectNearbyPlayerStructures(bot); } catch (err) { console.warn('[PlayerStructureScan] Periodic scan failed:', err.message); }
    }, PLAYER_STRUCTURE_SCAN_INTERVAL_MS);
}

/**
 * #7d — Block-update watcher for runtime-placed structures.
 *
 * Live counterpart to `startPlayerStructureScanner` (which is a 30s poll).
 * Hooks `bot.on('blockUpdate')` and keeps a 10-minute sliding window of
 * player-characteristic block placements. On each qualifying placement,
 * runs one cluster pass over the window; promotes any cluster that hits
 * `PLAYER_MIN_SIGNALS` (and isn't already within `PLAYER_DEDUP_RADIUS` of
 * a registered zone) via the same `_playerBaseZoneFromCenter` used by the
 * scanner — identical zone shape, identical dedup.
 *
 * Why both scanner AND watcher:
 *   - Scanner handles bases the bot walks into (bot moves, structures are
 *     static).
 *   - Watcher handles bases the player builds while the bot is nearby
 *     (bot stationary, structures change) — sub-second latency instead of
 *     up to 40s on the poll.
 *
 * These are complementary capabilities, not duplicates (Principle 5).
 *
 * Filter: newBlock.name in `PLAYER_CHARACTERISTIC_BLOCKS` AND oldBlock was
 * air / water / a replaceable (cave_air, void_air, water, lava, bubble_column,
 * null) — skips state-only changes (water flow, redstone toggles, leaf decay,
 * fire spread, furnace-burning ticks) which fire `blockUpdate` constantly in
 * loaded chunks.
 *
 * Idempotent: `bot._playerStructureWatcherHooked` reference-identity gate so
 * soft reconnects never double-hook the same bot instance.
 */

const PLAYER_WATCHER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const _PLACEMENT_OLD_ALLOWED = new Set([
    'air', 'cave_air', 'void_air',
    'water', 'lava', 'bubble_column',
    'snow', 'short_grass', 'tall_grass', 'fern', 'large_fern',
    'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
]);

function startPlayerStructureWatcher(bot) {
    if (bot._playerStructureWatcherHooked === bot) return;
    bot._playerStructureWatcherHooked = bot;

    // Window: Map<"x,y,z", {ts, name}>
    const window = new Map();

    const allowedIds = new Set();
    for (const name of PLAYER_CHARACTERISTIC_BLOCKS) {
        const b = bot.registry?.blocksByName?.[name];
        if (b) allowedIds.add(b.id);
    }

    bot.on('blockUpdate', (oldBlock, newBlock) => {
        try {
            if (!newBlock || !allowedIds.has(newBlock.type)) return;
            const oldName = oldBlock ? oldBlock.name : 'air';
            if (!_PLACEMENT_OLD_ALLOWED.has(oldName)) return;

            const pos = newBlock.position;
            if (!pos) return;
            const key = `${pos.x},${pos.y},${pos.z}`;
            const now = Date.now();
            window.set(key, { ts: now, name: newBlock.name, x: pos.x, y: pos.y, z: pos.z });

            // Prune aged-out entries.
            const cutoff = now - PLAYER_WATCHER_WINDOW_MS;
            for (const [k, v] of window) {
                if (v.ts < cutoff) window.delete(k);
            }

            if (window.size < PLAYER_MIN_SIGNALS) return;

            // Cluster the window's positions using the same helper as #7c.
            const positions = Array.from(window.values()).map(v => ({ x: v.x, y: v.y, z: v.z }));
            const clusters = _clusterPositions(positions, PLAYER_CLUSTER_RADIUS);
            for (const c of clusters) {
                if (c.count < PLAYER_MIN_SIGNALS) continue;
                if (_playerBaseAlreadyRegistered(bot, c.centerX, c.centerZ)) continue;
                const zone = _playerBaseZoneFromCenter(c.centerX, c.centerY, c.centerZ, c.count);
                bot.protectedZones = bot.protectedZones || [];
                bot.protectedZones.push(zone);
                console.log(`[PlayerStructureWatch] live cluster at (${c.centerX}, ${c.centerZ}) — ${c.count} signals; registering zone ${zone.name} (radius ${zone.radius})`);
            }
        } catch (err) {
            console.warn('[PlayerStructureWatch] handler failed:', err.message);
        }
    });
}

export { detectNearbyPlayerStructures, startPlayerStructureScanner, startPlayerStructureWatcher };



/**
 * Walk the bot out of the spawn protection zone if it's inside it.
 *
 * Strategy (Bug B fix 2026-04-15):
 *
 *   1. CACHED EXIT — if bot.escapeMemory has a recorded successful exit
 *      from this spawn coordinate, try it first with a direct path.
 *
 *   2. COMMIT-TO-DIRECTION — pick ONE of 8 directions (4 cardinals +
 *      4 diagonals) based on drift-from-spawn. Commit to that direction.
 *      Walk in 40-block hops with 45s timeouts. If a hop makes >=10 blocks
 *      of progress, continue forward. If stuck (<10 progress), run a
 *      "stuck maneuver" (back 2-3 blocks + side 15 blocks alternating
 *      left/right), then retry the primary direction from the new position.
 *
 *   3. DIRECTION SWITCH — if 5 consecutive stuck attempts exhaust a
 *      direction, switch to the next-best one (sorted by drift proximity).
 *      No bail on individual direction failures; try all 8 before giving up.
 *
 *   4. EXIT RECORDING — on successful escape (crossing the 250-block
 *      boundary), record {spawnX, spawnZ, exitX, exitY, exitZ, timestamp}
 *      to bot.escapeMemory for next time.
 *
 * Called on every spawn (before the self-prompter starts) and as an
 * AutoRecovery handler if a destructive action hits spawn protection.
 *
 * Returns true on escape success or if bot was already outside. Returns
 * false only after all 8 directions are fully exhausted (rare — usually
 * indicates bedrock / water / truly impassable terrain surrounding spawn).
 */
const ESCAPE_HOP_DISTANCE = 40;               // each waypoint 40 blocks further in chosen direction
const ESCAPE_HOP_TIMEOUT_MS = 45000;           // 45s per hop
const ESCAPE_STUCK_MANEUVER_TIMEOUT_MS = 20000; // 20s for back-up / sidestep
const ESCAPE_CACHED_EXIT_TIMEOUT_MS = 90000;   // 90s for cached-exit attempt
const ESCAPE_MAX_STUCKS_PER_DIRECTION = 5;     // give up on a direction after 5 stucks
const ESCAPE_PROGRESS_THRESHOLD = 10;           // blocks-of-progress that counts as "made progress"
const ESCAPE_MEMORY_MAX = 50;                   // most-recent entries to keep
const ESCAPE_MEMORY_SPAWN_MATCH_RADIUS = 20;   // consider memory entries within this many blocks
const ESCAPE_MEMORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ESCAPE_BACK_BLOCKS = 3;                   // back up N blocks when stuck (before sidestep)
const ESCAPE_SIDE_BLOCKS = 15;                  // sidestep perpendicular distance

// Snap an unnormalized (dx, dz) vector to the nearest of 8 unit directions,
// and return all 8 sorted by angular proximity to the input (closest first).
// If input vector is near-zero, fall back to +X as primary.
function _rank8DirectionsByDrift(dx, dz) {
    const EIGHT = [
        { dx: 1, dz: 0, label: '+X' },
        { dx: 1, dz: 1, label: '+X+Z' },
        { dx: 0, dz: 1, label: '+Z' },
        { dx: -1, dz: 1, label: '-X+Z' },
        { dx: -1, dz: 0, label: '-X' },
        { dx: -1, dz: -1, label: '-X-Z' },
        { dx: 0, dz: -1, label: '-Z' },
        { dx: 1, dz: -1, label: '+X-Z' },
    ];
    const mag = Math.sqrt(dx * dx + dz * dz);
    if (mag < 0.001) {
        // At spawn — no drift. Return directions in fixed order.
        return EIGHT.map(d => ({ ...d, _unit: _unitize(d.dx, d.dz) }));
    }
    const ux = dx / mag, uz = dz / mag;
    return EIGHT
        .map(d => {
            const u = _unitize(d.dx, d.dz);
            // cosine similarity as sort key — higher is closer to drift
            const cos = ux * u.dx + uz * u.dz;
            return { ...d, _unit: u, _cos: cos };
        })
        .sort((a, b) => b._cos - a._cos);
}

function _unitize(dx, dz) {
    const mag = Math.sqrt(dx * dx + dz * dz);
    return mag < 0.001 ? { dx: 0, dz: 0 } : { dx: dx / mag, dz: dz / mag };
}

// Find the closest matching memory entry for the given spawn coordinates.
// Returns the entry or null. Prunes stale entries in place.
function _findCachedExit(bot, spawn) {
    if (!Array.isArray(bot.escapeMemory) || bot.escapeMemory.length === 0) return null;
    const now = Date.now();
    bot.escapeMemory = bot.escapeMemory.filter(e => now - (e.timestamp || 0) < ESCAPE_MEMORY_MAX_AGE_MS);
    let best = null;
    let bestDistSq = Infinity;
    for (const e of bot.escapeMemory) {
        const dx = e.spawnX - spawn.x;
        const dz = e.spawnZ - spawn.z;
        const ds = dx * dx + dz * dz;
        if (ds <= ESCAPE_MEMORY_SPAWN_MATCH_RADIUS * ESCAPE_MEMORY_SPAWN_MATCH_RADIUS && ds < bestDistSq) {
            best = e;
            bestDistSq = ds;
        }
    }
    return best;
}

// Record a successful exit for future escapes from the same spawn area.
function _recordEscapeExit(bot, spawn, exitPos) {
    if (!Array.isArray(bot.escapeMemory)) bot.escapeMemory = [];
    bot.escapeMemory.push({
        spawnX: Math.floor(spawn.x),
        spawnZ: Math.floor(spawn.z),
        exitX: Math.floor(exitPos.x),
        exitY: Math.floor(exitPos.y),
        exitZ: Math.floor(exitPos.z),
        timestamp: Date.now(),
    });
    if (bot.escapeMemory.length > ESCAPE_MEMORY_MAX) {
        bot.escapeMemory = bot.escapeMemory.slice(-ESCAPE_MEMORY_MAX);
    }
}

// ---------- Teleport / reset instrumentation (2026-04-15) ----------
// Observed: bot reaches 245 blocks from spawn, then jumps back to ~20
// blocks with no death/reconnect logged. We want to catch the source.
// Listens once per bot for mineflayer events that indicate server-side
// position resets: forcedMove (server teleport packet), respawn, death,
// and path_update failures. Also suspects any unexplained >100-block
// position delta between hops.
const _spawnEscapeInstrumented = new WeakSet();
function _installSpawnEscapeInstrumentation(bot) {
    if (_spawnEscapeInstrumented.has(bot)) return;
    _spawnEscapeInstrumented.add(bot);

    const posStr = () => {
        const p = bot.entity?.position;
        if (!p) return '(no entity)';
        return `(${p.x?.toFixed(1)}, ${p.y?.toFixed(1)}, ${p.z?.toFixed(1)})`;
    };

    // Throttle forcedMove logging — server can spam corrections for stuck/lag
    // states (observed 952/min for same coord). Log first event, then count
    // bursts and emit a summary every 5s.
    let _fmLastLogged = 0;
    let _fmBurstCount = 0;
    let _fmLastPos = null;
    // #28 re-fire state — debounce + cooldown so bursts don't spam escape calls.
    let _fmReFireScheduled = false;
    let _fmLastReFireMs = 0;

    // #22b NaN-position suffocation recovery state.
    // Why: BT-22's pre-move guard rejects solid TARGETS, but a hitbox already
    // wedged in solids (mob shove, fall into pocket, pathfinder glitch) reads
    // as `source:unknown pos:null` for ~13s before the bot dies. We detect
    // the NaN-position-during-health-drop signature and intervene.
    let _suffocLastGoodPos = null;
    let _suffocFirstTickMs = 0;
    let _suffocTickCount = 0;
    let _suffocStageARan = false;
    let _suffocStageBRan = false;
    let _suffocJumpTimer = null;

    const _suffocReset = (reason) => {
        if (_suffocTickCount > 0 || _suffocStageARan || _suffocStageBRan) {
            console.log(`[SuffocationRecovery] reset (${reason})`);
        }
        _suffocFirstTickMs = 0;
        _suffocTickCount = 0;
        _suffocStageARan = false;
        _suffocStageBRan = false;
        if (_suffocJumpTimer) {
            clearInterval(_suffocJumpTimer);
            _suffocJumpTimer = null;
        }
    };

    const _suffocStageA = () => {
        _suffocStageARan = true;
        console.log('[SuffocationRecovery] stage_a — cancelling pathfinder + jump-spam 2s');
        try {
            if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
                bot.pathfinder.setGoal(null);
            }
            if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
                bot.pathfinder.stop();
            }
        } catch (err) {
            console.warn(`[SuffocationRecovery] pathfinder stop failed: ${err && err.message ? err.message : err}`);
        }
        try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (_) {}
        let pulses = 0;
        _suffocJumpTimer = setInterval(() => {
            pulses++;
            try {
                bot.setControlState('jump', true);
                setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 100);
            } catch (_) {}
            if (pulses >= 8) {
                clearInterval(_suffocJumpTimer);
                _suffocJumpTimer = null;
            }
        }, 250);
    };

    const _suffocStageB = () => {
        _suffocStageBRan = true;
        const lgp = _suffocLastGoodPos
            ? `(${_suffocLastGoodPos.x.toFixed(1)}, ${_suffocLastGoodPos.y.toFixed(1)}, ${_suffocLastGoodPos.z.toFixed(1)})`
            : '(unknown)';
        console.log(`[SuffocationRecovery] stage_b — self-kill via /kill (last good pos: ${lgp})`);
        try {
            bot.chat('/kill');
        } catch (err) {
            console.warn(`[SuffocationRecovery] /kill chat failed: ${err && err.message ? err.message : err}`);
        }
    };

    const _suffocSamplePos = () => {
        const pp = bot.entity?.position;
        if (pp && Number.isFinite(pp.x) && Number.isFinite(pp.y) && Number.isFinite(pp.z)) {
            // Only update if meaningfully different (avoid object churn each tick).
            if (!_suffocLastGoodPos
                || Math.abs(_suffocLastGoodPos.x - pp.x) > 0.5
                || Math.abs(_suffocLastGoodPos.y - pp.y) > 0.5
                || Math.abs(_suffocLastGoodPos.z - pp.z) > 0.5) {
                _suffocLastGoodPos = { x: pp.x, y: pp.y, z: pp.z };
            }
        }
    };
    bot.on('forcedMove', () => {
        const p = bot.entity?.position;
        const now = Date.now();
        const posKey = p ? `${p.x?.toFixed(1)},${p.y?.toFixed(1)},${p.z?.toFixed(1)}` : 'unknown';
        if (posKey !== _fmLastPos) {
            // Position changed — flush any pending burst summary then log new
            if (_fmBurstCount > 0 && _fmLastPos) {
                console.log(`[SpawnEscape][EVENT] forcedMove burst: ${_fmBurstCount} more corrections at ${_fmLastPos}`);
            }
            console.log(`[SpawnEscape][EVENT] forcedMove — bot teleported by server to ${posStr()}`);
            _fmLastPos = posKey;
            _fmLastLogged = now;
            _fmBurstCount = 0;
        } else {
            // Same position — increment burst, emit summary every 5s
            _fmBurstCount++;
            if (now - _fmLastLogged > 5000) {
                console.log(`[SpawnEscape][EVENT] forcedMove burst: ${_fmBurstCount} corrections in last 5s at ${posKey}`);
                _fmLastLogged = now;
                _fmBurstCount = 0;
            }
        }

        // #28 Mid-session in-zone trigger.
        // Why: escapeProtectedZone only fires on spawn/login. A server teleport
        // (or /tp by an op) that drops the bot back into the protected zone
        // leaves it stranded — destructive actions inside the zone get blocked,
        // and the self-prompter has no signal to escape. Re-fire the escape on
        // any forcedMove that lands inside the zone, with re-entry guards.
        // Defer 500ms so the bot's position has settled and we don't spam
        // during a teleport burst.
        if (!_fmReFireScheduled) {
            _fmReFireScheduled = true;
            setTimeout(() => {
                _fmReFireScheduled = false;
                try {
                    const pp = bot.entity?.position;
                    if (!pp || !Number.isFinite(pp.x) || !Number.isFinite(pp.z)) return;
                    if (bot.health !== undefined && bot.health <= 0) return;
                    if (!_isInSpawnZone(bot, pp.x, pp.z)) return;
                    const holder = botMutex.currentHolder;
                    if (holder === 'escapeProtectedZone' || holder === 'escapeSpawnZone') return;
                    // #28 fix (2026-04-19): combat preemption guard. Zombie
                    // knockback fires `forcedMove`; without this guard, the
                    // re-fire takes the mutex via `withBotLock` and kills an
                    // in-flight defendSelf loop after one swing. Spawn
                    // protection exists to stop *destructive* actions; a
                    // mob actively attacking the bot is neither destructive
                    // nor strands us. Combat wins this tiebreak — the zone
                    // is still there after the fight, and any post-combat
                    // NaN/low-HP state will route through self_preservation.
                    if (holder === 'defendSelf') return;
                    if (bot.pvp && bot.pvp.target) return;
                    const now2 = Date.now();
                    if (now2 - _fmLastReFireMs < 30000) return;  // 30s cooldown
                    _fmLastReFireMs = now2;
                    console.log(`[SpawnEscape] forcedMove landed in protected zone at (${pp.x.toFixed(1)}, ${pp.y.toFixed(1)}, ${pp.z.toFixed(1)}) — re-firing escape`);
                    _impl_escapeProtectedZone(bot).catch((err) => {
                        console.warn(`[SpawnEscape] re-fire failed: ${err && err.message ? err.message : err}`);
                    });
                } catch (err) {
                    console.warn(`[SpawnEscape] re-fire scheduler error: ${err && err.message ? err.message : err}`);
                }
            }, 500);
        }
    });

    bot.on('respawn', () => {
        console.log(`[SpawnEscape][EVENT] respawn (health=${bot.health}, food=${bot.food}) at ${posStr()}`);
        // #22b reset: respawn clears any pending suffocation recovery state.
        _suffocReset('respawn');
        _suffocLastGoodPos = null;
    });

    bot.on('death', () => {
        console.log(`[SpawnEscape][EVENT] death at ${posStr()}`);
    });

    bot.on('health', () => {
        // Only log damage events, not heals
        if (typeof bot._lastHealthLogged !== 'number') bot._lastHealthLogged = bot.health;
        const dropped = bot.health < bot._lastHealthLogged;
        if (dropped) {
            console.log(`[SpawnEscape][EVENT] health drop ${bot._lastHealthLogged.toFixed(1)} → ${bot.health.toFixed(1)} at ${posStr()}`);
        }

        // #22b suffocation detector. The signature: health drop while
        // bot.entity.position is non-finite (NaN window). Damage classifier
        // also loses pos in this state so the source reads as "unknown" —
        // a NaN-position drop is an unambiguous hitbox-in-solids signal.
        if (dropped) {
            const pp = bot.entity?.position;
            const naN = !pp || !Number.isFinite(pp.x) || !Number.isFinite(pp.y) || !Number.isFinite(pp.z);
            if (naN && bot.health > 0) {
                const now = Date.now();
                if (_suffocTickCount === 0) {
                    _suffocFirstTickMs = now;
                    console.log('[SuffocationRecovery] detected — NaN-position health drop (tick 1)');
                }
                _suffocTickCount++;
                const elapsedMs = now - _suffocFirstTickMs;

                // Stage A: ≥3 NaN-drops within 2s, stage A not yet run.
                if (!_suffocStageARan && _suffocTickCount >= 3 && elapsedMs <= 2000) {
                    _suffocStageA();
                }

                // Stage B: stage A ran AND NaN damage persists ≥3s from first tick.
                if (_suffocStageARan && !_suffocStageBRan && elapsedMs >= 3000) {
                    _suffocStageB();
                }
            } else if (!naN && (_suffocTickCount > 0 || _suffocStageARan)) {
                // Position is finite again — either stage A worked or natural recovery.
                console.log('[SuffocationRecovery] recovered — position finite, health stable enough to log');
                _suffocReset('position_finite');
            }
        }

        // Sample last-good pos opportunistically on every health tick (cheap).
        _suffocSamplePos();
        bot._lastHealthLogged = bot.health;
    });

    // Cheap position sampler at physics tick rate — keeps _suffocLastGoodPos
    // fresh without a custom interval. Idempotent via _spawnEscapeInstrumented set.
    bot.on('physicsTick', _suffocSamplePos);

    // Chat-style server messages — filter for teleport/kick/setblock keywords
    bot.on('message', (jsonMsg) => {
        const s = (typeof jsonMsg?.toString === 'function') ? jsonMsg.toString() : String(jsonMsg);
        if (/teleport|tp |kicked|moved wrongly|flying is not enabled|banned/i.test(s)) {
            console.log(`[SpawnEscape][EVENT] server-msg: ${s.slice(0, 200)}`);
        }
    });

    console.log('[SpawnEscape] Instrumentation installed (forcedMove / respawn / death / health / chat listeners; #28 in-zone re-fire enabled; #22b NaN-suffocation recovery enabled)');
}

// -----------------------------------------------------------------------------
// #22 escapeProtectedZone suffocation trap — pre-move passability guard
// -----------------------------------------------------------------------------
// Why: pathfinder.GoalNear(tx, ty, tz, 2) stops the bot within 2 blocks of the
// target, but a target Y that sits inside terrain still causes the chosen path
// to deposit the bot's hitbox in solid material. On 2026-04-19 at 15:35–15:44Z
// we observed 5 lethal unknown-source 2-dmg/tick suffocation sequences during
// escapeProtectedZone recovery — the exact signature described in the #22
// whiteboard ticket. Fix is a minimal pre-move check at the single commit
// point (_escapeTryPath, 4 callers): if the feet+head blocks at the proposed
// target are known-solid, nudge Y within ±3 to find a passable pair; if
// nothing is passable, skip the hop and let the caller's stuck/next-direction
// logic fire.
//
// Unknown (chunk-not-loaded) blocks return null from bot.blockAt; we treat
// that as "defer to pathfinder" — we only REJECT known-solid targets. This
// preserves all currently-working paths through unloaded terrain.
//
// Rule 7 audit: every call to _escapeTryPath now inherits this guard:
//   - cached-exit path     (_impl_escapeSpawnZone)
//   - dir-hop path         (_commitToDirection)
//   - stuck-back path      (_executeStuckManeuver)
//   - stuck-sidestep path  (_executeStuckManeuver)

function _isTargetPassable(bot, x, y, z) {
    try {
        const feet = bot.blockAt(new Vec3(x, y, z));
        const head = bot.blockAt(new Vec3(x, y + 1, z));
        if (!feet || !head) return null;  // chunk not loaded — unknown
        const isAir = (b) => b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
        if (isAir(feet) && isAir(head)) return true;
        return false;
    } catch (_) {
        return null;
    }
}

// Candidate Y offsets tried in order. Capped at ±3 — larger adjustments would
// drag the hop too far off its intended drift-from-center path and defeat the
// escape's directional logic.
const _ESCAPE_Y_OFFSETS = [0, -1, 1, -2, 2, -3, 3];

// Returns adjusted ty, or null if every offset in ±3 is known-solid.
// If the requested ty returns null (unknown), we return it unchanged so the
// pathfinder still attempts the hop — we only REJECT known-solid targets.
function _findPassableY(bot, tx, ty, tz) {
    const first = _isTargetPassable(bot, tx, ty, tz);
    if (first === true || first === null) return ty;
    for (const dy of _ESCAPE_Y_OFFSETS) {
        if (dy === 0) continue;
        if (_isTargetPassable(bot, tx, ty + dy, tz) === true) return ty + dy;
    }
    return null;
}

// Race goToGoal against a hard timeout. Returns when either completes.
// Exceptions are caught and logged; callers should re-check position.
// On timeout, explicitly cancel any in-flight pathfinder goal so that
// subsequent hop attempts start from a clean state (otherwise the
// pathfinder can keep ticking the bot into unstable / NaN positions
// while we try to issue new goals).
//
// #22 guard: before committing the pathfinder goal, verify the target's
// feet+head blocks are passable (or unknown). See _isTargetPassable header.
async function _escapeTryPath(bot, tx, ty, tz, timeoutMs, label) {
    const adjustedY = _findPassableY(bot, tx, ty, tz);
    if (adjustedY === null) {
        console.warn(`[EscapeZone] ${label}: target (${tx}, ${ty}, ${tz}) rejected — feet+head blocks solid at every Y within ±3`);
        return;  // caller re-checks position; stuck/next-direction logic fires
    }
    if (adjustedY !== ty) {
        console.log(`[EscapeZone] ${label}: target Y adjusted ${ty} → ${adjustedY} (original feet/head solid)`);
        ty = adjustedY;
    }

    let timeoutHandle;
    const attempt = goToGoal(bot, new pf.goals.GoalNear(tx, ty, tz, 2));
    const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
            timeoutMs
        );
    });
    try {
        await Promise.race([attempt, timeout]);
    } catch (err) {
        console.warn(`[SpawnEscape] ${label}: ${err.message}`);
        // Cancel any pathfinder goal that may still be running so the
        // bot settles before the next attempt reads position.
        try { bot.pathfinder.setGoal(null); } catch (_) { /* ignore */ }
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function _impl_escapeSpawnZone(bot) {
    return await withBotLock('escapeSpawnZone', async () => {
        _installSpawnEscapeInstrumentation(bot);
        const spawn = bot.spawnPoint;
        if (!spawn) {
            console.log('[SpawnEscape] No spawnPoint data yet — skipping escape');
            return false;
        }

        // Helper: read current bot position with NaN guard
        const readPos = () => {
            const p = bot.entity?.position;
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
            const dx = p.x - spawn.x;
            const dz = p.z - spawn.z;
            return { x: p.x, y: p.y, z: p.z, dist: Math.sqrt(dx * dx + dz * dz) };
        };
        const isOutside = () => {
            const p = readPos();
            return p !== null && p.dist > SPAWN_PROTECTION_RADIUS;
        };

        // Already outside — nothing to do
        if (isOutside()) return true;

        const prevMovements = bot.pathfinder.movements;
        try {
            // ---------- Step 1: try cached exit from memory ----------
            const cached = _findCachedExit(bot, spawn);
            if (cached) {
                console.log(`[SpawnEscape] Found cached exit at (${cached.exitX}, ${cached.exitY}, ${cached.exitZ}) for spawn (~${Math.floor(spawn.x)}, ~${Math.floor(spawn.z)}) — trying direct path first`);
                log(bot, `Remembered a good exit at (${cached.exitX}, ${cached.exitZ}) — heading there.`);
                await _escapeTryPath(bot, cached.exitX, cached.exitY, cached.exitZ, ESCAPE_CACHED_EXIT_TIMEOUT_MS, 'cached-exit');
                if (isOutside()) {
                    const p = readPos();
                    console.log(`[SpawnEscape] Cached exit worked — at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}), ${p.dist.toFixed(1)} blocks from spawn`);
                    _recordEscapeExit(bot, spawn, p);
                    return true;
                }
                console.log(`[SpawnEscape] Cached exit didn't work — falling through to directional commit`);
            }

            // ---------- Step 2: pick 8 directions sorted by drift ----------
            const startPos = readPos();
            if (!startPos) {
                console.warn('[SpawnEscape] No bot position — aborting escape');
                return false;
            }
            const driftDx = startPos.x - spawn.x;
            const driftDz = startPos.z - spawn.z;
            const directions = _rank8DirectionsByDrift(driftDx, driftDz);
            console.log(`[SpawnEscape] Direction order by drift proximity: ${directions.map(d => d.label).join(', ')}`);

            // ---------- Step 3: commit to each direction in order ----------
            for (const dir of directions) {
                if (isOutside()) break;  // a prior attempt got us out unexpectedly

                const committed = await _commitToDirection(bot, spawn, dir, readPos, isOutside);
                if (committed === 'escaped') {
                    const p = readPos();
                    console.log(`[SpawnEscape] Arrived at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) — ${p.dist.toFixed(1)} blocks from spawn via ${dir.label}`);
                    log(bot, `Cleared the spawn zone. I'm now ${Math.floor(p.dist)} blocks from spawn.`);
                    _recordEscapeExit(bot, spawn, p);
                    return true;
                }
                // committed === 'stuck' — try next direction
            }

            // All 8 directions exhausted
            const endP = readPos();
            if (endP && endP.dist > SPAWN_PROTECTION_RADIUS) {
                // Raced across the boundary at the very end
                _recordEscapeExit(bot, spawn, endP);
                return true;
            }
            console.warn(`[SpawnEscape] All 8 directions exhausted. Final distance: ${endP ? endP.dist.toFixed(1) : '?'} blocks from spawn.`);
            log(bot, `I tried all 8 directions but couldn't escape the spawn zone. Continuing from inside.`);
            return false;
        } finally {
            if (prevMovements) {
                try { bot.pathfinder.setMovements(prevMovements); } catch (_) { /* ignore */ }
            }
        }
    });
}
export const escapeSpawnZone = wrapSkill('escapeSpawnZone', _impl_escapeSpawnZone);

/**
 * Escape ANY protected zone — spawn, village, or manual structure.
 *
 * Phase 1: if inside spawn zone, delegate to escapeSpawnZone (specialized,
 * uses cached exits and directional-commit with spawn-distance checks).
 *
 * Phase 2: after spawn escape (or if not in spawn), check
 * _isInAnyProtectedZone at current position. If still inside a
 * village/structure zone, walk away from THAT zone's center using the
 * same directional-hop mechanics. Repeat until clear of all zones or
 * MAX_ZONE_ESCAPES attempts exhausted (prevents infinite loops if zones
 * overlap pathologically).
 *
 * Returns true if bot is outside all protected zones, false otherwise.
 */
const MAX_ZONE_ESCAPES = 5;  // cap on sequential zone escapes (village -> village -> ...)
// Buffer: bot walks 50% past the zone edge (e.g., radius 100 -> target 150)

async function _impl_escapeProtectedZone(bot) {
    return await withBotLock('escapeProtectedZone', async () => {
        _installSpawnEscapeInstrumentation(bot);

        // Helper: current position with NaN guard
        const readPos = () => {
            const p = bot.entity?.position;
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
            return { x: p.x, y: p.y, z: p.z };
        };

        // Helper: check if bot is outside ALL protected zones
        const isClear = () => {
            const p = readPos();
            if (!p) return false;
            return _isInAnyProtectedZone(bot, p.x, p.y, p.z) === null;
        };

        // Already clear — nothing to do
        if (isClear()) return true;

        // Phase 1: spawn zone escape (if applicable)
        const pos0 = readPos();
        if (pos0 && _isInSpawnZone(bot, pos0.x, pos0.z)) {
            console.log('[ProtectedZoneEscape] Inside spawn zone — delegating to escapeSpawnZone');
            await escapeSpawnZone(bot);
            if (isClear()) return true;
            console.log('[ProtectedZoneEscape] Still inside a protected zone after spawn escape — entering phase 2');
        }

        // Phase 2: escape non-spawn zones (village, manual structure)
        const prevMovements = bot.pathfinder.movements;
        try {
            for (let attempt = 0; attempt < MAX_ZONE_ESCAPES; attempt++) {
                if (isClear()) return true;

                const pos = readPos();
                if (!pos) {
                    console.warn('[ProtectedZoneEscape] No bot position — aborting');
                    return false;
                }

                const zone = _isInAnyProtectedZone(bot, pos.x, pos.y, pos.z);
                if (!zone) return true;  // clear

                // For spawn zone that we somehow didn't escape in phase 1, use
                // spawn center. For others, use the zone's center coordinates.
                let centerX, centerZ, targetDist;
                if (zone.type === 'spawn') {
                    const spawn = bot.spawnPoint;
                    centerX = spawn.x;
                    centerZ = spawn.z;
                    targetDist = SPAWN_ESCAPE_DISTANCE;
                } else {
                    centerX = zone.x !== undefined ? zone.x : pos.x;
                    centerZ = zone.z !== undefined ? zone.z : pos.z;
                    targetDist = Math.ceil((zone.radius || 100) * 1.5);
                }

                const driftDx = pos.x - centerX;
                const driftDz = pos.z - centerZ;
                const currentDist = Math.sqrt(driftDx * driftDx + driftDz * driftDz);

                console.log(`[ProtectedZoneEscape] Inside ${zone.type} zone${zone.name ? ' "' + zone.name + '"' : ''} (center ${Math.floor(centerX)},${Math.floor(centerZ)} radius ${zone.radius || '?'}). Bot is ${currentDist.toFixed(0)} blocks from center, need ${targetDist}. Attempt ${attempt + 1}/${MAX_ZONE_ESCAPES}`);

                // Rank directions away from this zone's center
                const directions = _rank8DirectionsByDrift(driftDx, driftDz);

                // isOutside check for _commitToDirection: distance from THIS zone's center
                const isOutsideZone = () => {
                    const p = readPos();
                    if (!p) return false;
                    const dx = p.x - centerX;
                    const dz = p.z - centerZ;
                    return Math.sqrt(dx * dx + dz * dz) > targetDist;
                };

                // readPos variant that includes dist from zone center (for _commitToDirection logging)
                const readPosFromZone = () => {
                    const p = readPos();
                    if (!p) return null;
                    const dx = p.x - centerX;
                    const dz = p.z - centerZ;
                    return { ...p, dist: Math.sqrt(dx * dx + dz * dz) };
                };

                // Build a fake "spawn" object for _commitToDirection's stuck maneuver
                // (it uses spawn coords to ensure sidesteps don't decrease distance)
                const fakeSpawn = { x: centerX, z: centerZ };

                let escaped = false;
                for (const dir of directions) {
                    if (isOutsideZone()) { escaped = true; break; }
                    const result = await _commitToDirection(bot, fakeSpawn, dir, readPosFromZone, isOutsideZone);
                    if (result === 'escaped') { escaped = true; break; }
                }

                if (escaped) {
                    const p = readPos();
                    const zoneName = zone.name || zone.type;
                    console.log(`[ProtectedZoneEscape] Escaped ${zoneName} — now at (${Math.floor(p.x)}, ${Math.floor(p.z)})`);
                    log(bot, `Moved out of protected zone "${zoneName}".`);
                    // Loop continues — re-check in case we landed in another zone
                    continue;
                }

                // All 8 directions exhausted for this zone
                console.warn(`[ProtectedZoneEscape] Could not escape ${zone.name || zone.type} after all 8 directions`);
                log(bot, `Tried to leave protected zone "${zone.name || zone.type}" but couldn't find a path out.`);
                return false;
            }

            // Fell out of the loop — either clear or max attempts
            return isClear();
        } finally {
            if (prevMovements) {
                try { bot.pathfinder.setMovements(prevMovements); } catch (_) { /* ignore */ }
            }
        }
    });
}
export const escapeProtectedZone = wrapSkill('escapeProtectedZone', _impl_escapeProtectedZone);

/**
 * Commit to one direction: walk in 40-block hops, do stuck maneuvers on
 * low-progress hops, give up on this direction after MAX_STUCKS stucks.
 * Returns 'escaped' if the bot crosses the protection boundary, 'stuck'
 * if the direction is exhausted.
 */
async function _commitToDirection(bot, spawn, dir, readPos, isOutside) {
    const u = dir._unit;  // normalized unit vector for the direction
    let stuckCount = 0;
    let sidestepSide = 'left';  // alternates
    let hopNum = 0;

    let nanWaits = 0;
    while (stuckCount < ESCAPE_MAX_STUCKS_PER_DIRECTION) {
        if (isOutside()) return 'escaped';

        let pos = readPos();
        if (!pos) {
            // Bot position transiently NaN (chunk sync, pathfinder tick race).
            // Wait up to 3 seconds for it to resolve; if still null, bail this
            // direction — it's not the pathfinder's fault, something's wrong
            // with the bot's state.
            nanWaits++;
            if (nanWaits > 3) {
                console.warn(`[SpawnEscape] ${dir.label}: position still unavailable after ${nanWaits}s — skipping direction`);
                return 'stuck';
            }
            console.warn(`[SpawnEscape] ${dir.label}: position unavailable, waiting 1s (${nanWaits}/3)`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        nanWaits = 0;  // got a valid position, reset the counter

        hopNum++;
        // Next waypoint: 40 blocks further in primary direction
        const tx = Math.floor(pos.x + u.dx * ESCAPE_HOP_DISTANCE);
        const tz = Math.floor(pos.z + u.dz * ESCAPE_HOP_DISTANCE);
        const ty = Math.floor(pos.y);
        const startDist = pos.dist;
        const startX = pos.x, startY = pos.y, startZ = pos.z;

        console.log(`[SpawnEscape] ${dir.label} hop ${hopNum}: at (${Math.floor(pos.x)}, ${Math.floor(pos.z)}) [${startDist.toFixed(1)} from spawn] → (${tx}, ${tz})`);
        await _escapeTryPath(bot, tx, ty, tz, ESCAPE_HOP_TIMEOUT_MS, `${dir.label} hop ${hopNum}`);

        if (isOutside()) return 'escaped';

        const newPos = readPos();
        const progress = newPos ? (newPos.dist - startDist) : 0;

        // Suspect-teleport detection: if the raw physical distance from
        // start-of-hop to end-of-hop exceeds a threshold, the bot didn't
        // walk there — something teleported it. We can't realistically
        // walk >60 blocks in a 45-second hop given hop distance is 40.
        if (newPos) {
            const dx = newPos.x - startX;
            const dy = newPos.y - startY;
            const dz = newPos.z - startZ;
            const travelled = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (travelled > 60) {
                console.warn(`[SpawnEscape][SUSPECT-TELEPORT] ${dir.label} hop ${hopNum}: raw travel = ${travelled.toFixed(1)} blocks from (${startX.toFixed(1)}, ${startY.toFixed(1)}, ${startZ.toFixed(1)}) to (${newPos.x.toFixed(1)}, ${newPos.y.toFixed(1)}, ${newPos.z.toFixed(1)}) — bot cannot walk this far in ${ESCAPE_HOP_TIMEOUT_MS / 1000}s`);
            }
        }

        console.log(`[SpawnEscape] ${dir.label} hop ${hopNum} progress: ${progress.toFixed(1)} blocks`);

        if (progress >= ESCAPE_PROGRESS_THRESHOLD) {
            // Good — reset stuck counter and loop (next hop from new position)
            stuckCount = 0;
            continue;
        }

        // Stuck — execute stuck maneuver (back + sidestep)
        stuckCount++;
        console.log(`[SpawnEscape] ${dir.label} stuck ${stuckCount}/${ESCAPE_MAX_STUCKS_PER_DIRECTION} — running stuck maneuver (back + ${sidestepSide})`);
        await _executeStuckManeuver(bot, spawn, u, sidestepSide, readPos);
        sidestepSide = sidestepSide === 'left' ? 'right' : 'left';

        // Also try auto-breaking a nearby plant while we're at it
        try {
            await autoBreakStuckPlant(bot);
        } catch (_) { /* best effort */ }
    }

    console.warn(`[SpawnEscape] ${dir.label} exhausted (${ESCAPE_MAX_STUCKS_PER_DIRECTION} stucks). Trying next direction.`);
    return 'stuck';
}

/**
 * Execute the stuck maneuver: back up ESCAPE_BACK_BLOCKS, then sidestep
 * ESCAPE_SIDE_BLOCKS perpendicular (left or right per sidestepSide).
 *
 * Rules (per JP 2026-04-15):
 *   - Back step is unconditional (small regression OK to unstick).
 *   - Sidestep direction must not decrease distance-from-spawn further
 *     than the back step already did. If the preferred side would violate
 *     this, try the opposite side. If both violate, skip the sidestep.
 */
async function _executeStuckManeuver(bot, spawn, unit, preferredSide, readPos) {
    const pos = readPos();
    if (!pos) return;

    // Back step: reverse of committed direction
    const backX = Math.floor(pos.x - unit.dx * ESCAPE_BACK_BLOCKS);
    const backZ = Math.floor(pos.z - unit.dz * ESCAPE_BACK_BLOCKS);
    const backY = Math.floor(pos.y);
    console.log(`[SpawnEscape] Stuck maneuver: back ${ESCAPE_BACK_BLOCKS} blocks to (${backX}, ${backZ})`);
    await _escapeTryPath(bot, backX, backY, backZ, ESCAPE_STUCK_MANEUVER_TIMEOUT_MS, 'stuck-back');

    // Sidestep: 15 blocks perpendicular to primary direction
    // Left perpendicular (when facing primary): (unit.dz, -unit.dx)
    // Right perpendicular: (-unit.dz, unit.dx)
    const leftPerp = { dx: unit.dz, dz: -unit.dx };
    const rightPerp = { dx: -unit.dz, dz: unit.dx };
    const primary = preferredSide === 'left' ? leftPerp : rightPerp;
    const fallback = preferredSide === 'left' ? rightPerp : leftPerp;

    const afterBack = readPos();
    if (!afterBack) return;

    // Test preferred side: would the landing position be further from spawn
    // than the current (post-back) position? If yes, OK to sidestep.
    const testSide = (perp) => {
        const nx = afterBack.x + perp.dx * ESCAPE_SIDE_BLOCKS;
        const nz = afterBack.z + perp.dz * ESCAPE_SIDE_BLOCKS;
        const ndx = nx - spawn.x;
        const ndz = nz - spawn.z;
        const newDist = Math.sqrt(ndx * ndx + ndz * ndz);
        return { ok: newDist >= afterBack.dist, x: nx, z: nz };
    };

    let chosen = testSide(primary);
    let chosenLabel = preferredSide;
    if (!chosen.ok) {
        const alt = testSide(fallback);
        if (alt.ok) {
            chosen = alt;
            chosenLabel = preferredSide === 'left' ? 'right' : 'left';
            console.log(`[SpawnEscape] Stuck maneuver: preferred side ${preferredSide} would decrease distance — switching to ${chosenLabel}`);
        } else {
            console.log(`[SpawnEscape] Stuck maneuver: both sides would decrease distance — skipping sidestep`);
            return;
        }
    }

    console.log(`[SpawnEscape] Stuck maneuver: sidestep ${chosenLabel} ${ESCAPE_SIDE_BLOCKS} blocks to (${Math.floor(chosen.x)}, ${Math.floor(chosen.z)})`);
    await _escapeTryPath(bot, Math.floor(chosen.x), Math.floor(afterBack.y), Math.floor(chosen.z), ESCAPE_STUCK_MANEUVER_TIMEOUT_MS, `stuck-side-${chosenLabel}`);
}

/**
 * Scan for nearby open caverns/caves below the bot's current position.
 * Checks a grid pattern below and around the bot for clusters of air/cave_air blocks.
 * Returns the position of the nearest cavern entrance, or null if none found.
 * @param {MinecraftBot} bot
 * @param {number} radius - horizontal scan radius (default 16)
 * @param {number} depthBelow - how many blocks below to scan (default 30)
 * @returns {{ pos: Vec3, distance: number, airCount: number }|null}
 */
// OPT-E: hoisted to module scope — avoid re-allocating the Set every time a
// cavern-candidate passes the earlier gates in scanForCaverns. Contents are
// static (MC block-name list of rock-type walls). Same shape as OPT-D's
// DANGEROUS_BLOCK_NAMES hoist.
const CAVERN_ROCK_TYPES = new Set([
    'stone', 'deepslate', 'granite', 'diorite', 'andesite',
    'tuff', 'calcite', 'dripstone_block', 'cobblestone',
    'cobbled_deepslate', 'basalt', 'blackstone', 'netherrack',
    'sandstone', 'red_sandstone', 'smooth_basalt',
]);

export function scanForCaverns(bot, radius = 100, depthBelow = 30) {
    const pos = bot.entity.position.floored();
    const startY = pos.y;
    const minY = Math.max(startY - depthBelow, -64); // don't scan below world floor
    let bestCavern = null;

    // Scan in a grid pattern: every 2 blocks horizontally, every 1 block vertically
    for (let dx = -radius; dx <= radius; dx += 2) {
        for (let dz = -radius; dz <= radius; dz += 2) {
            for (let y = startY - 3; y >= minY; y--) {
                const checkPos = pos.offset(dx, y - startY, dz);
                const block = bot.blockAt(checkPos);

                if (!block) continue;
                if (block.name !== 'air' && block.name !== 'cave_air') continue;

                // Found an air block underground — check if it's a real cavern
                // (not just a 1-block gap). Count connected air blocks.
                let airCount = 0;
                for (let ax = -1; ax <= 1; ax++) {
                    for (let az = -1; az <= 1; az++) {
                        for (let ay = 0; ay <= 2; ay++) {
                            const neighbor = bot.blockAt(checkPos.offset(ax, ay, az));
                            if (neighbor && (neighbor.name === 'air' || neighbor.name === 'cave_air')) {
                                airCount++;
                            }
                        }
                    }
                }

                // Need at least 6 air blocks to be a real cavern (roughly 2x3 space)
                if (airCount < 6) continue;

                // Check that there's a solid floor (not floating in a ravine)
                const floor = bot.blockAt(checkPos.offset(0, -1, 0));
                if (!floor || floor.name === 'air' || floor.name === 'cave_air'
                    || floor.name === 'lava' || floor.name === 'water') continue;

                // Verify there's a solid ceiling above (not open sky)
                let hasCeiling = false;
                for (let cy = 1; cy <= 10; cy++) {
                    const above = bot.blockAt(checkPos.offset(0, cy, 0));
                    if (above && above.name !== 'air' && above.name !== 'cave_air') {
                        hasCeiling = true;
                        break;
                    }
                }
                if (!hasCeiling) continue;

                // Verify walls are rock-type (not dirt/grass surface depressions).
                // OPT-E: CAVERN_ROCK_TYPES is a module-level Set — no per-call alloc.
                let rockWalls = 0;
                const wallChecks = [
                    checkPos.offset(1, 0, 0), checkPos.offset(-1, 0, 0),
                    checkPos.offset(0, 0, 1), checkPos.offset(0, 0, -1),
                ];
                for (const wc of wallChecks) {
                    const wb = bot.blockAt(wc);
                    if (wb && CAVERN_ROCK_TYPES.has(wb.name)) rockWalls++;
                }
                if (rockWalls < 1) continue; // at least 1 rock wall

                const dist = Math.sqrt(dx * dx + (y - startY) ** 2 + dz * dz);
                if (!bestCavern || dist < bestCavern.distance) {
                    bestCavern = {
                        pos: new Vec3(pos.x + dx, y, pos.z + dz),
                        distance: dist,
                        airCount,
                    };
                }
            }
        }
    }

    if (bestCavern) {
        console.log(`[CavernScan] Found cavern at ${bestCavern.pos} (${bestCavern.airCount} air blocks, ${bestCavern.distance.toFixed(1)} blocks away)`);
    } else {
        console.log('[CavernScan] No caverns found nearby');
    }
    return bestCavern;
}

/**
 * OPT-F: shared yaw-to-cardinal snapping. Previously duplicated inline in
 * _impl_digDown and _impl_digUp. Minecraft yaw: 0 = south (+Z), pi/2 = west (-X),
 * pi = north (-Z), 3pi/2 = east (+X). Snap to the nearest cardinal at pi/4 bounds.
 * @param {number} yaw - bot.entity.yaw
 * @returns {{dx: number, dz: number, name: 'south'|'west'|'north'|'east'}}
 */
function _yawToCardinal(yaw) {
    const normalized = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    if (normalized >= 5.5 || normalized < 0.785) return { dx: 0, dz: 1, name: 'south' };
    if (normalized < 2.356) return { dx: -1, dz: 0, name: 'west' };
    if (normalized < 3.927) return { dx: 0, dz: -1, name: 'north' };
    return { dx: 1, dz: 0, name: 'east' };
}

async function _impl_digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance using a safe staircase pattern.
     * Digs in the direction the bot is facing, creating a 1-wide, 3-high descending staircase.
     * Will stop if it reaches lava, water, or the end of the world.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, the number of blocks to descend.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/
    return await withBotLock('digDown', async () => {
    // Guard: bot.entity.position is sometimes (NaN, Y, NaN) during chunk-load or
    // respawn windows — observed 2026-04-15 in live play. The cavern-scan and
    // staircase loop below propagate NaN into blockAt lookups, waitForChunksToLoad
    // spins, and the skill silently aborts with confusing logs.
    //
    // Delegate user-facing messaging to ChunkWait (whiteboard #22). Calling
    // chunk_wait.enter() sets the held state so agent.js gates further LLM
    // calls and recordOutcome writes — this fixes the #16.1 false-positive
    // class at source (guard messages were evading the keyword list and
    // polluting procedural memory as successes). The silent bail keeps the
    // Rule 5 defense against propagating NaN into the rest of this skill.
    if (!bot.entity?.position || !isFinite(bot.entity.position.x) || !isFinite(bot.entity.position.z)) {
        console.warn('[Skills] digDown: bot.entity.position not finite, aborting');
        bot.agent?.chunk_wait?.enter('digDown: bot.entity.position NaN');
        return false;
    }
    const prevMovements = bot.pathfinder.movements;
    try {

    // --- Cavern detection: look for existing caves before digging blindly ---
    // Short-circuit ONLY if a NON-DESTRUCTIVE walk-in path exists. If reaching
    // the cavern requires digging, fall through to the 45-degree staircase
    // instead of letting pathfinder dig a straight-down vertical shaft.
    try {
        const cavern = scanForCaverns(bot, 100, 30);
        if (cavern && cavern.distance < distance * 2) {
            const goal = new pf.goals.GoalNear(cavern.pos.x, cavern.pos.y, cavern.pos.z, 2);
            const nonDestructiveMovements = createMovements(bot);
            nonDestructiveMovements.canDig = false;  // hard-require walk-in path

            let walkInPathFound = false;
            try {
                const result = await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, 4000);
                walkInPathFound = result.status === 'success';
            } catch (_) { /* pathfinder failed — treat as no walk-in path */ }

            if (walkInPathFound) {
                console.log(`[digDown] Found cavern at ${cavern.pos} with walk-in path — heading there`);
                log(bot, `Found an open cavern nearby at ${cavern.pos.x}, ${cavern.pos.y}, ${cavern.pos.z} with a walk-in path! Heading there instead of digging.`);
                try {
                    await goToGoal(bot, goal);
                    return true;
                } catch (pathErr) {
                    console.warn(`[digDown] Walk-in path failed mid-journey at ${cavern.pos}, falling back to staircase:`, pathErr.message);
                    log(bot, `Walk-in path to cavern got interrupted — digging a staircase instead.`);
                }
            } else {
                console.log(`[digDown] Cavern at ${cavern.pos} exists but requires digging to reach — using 45-degree staircase instead`);
                log(bot, `Nearby cavern at ${cavern.pos.x}, ${cavern.pos.y}, ${cavern.pos.z} but no walk-in path. Digging a staircase toward it.`);
            }
        }
    } catch (e) {
        console.warn('[digDown] Cavern scan failed, digging normally:', e.message);
    }

    // OPT-F: yaw-to-cardinal via shared helper.
    const { dx, dz, name: dirName } = _yawToCardinal(bot.entity.yaw);

    let currentPos = bot.entity.position.floored();
    let descended = 0;
    console.log(`[Skills] digDown: starting at ${currentPos}, heading ${dirName}, distance=${distance}`);

    for (let i = 0; i < distance; i++) {
        // Next position: one block forward and one block down
        const nextX = currentPos.x + dx;
        const nextY = currentPos.y - 1;
        const nextZ = currentPos.z + dz;

        console.log(`[Skills] digDown: step ${i+1}/${distance} -> (${nextX}, ${nextY}, ${nextZ})`);
        // Check the three blocks we need to clear (feet, head, ceiling at next position)
        const feetBlock = bot.blockAt(new Vec3(nextX, nextY, nextZ));
        const headBlock = bot.blockAt(new Vec3(nextX, nextY + 1, nextZ));
        const ceilBlock = bot.blockAt(new Vec3(nextX, nextY + 2, nextZ));
        // Also check what's below our feet destination (the block we'll stand on)
        const floorBlock = bot.blockAt(new Vec3(nextX, nextY - 1, nextZ));

        // Wait for chunks if needed
        if (!feetBlock || !headBlock || !ceilBlock) {
            console.log(`[Skills] digDown: waiting for chunks at (${nextX}, ${nextY}, ${nextZ}) — feet:${!!feetBlock} head:${!!headBlock} ceil:${!!ceilBlock}`);
            await bot.waitForChunksToLoad();
            const feetRetry = bot.blockAt(new Vec3(nextX, nextY, nextZ));
            const headRetry = bot.blockAt(new Vec3(nextX, nextY + 1, nextZ));
            const ceilRetry = bot.blockAt(new Vec3(nextX, nextY + 2, nextZ));
            if (!feetRetry || !headRetry || !ceilRetry) {
                log(bot, `Dug down ${descended} blocks, but chunks not loaded ahead.`);
                return descended > 0;
            }
        }

        // Re-fetch after potential wait
        const feet = bot.blockAt(new Vec3(nextX, nextY, nextZ));
        const head = bot.blockAt(new Vec3(nextX, nextY + 1, nextZ));
        const ceil = bot.blockAt(new Vec3(nextX, nextY + 2, nextZ));
        const floor = bot.blockAt(new Vec3(nextX, nextY - 1, nextZ));

        console.log(`[Skills] digDown: blocks — ceil:${ceil?.name||'null'} head:${head?.name||'null'} feet:${feet?.name||'null'} floor:${floor?.name||'null'}`);
        // Safety check: lava or water ahead
        const dangerous = ['lava', 'water'];
        if (feet && dangerous.includes(feet.name)) {
            log(bot, `Dug down ${descended} blocks, but reached ${feet.name} ahead.`);
            return false;
        }
        if (ceil && dangerous.includes(ceil.name)) {
            log(bot, `Dug down ${descended} blocks, but ${ceil.name} above the next step.`);
            return false;
        }
        if (floor && dangerous.includes(floor.name)) {
            log(bot, `Dug down ${descended} blocks, but ${floor.name} below the next step.`);
            return false;
        }

        // Safety check: big drop below the next step (cave/void)
        if (floor && (floor.name === 'air' || floor.name === 'cave_air')) {
            // Check how deep the fall is
            let fallDepth = 0;
            for (let j = 1; j <= 3; j++) {
                const checkBlock = bot.blockAt(new Vec3(nextX, nextY - 1 - j, nextZ));
                if (!checkBlock || (checkBlock.name !== 'air' && checkBlock.name !== 'cave_air')) break;
                fallDepth++;
            }
            if (fallDepth >= 3) {
                log(bot, `Dug down ${descended} blocks, but there's a dangerous drop ahead.`);
                return false;
            }
        }

        // Dig ceiling block (top of 3-high tunnel) if solid
        if (ceil && ceil.name !== 'air' && ceil.name !== 'cave_air') {
            let dug = await breakBlockAt(bot, nextX, nextY + 2, nextZ);
            if (!dug) {
                log(bot, `Failed to break block at staircase ceiling level.`);
                return false;
            }
        }

        // Dig the head block if solid
        if (head && head.name !== 'air' && head.name !== 'cave_air') {
            let dug = await breakBlockAt(bot, nextX, nextY + 1, nextZ);
            if (!dug) {
                log(bot, `Failed to break block at staircase head level.`);
                return false;
            }
        }

        // Dig the feet block if solid
        if (feet && feet.name !== 'air' && feet.name !== 'cave_air') {
            let dug = await breakBlockAt(bot, nextX, nextY, nextZ);
            if (!dug) {
                log(bot, `Failed to break block at staircase feet level.`);
                return false;
            }
        }

        // Move to the new position
        console.log(`[Skills] digDown: moving to (${nextX}, ${nextY}, ${nextZ})`);
        try {
            await goToPosition(bot, nextX + 0.5, nextY, nextZ + 0.5, 0);
        } catch (e) {
            console.log(`[Skills] digDown: pathfinder failed, using simple move — ${e.message}`);
            // Pathfinder can struggle with tight 1-wide stairs, try simple move
            bot.setControlState('forward', true);
            await new Promise(resolve => setTimeout(resolve, 400));
            bot.setControlState('forward', false);
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        currentPos = new Vec3(nextX, nextY, nextZ);
        descended++;

        // Every 4 descended blocks, drop a torch behind the bot as a breadcrumb.
        // Target: corridor-air at head level of the step we JUST came from.
        // Support: previous step's floor block (solid). face='bottom' means
        // torch stands on top of that floor. goToSurface follows these torches
        // back up in reverse order.
        // #6: strict left-wall placement via placeBreadcrumbTorch. We pass
        // the dig heading (dx, dz) as a fallback so the helper works even
        // before the modes.js motion cache has primed (digDown can outrun
        // the 1-Hz tick). Helper falls back to the legacy behind-bot floor
        // torch when no left wall is available.
        // Threshold was 8 originally; lowered to 4 after observed typical
        // digDown(5) never triggered a placement.
        if (descended > 0 && descended % 4 === 0) {
            try {
                await placeBreadcrumbTorch(bot, dx, dz);
            } catch (torchErr) {
                console.warn(`[digDown] Breadcrumb torch placement failed: ${torchErr.message}`);
            }
        }
    }

    log(bot, `Dug a staircase down ${descended} blocks.`);
    return true;

    } finally {
        if (prevMovements) {
            try { bot.pathfinder.setMovements(prevMovements); } catch (_) { /* ignore */ }
        }
    }
    });
}

export const digDown = wrapSkill('digDown', _impl_digDown);


async function _impl_digUp(bot, distance = 10) {
    /**
     * Digs up a specified distance using a safe staircase pattern.
     * Digs in the direction the bot is facing, creating a 1-wide ascending staircase.
     * Will stop if it reaches lava, water, bedrock, or the surface.
     * Places floor blocks under the bot when ascending over air gaps.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, the number of blocks to ascend.
     * @returns {Promise<boolean>} true if successfully dug all the way up.
     * @example
     * await skills.digUp(bot, 12);
     **/

    // Guard: bot.entity.position can be (NaN, Y, NaN) during chunk-load or respawn
    // windows (same class as the digDown guard). Delegate user-facing
    // messaging to ChunkWait (whiteboard #22); silent bail here prevents NaN
    // from propagating into the staircase loop (Rule 5 defense-in-depth).
    if (!bot.entity?.position || !isFinite(bot.entity.position.x) || !isFinite(bot.entity.position.z)) {
        console.warn('[Skills] digUp: bot.entity.position not finite, aborting');
        bot.agent?.chunk_wait?.enter('digUp: bot.entity.position NaN');
        return false;
    }

    // OPT-F: yaw-to-cardinal via shared helper.
    const { dx, dz, name: dirName } = _yawToCardinal(bot.entity.yaw);

    let currentPos = bot.entity.position.floored();
    let ascended = 0;
    console.log(`[Skills] digUp: starting at ${currentPos}, heading ${dirName}, distance=${distance}`);

    for (let i = 0; i < distance; i++) {
        // Next position: one block forward and one block up
        const nextX = currentPos.x + dx;
        const nextY = currentPos.y + 1;
        const nextZ = currentPos.z + dz;

        console.log(`[Skills] digUp: step ${i+1}/${distance} -> (${nextX}, ${nextY}, ${nextZ})`);

        // Check the blocks we need to clear and stand on
        const feetBlock = bot.blockAt(new Vec3(nextX, nextY, nextZ));
        const headBlock = bot.blockAt(new Vec3(nextX, nextY + 1, nextZ));
        const ceilBlock = bot.blockAt(new Vec3(nextX, nextY + 2, nextZ));
        const floorBlock = bot.blockAt(new Vec3(nextX, nextY - 1, nextZ));

        // Wait for chunks if needed
        if (!feetBlock || !headBlock || !ceilBlock) {
            console.log(`[Skills] digUp: waiting for chunks at (${nextX}, ${nextY}, ${nextZ})`);
            await bot.waitForChunksToLoad();
            const feetRetry = bot.blockAt(new Vec3(nextX, nextY, nextZ));
            const headRetry = bot.blockAt(new Vec3(nextX, nextY + 1, nextZ));
            if (!feetRetry || !headRetry) {
                log(bot, `Dug up ${ascended} blocks, but chunks not loaded ahead.`);
                return ascended > 0;
            }
        }

        // Re-fetch after potential wait
        const feet = bot.blockAt(new Vec3(nextX, nextY, nextZ));
        const head = bot.blockAt(new Vec3(nextX, nextY + 1, nextZ));
        const ceil = bot.blockAt(new Vec3(nextX, nextY + 2, nextZ));
        const floor = bot.blockAt(new Vec3(nextX, nextY - 1, nextZ));

        console.log(`[Skills] digUp: blocks — ceil:${ceil?.name||'null'} head:${head?.name||'null'} feet:${feet?.name||'null'} floor:${floor?.name||'null'}`);

        // Safety: lava or water
        const dangerous = ['lava', 'water'];
        if (feet && dangerous.includes(feet.name)) {
            log(bot, `Dug up ${ascended} blocks, but reached ${feet.name} ahead.`);
            return false;
        }
        if (head && dangerous.includes(head.name)) {
            log(bot, `Dug up ${ascended} blocks, but ${head.name} above the next step.`);
            return false;
        }
        if (ceil && dangerous.includes(ceil.name)) {
            log(bot, `Dug up ${ascended} blocks, but ${ceil.name} at ceiling level.`);
            return false;
        }

        // Safety: bedrock can't be broken
        if (feet && feet.name === 'bedrock') {
            log(bot, `Dug up ${ascended} blocks, but hit bedrock.`);
            return false;
        }
        if (head && head.name === 'bedrock') {
            log(bot, `Dug up ${ascended} blocks, but bedrock above.`);
            return false;
        }
        if (ceil && ceil.name === 'bedrock') {
            log(bot, `Dug up ${ascended} blocks, but bedrock at ceiling.`);
            return false;
        }

        // Check if we've reached the surface (sky above)
        let skyAbove = true;
        for (let checkY = nextY + 2; checkY <= nextY + 10; checkY++) {
            const checkBlock = bot.blockAt(new Vec3(nextX, checkY, nextZ));
            if (checkBlock && checkBlock.name !== 'air' && checkBlock.name !== 'cave_air') {
                skyAbove = false;
                break;
            }
        }

        // Dig ceiling block if solid
        if (ceil && ceil.name !== 'air' && ceil.name !== 'cave_air') {
            let dug = await breakBlockAt(bot, nextX, nextY + 2, nextZ);
            if (!dug) {
                log(bot, `Failed to break block at staircase ceiling level.`);
                return false;
            }
        }

        // Dig head block if solid
        if (head && head.name !== 'air' && head.name !== 'cave_air') {
            let dug = await breakBlockAt(bot, nextX, nextY + 1, nextZ);
            if (!dug) {
                log(bot, `Failed to break block at staircase head level.`);
                return false;
            }
        }

        // Dig feet block if solid
        if (feet && feet.name !== 'air' && feet.name !== 'cave_air') {
            let dug = await breakBlockAt(bot, nextX, nextY, nextZ);
            if (!dug) {
                log(bot, `Failed to break block at staircase feet level.`);
                return false;
            }
        }

        // Place floor block if there's air/cave_air under our destination
        if (floor && (floor.name === 'air' || floor.name === 'cave_air')) {
            // Rule 7: digUp places blocks directly via bot.placeBlock, bypassing the
            // skill-level placeBlock() wrapper that carries the ProtectedZone gate.
            // Check the floor cell against every protected zone (spawn, structures,
            // villages) before placing. Message wording matches the AutoRecovery
            // `inside_protected_zone` regex so the bot auto-escapes and retries.
            const floorZone = _isInAnyProtectedZone(bot, nextX, nextY - 1, nextZ);
            if (floorZone) {
                const label = floorZone.type === 'spawn' ? 'spawn' : `protected structure '${floorZone.name}'`;
                console.log(`[ProtectedZone] Blocked digUp place at (${nextX}, ${nextY - 1}, ${nextZ}) — inside ${floorZone.radius}-block ${label}`);
                log(bot, `Dug up ${ascended} blocks, but cannot place floor near ${label} (within ${floorZone.radius} blocks). Move further away first.`);
                return ascended > 0;
            }
            // Find a placeable block in inventory (cobblestone, stone, dirt, netherrack, etc.)
            const placeableBlocks = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'netherrack', 'granite', 'diorite', 'andesite', 'tuff', 'blackstone'];
            let placed = false;
            for (const blockName of placeableBlocks) {
                const item = bot.inventory.items().find(it => it.name === blockName);
                if (item) {
                    // Place the block below the destination
                    try {
                        await bot.equip(item, 'hand');
                        // We need an adjacent solid block to place against
                        // The block below the floor position
                        const belowFloor = bot.blockAt(new Vec3(nextX, nextY - 2, nextZ));
                        if (belowFloor && belowFloor.name !== 'air' && belowFloor.name !== 'cave_air') {
                            await bot.placeBlock(belowFloor, new Vec3(0, 1, 0));
                            placed = true;
                            console.log(`[Skills] digUp: placed ${blockName} as floor at (${nextX}, ${nextY - 1}, ${nextZ})`);
                        }
                    } catch (e) {
                        console.log(`[Skills] digUp: failed to place floor block: ${e.message}`);
                    }
                    break;
                }
            }
            if (!placed) {
                console.log(`[Skills] digUp: no floor block placed — no suitable blocks in inventory or no adjacent block to place against`);
            }
        }

        // Move to the new position
        console.log(`[Skills] digUp: moving to (${nextX}, ${nextY}, ${nextZ})`);
        try {
            await goToPosition(bot, nextX + 0.5, nextY, nextZ + 0.5, 0);
        } catch (e) {
            console.log(`[Skills] digUp: pathfinder failed, using jump+forward — ${e.message}`);
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            await new Promise(resolve => setTimeout(resolve, 500));
            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        currentPos = new Vec3(nextX, nextY, nextZ);
        ascended++;

        if (skyAbove) {
            log(bot, `Dug up ${ascended} blocks and reached the surface!`);
            return true;
        }
    }

    log(bot, `Dug a staircase up ${ascended} blocks.`);
    return true;
}

export const digUp = wrapSkill('digUp', _impl_digUp);
/**
 * Place a torch at (x, y, z) against the given face. Respects spawn zone
 * (placeBlock already blocks there). Records the position in the bot's
 * placed-torch memory (bot.placedTorches) so goToSurface can follow
 * breadcrumbs back up from a mining dive.
 *
 * @param {MinecraftBot} bot
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {string} face - 'top', 'bottom', 'north', 'south', 'east', 'west'
 * @returns {Promise<boolean>} true if torch placed successfully
 */
async function _impl_placeTorchAt(bot, x, y, z, face = 'bottom') {
    return await withBotLock('placeTorchAt', async () => {
        const torch = bot.inventory.findInventoryItem('torch');
        if (!torch) {
            // Log once per call so we can see WHY placement isn't happening.
            // Common reason: bot hasn't progressed to crafting torches yet
            // (needs coal/charcoal + stick). Auto-craft would be a #9 follow-up.
            console.log(`[Torch] Skipped placement at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}): no torch in inventory`);
            return false;
        }
        const success = await placeBlock(bot, 'torch', x, y, z, face, true);
        if (success) {
            if (!Array.isArray(bot.placedTorches)) bot.placedTorches = [];
            bot.placedTorches.push({
                x: Math.floor(x),
                y: Math.floor(y),
                z: Math.floor(z),
                placedAt: Date.now(),
            });
            // Cap at 200 most-recent torches to avoid unbounded memory
            if (bot.placedTorches.length > 200) {
                bot.placedTorches = bot.placedTorches.slice(-200);
            }
            console.log(`[Torch] Placed at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}) — ${bot.placedTorches.length} recorded`);
        } else {
            console.log(`[Torch] Placement at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}) failed (placeBlock returned false)`);
        }
        return success;
    });
}
export const placeTorchAt = wrapSkill('placeTorchAt', _impl_placeTorchAt);

/**
 * #6 Strategic torch placement — strict "left wall" convention.
 *
 * Reads bot._lastMovement (cached 1 Hz by modes.js self_preservation) for
 * the current horizontal heading; falls back to the caller-provided heading
 * (digDown passes its dig dx/dz so this works before the motion cache has
 * primed), then to bot yaw as a last resort. Computes left = (dz, -dx) and
 * probes the head-level block at bot+left. If that block is solid, places a
 * wall torch attached to that face. If not (open shaft, no left wall),
 * falls back to the legacy behind-bot floor torch so we never silently skip
 * a breadcrumb.
 *
 * Annotates the placedTorches entry with { face, placedFacing, headingDx,
 * headingDz } so goToSurface can audit direction on the ascent — a
 * properly placed "left-wall" torch (during descent) will appear on the
 * bot's RIGHT during ascent, giving us a visible right-side breadcrumb
 * trail and a warn-log signal when the chain contradicts the convention.
 *
 * @param {MinecraftBot} bot
 * @param {number} [fallbackDx=0]
 * @param {number} [fallbackDz=0]
 * @returns {Promise<boolean>}
 */
async function _impl_placeBreadcrumbTorch(bot, fallbackDx = 0, fallbackDz = 0) {
    return await withBotLock('placeBreadcrumbTorch', async () => {
        // 1) Heading: live motion cache > caller fallback > yaw
        let dx = 0, dz = 0;
        const m = bot._lastMovement;
        if (m && (m.dx !== 0 || m.dz !== 0)) {
            dx = m.dx; dz = m.dz;
        } else if (fallbackDx !== 0 || fallbackDz !== 0) {
            dx = fallbackDx; dz = fallbackDz;
        } else {
            try {
                const yaw = bot.entity.yaw;
                const sx = -Math.sin(yaw), sz = -Math.cos(yaw);
                if (Math.abs(sx) >= Math.abs(sz)) dx = sx > 0 ? 1 : -1;
                else dz = sz > 0 ? 1 : -1;
            } catch (_) { dx = 1; dz = 0; /* last-resort east */ }
        }

        // 2) Left of heading in Minecraft 2D: (dz, -dx)
        const lx = dz;
        const lz = -dx;
        const pos = bot.entity.position;
        const bx = Math.floor(pos.x);
        const by = Math.floor(pos.y);
        const bz = Math.floor(pos.z);
        const headY = by + 1;

        // 3) Probe wall at bot+left, head level
        let wallSolid = false;
        try {
            const wb = bot.blockAt(new Vec3(bx + lx, headY, bz + lz));
            const passable = ['air', 'cave_air', 'void_air', 'water', 'lava'];
            wallSolid = !!(wb && wb.boundingBox === 'block' && !passable.includes(wb.name));
        } catch (_) { wallSolid = false; }

        let torchX, torchY, torchZ, placedFace, placedFacing;
        if (wallSolid) {
            // Wall torch: target the air block at bot's head position adjacent
            // to the wall. face= cardinal FROM wall TO torch = -left vector.
            torchX = bx;
            torchY = headY;
            torchZ = bz;
            if (lx === 1) placedFace = 'west';
            else if (lx === -1) placedFace = 'east';
            else if (lz === 1) placedFace = 'north';
            else placedFace = 'south';
            placedFacing = 'left-wall';
        } else {
            // Fallback: behind-bot floor torch (legacy breadcrumb shape).
            torchX = bx - dx;
            torchY = headY;
            torchZ = bz - dz;
            placedFace = 'bottom';
            placedFacing = 'behind-bot-fallback';
            // #34 Guard 2: require a solid reference block below the torch XYZ.
            // Without one, placeBlock(...,'bottom',true) errors every cycle. Return
            // `false` (wrapSkill → abort) so the caller backs off on its cooldown
            // instead of re-entering the error loop. Uses the same passable set as
            // the wall probe above for consistency.
            try {
                const ref = bot.blockAt(new Vec3(torchX, torchY - 1, torchZ));
                const passable = ['air', 'cave_air', 'void_air', 'water', 'lava'];
                const refSolid = !!(ref && ref.boundingBox === 'block' && !passable.includes(ref.name));
                if (!refSolid) return false;
            } catch (_) { return false; }
        }

        const ok = await placeTorchAt(bot, torchX, torchY, torchZ, placedFace);
        // Annotate the just-pushed placedTorches entry with direction metadata
        // so goToSurface can audit (#6 right-side ascent preference).
        if (ok && Array.isArray(bot.placedTorches) && bot.placedTorches.length > 0) {
            const last = bot.placedTorches[bot.placedTorches.length - 1];
            if (last &&
                last.x === Math.floor(torchX) &&
                last.y === Math.floor(torchY) &&
                last.z === Math.floor(torchZ)) {
                last.face = placedFace;
                last.placedFacing = placedFacing;
                last.headingDx = dx;
                last.headingDz = dz;
            }
        }
        return ok;
    });
}
export const placeBreadcrumbTorch = wrapSkill('placeBreadcrumbTorch', _impl_placeBreadcrumbTorch);

async function _impl_goToSurface(bot) {
    /**
     * Navigate to the surface. If the bot has placed torches during a
     * mining dive (bot.placedTorches from placeTorchAt), follow them back
     * up in reverse order — breadcrumb navigation through the mine shaft.
     * Otherwise, fall back to the naive "probe highest non-air block at
     * current (x,z)" approach.
     *
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    // Torch breadcrumb path — only if we have torches within reasonable range
    if (Array.isArray(bot.placedTorches) && bot.placedTorches.length > 0) {
        const botPos = bot.entity.position;
        // Keep torches within 200 blocks XZ from the bot (same mine)
        const localTorches = bot.placedTorches.filter(t => {
            const dx = t.x - botPos.x;
            const dz = t.z - botPos.z;
            return Math.sqrt(dx * dx + dz * dz) < 200;
        });
        if (localTorches.length > 0) {
            // Ascend torches in order of increasing y (we placed them as we descended;
            // reverse order = travel up). Only use torches whose y is ABOVE current.
            const ascending = localTorches
                .filter(t => t.y >= Math.floor(botPos.y) - 1)
                .sort((a, b) => a.y - b.y);
            if (ascending.length > 0) {
                log(bot, `Following ${ascending.length} placed torches back to the surface.`);
                for (const t of ascending) {
                    // #6 right-side ascent audit: torches placed by the #6
                    // breadcrumb pattern store placedFacing='left-wall' (left
                    // of descent heading = right of ascent heading). Any torch
                    // with direction metadata that ISN'T 'left-wall' is either
                    // a legacy drop, an open-shaft fallback, or a wrong-side
                    // placement — warn so the log shows a wrong-direction
                    // signal at that rung. Does not change pathing.
                    if (t.placedFacing && t.placedFacing !== 'left-wall') {
                        console.warn(`[goToSurface] non-left-wall torch at (${t.x}, ${t.y}, ${t.z}) facing=${t.placedFacing} — wrong direction signal`);
                    }
                    try {
                        await goToPosition(bot, t.x, t.y, t.z, 1);
                    } catch (err) {
                        console.warn(`[goToSurface] Couldn't reach torch at (${t.x}, ${t.y}, ${t.z}): ${err.message}`);
                        // Keep going — next torch or fall through to naive probe
                    }
                }
                // Reached the last torch — now finish the climb to open sky
                log(bot, `Reached the last placed torch. Finishing ascent to open sky.`);
                // fall through to naive probe below
            }
        }
    }

    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        let block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block) {
            await bot.waitForChunksToLoad();
            block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        }
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);
        return true;
    }
    return false;
}
export const goToSurface = wrapSkill('goToSurface', _impl_goToSurface);












