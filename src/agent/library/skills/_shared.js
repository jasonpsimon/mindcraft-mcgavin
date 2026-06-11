/**
 * _shared.js — shared infrastructure utilities used across skill domain modules.
 *
 * Public exports (re-exported by the barrel index):
 *   log, wait, createMovements, installSafePathfinderDefaults
 *
 * Domain-internal exports (imported by domain modules, NOT re-exported by barrel):
 *   expandBlockFamily, BLOCK_FAMILIES,
 *   _isInSpawnZone, _isNearProtectedZone, _isInAnyProtectedZone,
 *   _equipBestToolFor, _isUnderground, _isDangerous,
 *   SPAWN_PROTECTION_RADIUS, SPAWN_ESCAPE_DISTANCE
 */

import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";

// Block-family equivalence: when the LLM requests a specific variant but any
// member of the family would satisfy the goal, expand the search to all members.
// Prevents loops where the bot asks for "oak_log" in a biome with only spruce.
// Add new families as needed — each key is a family name; value is the full member list.
export const BLOCK_FAMILIES = {
    _log: [
        'oak_log', 'spruce_log', 'birch_log', 'dark_oak_log',
        'jungle_log', 'acacia_log', 'mangrove_log', 'cherry_log',
        'pale_oak_log',
    ],
    _planks: [
        'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks',
        'jungle_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks',
        'bamboo_planks',
    ],
};

/**
 * Expand a block type to include all family variants if it belongs to a known
 * family. Returns an array — the requested type first, then siblings.
 * Non-family blocks return a single-element array.
 */
export function expandBlockFamily(blockType) {
    for (const members of Object.values(BLOCK_FAMILIES)) {
        if (members.includes(blockType)) {
            // Requested type first so it is preferred when present
            return [blockType, ...members.filter(m => m !== blockType)];
        }
    }
    return [blockType];
}

