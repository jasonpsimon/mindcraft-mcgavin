/**
 * exploration.js — underground exploration skills: digging, surface navigation,
 * cavern scanning, and torch breadcrumbing.
 *
 * Extracted from skills.js in Task 11 of the skills.js refactor plan.
 */

import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { withBotLock } from '../../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements, _isInAnyProtectedZone } from './_shared.js';
import { goToGoal, goToPosition } from './movement.js';
import { placeBlock, breakBlockAt } from './blocks.js';

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

/**
 * Scan for nearby open caverns/caves below the bot's current position.
 * Checks a grid pattern below and around the bot for clusters of air/cave_air blocks.
 * Returns the position of the nearest cavern entrance, or null if none found.
 * @param {MinecraftBot} bot
 * @param {number} radius - horizontal scan radius (default 16)
 * @param {number} depthBelow - how many blocks below to scan (default 30)
 * @returns {{ pos: Vec3, distance: number, airCount: number }|null}
 */
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
 * OPT-F: shared yaw-to-cardinal snapping (full object form, module-private).
 * Minecraft yaw: 0 = south (+Z), pi/2 = west (-X), pi = north (-Z), 3pi/2 = east (+X).
 * Snap to the nearest cardinal at pi/4 bounds.
 * @param {number} yaw - bot.entity.yaw
 * @returns {{dx: number, dz: number, name: 'south'|'west'|'north'|'east'}}
 */
function _yawToCardinalFull(yaw) {
    const normalized = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    if (normalized >= 5.5 || normalized < 0.785) return { dx: 0, dz: 1, name: 'south' };
    if (normalized < 2.356) return { dx: -1, dz: 0, name: 'west' };
    if (normalized < 3.927) return { dx: 0, dz: -1, name: 'north' };
    return { dx: 1, dz: 0, name: 'east' };
}

/**
 * Convert a Minecraft yaw angle to the nearest cardinal direction name.
 * Exported for unit testing.
 * @param {number} yaw - bot.entity.yaw
 * @returns {'south'|'west'|'north'|'east'}
 */
export function _yawToCardinal(yaw) {
    return _yawToCardinalFull(yaw).name;
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
    const { dx, dz, name: dirName } = _yawToCardinalFull(bot.entity.yaw);

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
    const { dx, dz, name: dirName } = _yawToCardinalFull(bot.entity.yaw);

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