export function log(bot, message) {
    bot.output += message + '\n';
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();

    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;

        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

/**
 * #4 Wrong tool for the block (2026-04-15).
 * Equip the best tool in inventory for breaking the given block, before
 * calling bot.dig(). Uses mineflayer-pathfinder's bestHarvestTool helper
 * which considers material compatibility and tier ranking.
 *
 * Skip if no tool is recommended (block doesn't need a tool, e.g. dirt) or
 * if the bot is already holding the best tool. Errors are logged and
 * swallowed — caller proceeds with whatever is currently equipped.
 */
export async function _equipBestToolFor(bot, block) {
    if (!block) return;
    try {
        const tool = bot.pathfinder?.bestHarvestTool?.(block);
        if (!tool) return;  // hand is best (block needs no tool, or no matching tool in inventory)
        if (bot.heldItem?.type === tool.type) return;  // already equipped
        await bot.equip(tool, 'hand');
    } catch (err) {
        // Equip can fail if inventory is full / off-hand-locked; not fatal
        console.warn(`[EquipTool] Failed to equip ${block?.name ? 'tool for ' + block.name : 'tool'}: ${err.message}`);
    }
}

/**
 * Check if a position is within the spawn protection zone.
 * Returns true if the position is within SPAWN_RADIUS blocks of world spawn (XZ only).
 */
export const SPAWN_PROTECTION_RADIUS = 250;
export const SPAWN_ESCAPE_DISTANCE = 375;  // walk to this distance from spawn on escape (50% buffer past 250-block protection)
export function _isInSpawnZone(bot, x, z) {
    const spawn = bot.spawnPoint;
    if (!spawn) return false; // no spawn data yet — allow action
    const dx = x - spawn.x;
    const dz = z - spawn.z;
    return (dx * dx + dz * dz) <= SPAWN_PROTECTION_RADIUS * SPAWN_PROTECTION_RADIUS;
}

/**
 * #7 Player-built structure protection (2026-04-15).
 *
 * bot.protectedZones is an array of zone objects. Each zone has the shape:
 *   {
 *     name: string,            // human-readable label used in logs and error messages
 *     type: string,            // 'structure' (manual) or 'village' (auto-detected)
 *     x: number, z: number,    // XZ center of the protected area
 *     radius: number,          // XZ radius (distance check, not a square box)
 *     yMin?: number,           // optional lower Y bound (inclusive); omit for unbounded
 *     yMax?: number,           // optional upper Y bound (inclusive); omit for unbounded
 *   }
 *
 * Y-bounds let the bot mine freely below or above a surface structure without
 * losing horizontal protection. A plains village centered at Y=64 with
 * yMin=44, yMax=94 protects the visible structure but leaves deep-mining
 * at Y<44 unrestricted even when the bot is horizontally inside the zone.
 * If yMin or yMax is undefined, that side is unbounded — omit both for a
 * full-column protect (the safe default for manual entries).
 *
 * Sources of zones:
 *   1. SPAWN zone — always present, handled by _isInSpawnZone/SPAWN_PROTECTION_RADIUS,
 *      Y-agnostic by design (spawn is player-meta, not a specific structure).
 *   2. Manual entries — loaded from `player_structures.json` at the repo root by
 *      _loadPlayerStructures() at agent startup. User-managed.
 *   3. Village auto-detection — future extension; populates entries with type='village'.
 *
 * All destructive primitives (breakBlockAt, placeBlock, safeToss underground
 * dig branch, autoBreakStuckPlant) call _isInAnyProtectedZone instead of the
 * narrower _isInSpawnZone, so a single check covers every source uniformly.
 */
export function _isNearProtectedZone(bot, x, y, z) {
    if (!Array.isArray(bot.protectedZones) || bot.protectedZones.length === 0) return null;
    for (const zone of bot.protectedZones) {
        // XZ radius check first — cheaper than Y comparison for most misses
        const dx = x - zone.x;
        const dz = z - zone.z;
        if ((dx * dx + dz * dz) > zone.radius * zone.radius) continue;
        // Y bounds (optional): if either bound is defined, honor it
        if (zone.yMin !== undefined && y < zone.yMin) continue;
        if (zone.yMax !== undefined && y > zone.yMax) continue;
        return zone;  // return the matching zone for log context
    }
    return null;
}

export function _isInAnyProtectedZone(bot, x, y, z) {
    // Spawn zone is Y-agnostic by design — it gates the new-player wilderness
    // regardless of depth. No y check here.
    if (_isInSpawnZone(bot, x, z)) return { type: 'spawn', radius: SPAWN_PROTECTION_RADIUS };
    const structure = _isNearProtectedZone(bot, x, y, z);
    if (structure) return { type: structure.type || 'structure', name: structure.name, radius: structure.radius };
    return null;
}

/**
 * Rule 7 / Whiteboard #12 — safe pathfinder movement configuration.
 *
 * Configure a Movements object to avoid terrain hazards (sweet berry bushes,
 * dripstone, cactus, etc.) by adding them to blocksToAvoid.
 *
 * This is a private helper called only from createMovements() and
 * installSafePathfinderDefaults(). Not exported.
 */
function _configureTerrainSafeMovements(bot, movements) {
    // Damage-on-contact blocks — pathfinder should route around these
    const hazards = [
        'sweet_berry_bush',     // damages bot on contact
        'pointed_dripstone',    // falls from ceiling, damages on landing
        'cactus',               // damages adjacent entities
        'wither_rose',          // inflicts Wither effect
        'magma_block',          // damages entities standing on it
        'fire',                 // already in default, belt + suspenders
        'soul_fire',            // high damage fire variant
        'powder_snow',          // can trap bot, slow freeze damage
        'lava',                 // OPT-J: floor-was-lava deaths at low Y
        'campfire',             // 1 HP/tick when standing on
        'soul_campfire',        // 2 HP/tick when standing on
    ];
    for (const name of hazards) {
        const block = bot.registry.blocksByName[name];
        if (block) movements.blocksToAvoid.add(block.id);
    }
}

/**
 * Factory for pf.Movements that respects protected zones.
 *
 * Every callsite that needs pathfinder Movements should use this instead of
 * raw `new pf.Movements(bot)`. When the bot is inside a protected zone
 * (spawn, village, or manual structure), the returned Movements object has
 * dig and scaffold disabled so the pathfinder walks around obstacles instead
 * of digging through or scaffolding over them.
 *
 * Outside protected zones, returns a normal Movements object with terrain-safe
 * hazard avoidance applied.
 *
 * This is the Rule 7 perimeter closure for pathfinder-initiated block
 * modifications. Direct bot.dig / bot.placeBlock calls are guarded by their
 * own per-function zone checks (breakBlockAt, placeBlock, collectBlock, etc.).
 *
 * **Invariant:** no raw `new pf.Movements(bot)` anywhere in mindcraft-mcgavin
 * outside this factory. Enforced by `scripts/check-movements-invariant.sh`.
 * Audit #12 (2026-04-20) confirmed zero raw callsites in `src/`.
 *
 * @param {object} bot - The mineflayer bot
 * @returns {pf.Movements} Zone-aware movements object
 */
export function createMovements(bot) {
    const m = new pf.Movements(bot);
    _configureTerrainSafeMovements(bot, m);

    // BT-10j (2026-04-19): cap maxDropDown at 3 (vanilla no-fall-damage
    // limit is 3.5 blocks). Pathfinder default is 4, which can plan drops
    // that hurt on landing. Individual callsites can still override this
    // upward if a longer drop is genuinely intended.
    m.maxDropDown = 3;

    // #12-follow-up (2026-04-20): bias the pathfinder against destructive
    // path elements. Defaults are digCost=1 / placeCost=1 — equal to walking,
    // so the planner happily mines through obstacles or scaffolds across gaps
    // when a short detour exists. This matches `installSafePathfinderDefaults`
    // (line ~1755) which already applies digCost=10 on bot.collectBlock.movements
    // with the same rationale ("no straight-down digging" safety norm).
    // placeCost=2 is a softer bias — scaffolding is sometimes the only path,
    // but should still lose to a comparable walk-around.
    m.digCost = 10;
    m.placeCost = 2;

    // Protected zone check: disable dig and scaffold inside zones
    const pos = bot.entity?.position;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
        const zone = _isInAnyProtectedZone(bot, pos.x, pos.y, pos.z);
        if (zone) {
            m.canDig = false;
            m.scaffoldingBlocks = new Set();
            const label = zone.type === 'spawn' ? 'spawn zone' : `protected zone '${zone.name || zone.type}'`;
            console.log(`[CreateMovements] Inside ${label} — pathfinder dig/scaffold disabled`);
        }
    }

    return m;
}

/**
 * Rule 7 note: this was Stage 1 of the broader Movements safety audit
 * tracked as whiteboard #12. As of the createMovements() factory, all
 * pathfinder Movements in skills.js route through the shared factory
 * which applies terrain-safe config and disables dig/scaffold in
 * protected zones.
 */
export function installSafePathfinderDefaults(bot) {
    if (!bot.collectBlock || !bot.collectBlock.movements) {
        console.warn('[SafeMovements] bot.collectBlock.movements not available — skipping');
        return false;
    }
    const m = bot.collectBlock.movements;
    m.maxDropDown = 3;   // vanilla no-damage limit (default 4 can cause fall damage)
    m.digCost = 10;      // discourage mining-through paths; prefer walking/staircase
    m.canSwim = true;    // allow swimming in water instead of drowning
    _configureTerrainSafeMovements(bot, m);
    console.log('[SafeMovements] bot.collectBlock.movements configured: maxDropDown=3, digCost=10, canSwim=true, terrain-safe');
    return true;
}

/**
 * Determine if the bot is underground by counting solid blocks around it.
 * Underground = 3+ of 4 cardinal neighbors at feet level are solid,
 * OR the bot is below Y=50 (deep enough to be in a mine shaft).
 */
export function _isUnderground(bot, pos) {
    // Deep underground — definitely not surface
    if (pos.y < 50) return true;

    // Count solid walls around the bot at feet level
    let solidCount = 0;
    const checks = [
        pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1), pos.offset(0, 0, -1),
    ];
    for (const checkPos of checks) {
        const block = bot.blockAt(checkPos);
        if (block && block.name !== 'air' && block.name !== 'cave_air'
            && block.name !== 'short_grass' && block.name !== 'tall_grass') {
            solidCount++;
        }
    }
    // Also check above — if there's a solid ceiling, we're underground
    const ceiling = bot.blockAt(pos.offset(0, 2, 0));
    const hasCeiling = ceiling && ceiling.name !== 'air' && ceiling.name !== 'cave_air'
        && ceiling.name !== 'short_grass';

    return solidCount >= 3 || (solidCount >= 2 && hasCeiling);
}

// OPT-D: hoisted to module scope — avoid per-call array allocation + O(n)
// .includes() scan. Set.has() is O(1) and called 1000s/min during tunnel-scan
// and safeToss direction-validation loops.
const DANGEROUS_BLOCK_NAMES = new Set(['lava', 'water', 'bedrock', 'air', 'cave_air']);

/**
 * Check if a block name is dangerous (lava, water, bedrock, or empty space
 * treated as a fall hazard for safeToss direction validation).
 */
export function _isDangerous(name) {
    return DANGEROUS_BLOCK_NAMES.has(name);
}
