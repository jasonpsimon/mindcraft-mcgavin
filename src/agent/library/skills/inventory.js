import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../../utils/inventory_utils.js';
import { withBotLock } from '../../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements, _isInAnyProtectedZone, _equipBestToolFor, _isUnderground, _isDangerous } from './_shared.js';
import { goToGoal, goToPosition, goToPlayer, moveAwayFromEntity } from './movement.js';
import { craftRecipe } from './crafting.js';


// === equip ===

async function _impl_equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export const equip = wrapSkill('equip', _impl_equip);


// === replaceBrokenArmor ===
// BT-25 (2026-04-19): durability-aware armor replacement

// Armor tiers: 0-indexed, -1 for non-armor items.
// leather=0, chainmail=1, iron=1, golden=2, diamond=3, netherite=4
const _ARMOR_TIER_MAP = { leather: 0, chainmail: 1, iron: 1, golden: 2, diamond: 3, netherite: 4 };

export function _armorTier(itemName) {
    if (!itemName) return -1;
    for (const [prefix, rank] of Object.entries(_ARMOR_TIER_MAP)) {
        if (itemName.startsWith(prefix + '_')) return rank;
    }
    return -1;
}

const ARMOR_PIECES = [
    { slot: 5, bodyPart: 'head',  suffix: 'helmet' },
    { slot: 6, bodyPart: 'torso', suffix: 'chestplate' },
    { slot: 7, bodyPart: 'legs',  suffix: 'leggings' },
    { slot: 8, bodyPart: 'feet',  suffix: 'boots' },
];

async function _impl_replaceBrokenArmor(bot) {
    /**
     * Scan equipped armor; for each piece <20% durability, equip a same-or-
     * better-tier replacement from inventory, or craft same-tier if none.
     * Re-entry throttled to 5s.
     * @param {MinecraftBot} bot
     * @returns {Promise<boolean>} true if any swap or craft+equip happened.
     */
    const now = Date.now();
    if (bot._lastArmorReplace && now - bot._lastArmorReplace < 5000) {
        return false;
    }
    bot._lastArmorReplace = now;

    let anyReplaced = false;
    for (const piece of ARMOR_PIECES) {
        const equipped = bot.inventory.slots[piece.slot];
        if (!equipped) continue;
        const maxDur = equipped.maxDurability || 0;
        if (maxDur <= 0) continue;
        const remaining = maxDur - (equipped.durabilityUsed || 0);
        const pct = remaining / maxDur;
        if (pct >= 0.2) continue;

        const equippedTier = _armorTier(equipped.name);
        log(bot, `[ReplaceArmor] ${piece.suffix} (${equipped.name}) at ${Math.round(pct*100)}% durability — looking for replacement`);

        // Search inventory for same-or-better-tier replacement (skip equipped slot).
        let best = null;
        let bestRank = -1;
        for (let i = 0; i < bot.inventory.slots.length; i++) {
            if (i === piece.slot) continue;
            const item = bot.inventory.slots[i];
            if (!item) continue;
            if (!item.name.endsWith('_' + piece.suffix)) continue;
            const imMax = item.maxDurability || 0;
            if (imMax > 0) {
                const imRem = imMax - (item.durabilityUsed || 0);
                if (imRem / imMax < 0.2) continue;  // skip nearly-broken spares
            }
            const rank = _armorTier(item.name);
            if (rank >= equippedTier && rank > bestRank) {
                best = item;
                bestRank = rank;
            }
        }

        if (best) {
            try {
                await bot.equip(best, piece.bodyPart);
                log(bot, `[ReplaceArmor] Equipped ${best.name} in ${piece.bodyPart} slot`);
                anyReplaced = true;
                continue;
            } catch (err) {
                log(bot, `[ReplaceArmor] Failed to equip ${best.name}: ${err.message}`);
            }
        }

        // No replacement in inventory — try to craft same-tier piece.
        if (equippedTier >= 0) {
            const tierName = Object.entries(_ARMOR_TIER_MAP).find(([, r]) => r === equippedTier)?.[0];
            if (!tierName) continue;
            const craftName = `${tierName}_${piece.suffix}`;
            log(bot, `[ReplaceArmor] No spare ${piece.suffix} in inventory — attempting to craft ${craftName}`);
            try {
                await craftRecipe(bot, craftName, 1);
                const newItem = bot.inventory.slots.find((s, i) => i !== piece.slot && s && s.name === craftName);
                if (newItem) {
                    await bot.equip(newItem, piece.bodyPart);
                    log(bot, `[ReplaceArmor] Crafted and equipped ${craftName}`);
                    anyReplaced = true;
                } else {
                    log(bot, `[ReplaceArmor] Craft of ${craftName} did not produce inventory item (missing ingredients or no nearby crafting table)`);
                }
            } catch (err) {
                log(bot, `[ReplaceArmor] Craft attempt for ${craftName} threw: ${err.message}`);
            }
        }
    }
    return anyReplaced;
}

export const replaceBrokenArmor = wrapSkill('replaceBrokenArmor', _impl_replaceBrokenArmor);


// === safeToss / safeTossBatch helpers ===

/**
 * Seal a 1-block hole by placing a block into it.
 * Uses the floor/back of the hole as the reference block and places on top/face.
 * Prefers the original material, falls back to common blocks.
 */
async function _sealHole(bot, holePos, originalName) {
    const sealItem = _findSealBlock(bot, originalName);
    if (!sealItem) {
        console.warn('[SafeToss] No blocks available to seal hole');
        return;
    }

    try {
        await bot.equip(sealItem, 'hand');

        // Try placing against the block below the hole (floor)
        const below = bot.blockAt(holePos.offset(0, -1, 0));
        if (below && below.name !== 'air' && below.name !== 'cave_air') {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            console.log(`[SafeToss] Sealed with ${sealItem.name} (placed on floor)`);
            return;
        }

        // Try placing against any adjacent solid block
        const neighbors = [
            { pos: holePos.offset(1, 0, 0), face: new Vec3(-1, 0, 0) },
            { pos: holePos.offset(-1, 0, 0), face: new Vec3(1, 0, 0) },
            { pos: holePos.offset(0, 0, 1), face: new Vec3(0, 0, -1) },
            { pos: holePos.offset(0, 0, -1), face: new Vec3(0, 0, 1) },
            { pos: holePos.offset(0, 1, 0), face: new Vec3(0, -1, 0) },
        ];
        for (const n of neighbors) {
            const block = bot.blockAt(n.pos);
            if (block && block.name !== 'air' && block.name !== 'cave_air') {
                await bot.placeBlock(block, n.face);
                console.log(`[SafeToss] Sealed with ${sealItem.name} (placed against neighbor)`);
                return;
            }
        }

        console.warn('[SafeToss] No reference block found to place seal');
    } catch (e) {
        console.warn('[SafeToss] Seal placement failed:', e.message);
    }
}

/**
 * Find a block in inventory to seal a hole.
 * Prefers the original material, falls back to common blocks.
 */
function _findSealBlock(bot, preferredName) {
    if (preferredName) {
        const preferred = bot.inventory.findInventoryItem(preferredName);
        if (preferred) return preferred;
    }
    const fallbacks = ['cobblestone', 'dirt', 'andesite', 'diorite', 'granite',
        'tuff', 'cobbled_deepslate', 'deepslate', 'netherrack', 'stone',
        'grass_block', 'mud', 'sand', 'gravel'];
    for (const name of fallbacks) {
        const item = bot.inventory.findInventoryItem(name);
        if (item) return item;
    }
    return null;
}


// === safeToss ===

/**
 * Safely toss items by digging a side pocket when underground/confined.
 * Prevents the bot from immediately picking up discarded items in shafts.
 * In open areas (surface), just tosses normally.
 * @param {MinecraftBot} bot
 * @param {number} itemType - item type ID
 * @param {null} metadata - always null (matches bot.toss signature)
 * @param {number} count - how many to toss
 */
async function _impl_safeToss(bot, itemType, metadata, count) {
    return await withBotLock('safeToss', async () => {
        const pos = bot.entity.position.floored();

        // In spawn zone or near a protected player structure — no digging
        // allowed, just toss normally
        const tossZone = _isInAnyProtectedZone(bot, pos.x, pos.y, pos.z);
        if (tossZone) {
            const label = tossZone.type === 'spawn' ? 'spawn protection zone' : `protected structure '${tossZone.name}'`;
            console.log(`[SafeToss] Inside ${label} — tossing without digging`);
            await bot.toss(itemType, metadata, count);
            return;
        }

        const isUnderground = _isUnderground(bot, pos);

        // Preserve pathfinder movements across the whole operation
        const prevMovements = bot.pathfinder.movements;

        try {
            if (isUnderground) {
                // --- Underground: Dump Run ---
                // Walk-and-dig: for each step, dig head then feet, then walk
                // into the newly cleared block. This respects mineflayer's
                // reach limit (~6 blocks) and avoids the pathfinder thrash
                // of letting bot.dig auto-path to out-of-reach blocks.
                // 8 blocks ensures items are well outside the ~2-block pickup radius.
                const TUNNEL_LEN = 8;
                const directions = [
                    { dx: 1, dz: 0, label: '+X' },
                    { dx: -1, dz: 0, label: '-X' },
                    { dx: 0, dz: 1, label: '+Z' },
                    { dx: 0, dz: -1, label: '-Z' },
                ];

                for (const dir of directions) {
                    // Verify all 8 blocks in this direction are diggable at feet+head
                    let canDig = true;
                    for (let step = 1; step <= TUNNEL_LEN; step++) {
                        const feetBlock = bot.blockAt(pos.offset(dir.dx * step, 0, dir.dz * step));
                        const headBlock = bot.blockAt(pos.offset(dir.dx * step, 1, dir.dz * step));
                        if (!feetBlock || !headBlock
                            || !feetBlock.diggable || !headBlock.diggable
                            || _isDangerous(feetBlock.name) || _isDangerous(headBlock.name)) {
                            canDig = false;
                            break;
                        }
                    }
                    if (!canDig) continue;

                    // Verify solid floor under the tunnel (including the dump spot)
                    let hasFloor = true;
                    for (let step = 1; step <= TUNNEL_LEN; step++) {
                        const floor = bot.blockAt(pos.offset(dir.dx * step, -1, dir.dz * step));
                        if (!floor || floor.name === 'air' || floor.name === 'cave_air'
                            || _isDangerous(floor.name)) {
                            hasFloor = false;
                            break;
                        }
                    }
                    if (!hasFloor) continue;

                    // Also need a diggable floor at the end for the dump hole
                    const dumpFloor = bot.blockAt(pos.offset(dir.dx * TUNNEL_LEN, -1, dir.dz * TUNNEL_LEN));
                    if (!dumpFloor || !dumpFloor.diggable || _isDangerous(dumpFloor.name)) continue;

                    console.log(`[SafeToss] Dump run ${dir.label} — walk-dig ${TUNNEL_LEN} blocks from ${pos}`);
                    const startPos = bot.entity.position.clone();

                    try {
                        // Walk-and-dig: one step at a time so each bot.dig stays in reach
                        for (let step = 1; step <= TUNNEL_LEN; step++) {
                            const stepPos = pos.offset(dir.dx * step, 0, dir.dz * step);
                            const feetBlock = bot.blockAt(stepPos);
                            const headBlock = bot.blockAt(stepPos.offset(0, 1, 0));

                            // Dig head first (prevent gravity-block fall-in), then feet
                            if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
                                await _equipBestToolFor(bot, headBlock);
                                await bot.dig(headBlock);
                            }
                            if (feetBlock && feetBlock.name !== 'air' && feetBlock.name !== 'cave_air') {
                                await _equipBestToolFor(bot, feetBlock);
                                await bot.dig(feetBlock);
                            }

                            // Walk into the cleared block before digging the next step
                            await goToGoal(bot, new pf.goals.GoalNear(stepPos.x, stepPos.y, stepPos.z, 0));
                        }

                        // Dig the 1-block floor hole at the dump spot
                        const endPos = pos.offset(dir.dx * TUNNEL_LEN, 0, dir.dz * TUNNEL_LEN);
                        const holePos = endPos.offset(0, -1, 0);
                        const holeBlock = bot.blockAt(holePos);
                        if (holeBlock && holeBlock.name !== 'air' && holeBlock.name !== 'cave_air') {
                            await _equipBestToolFor(bot, holeBlock);
                            await bot.dig(holeBlock);
                        }

                        // Drop items into the hole
                        await bot.lookAt(holePos.offset(0.5, 0.5, 0.5));
                        await bot.toss(itemType, metadata, count);
                        console.log(`[SafeToss] Dropped in hole at ${holePos}, walking back`);

                        // Walk back to starting position
                        await new Promise(r => setTimeout(r, 300));
                        await goToGoal(bot, new pf.goals.GoalNear(startPos.x, startPos.y, startPos.z, 1));
                        console.log('[SafeToss] Dump run complete — back at start');
                        return;
                    } catch (e) {
                        console.warn(`[SafeToss] Dump run ${dir.label} failed:`, e.message);
                        try {
                            await goToGoal(bot, new pf.goals.GoalNear(startPos.x, startPos.y, startPos.z, 1));
                        } catch (_) { /* best effort return */ }
                    }
                }
            } else {
                // Surface: dig 1 block down into the floor, toss items in, seal the top
                const holePos = pos.offset(0, -1, 0);
                const floorBlock = bot.blockAt(holePos);
                if (floorBlock && floorBlock.diggable && !_isDangerous(floorBlock.name)) {
                    const originalName = floorBlock.name;
                    console.log(`[SafeToss] Surface hole — ${originalName} at ${holePos}`);
                    try {
                        await _equipBestToolFor(bot, floorBlock);
                        await bot.dig(floorBlock);
                        await bot.lookAt(holePos.offset(0.5, 0.5, 0.5));
                        await bot.toss(itemType, metadata, count);
                        await new Promise(r => setTimeout(r, 400));
                        await _sealHole(bot, holePos, originalName);
                        return;
                    } catch (e) {
                        console.warn('[SafeToss] Surface hole failed:', e.message);
                    }
                }
            }

            // Last resort — normal toss
            console.log('[SafeToss] No disposal method worked, tossing normally');
            await bot.toss(itemType, metadata, count);
        } finally {
            // Restore pathfinder movements regardless of exit path
            if (prevMovements) {
                try { bot.pathfinder.setMovements(prevMovements); } catch (_) { /* ignore */ }
            }
        }
    });
}

export const safeToss = wrapSkill('safeToss', _impl_safeToss);


// === safeTossBatch ===

/**
 * Batch-toss multiple item types using a SINGLE dump run.
 * Digs one tunnel (underground) or one hole (surface), drops ALL items into the
 * same spot, then walks back. Avoids the N-tunnels-for-N-items problem.
 *
 * @param {object} bot - The mineflayer bot
 * @param {Array<{type: number, count: number, name: string}>} items - Items to toss
 *   Each entry: { type: itemId, count: howMany, name: displayName }
 */
async function _impl_safeTossBatch(bot, items) {
    if (!items || items.length === 0) return;

    return await withBotLock('safeTossBatch', async () => {
        const pos = bot.entity.position.floored();

        // Protected zone — just toss everything directly, no digging
        const tossZone = _isInAnyProtectedZone(bot, pos.x, pos.y, pos.z);
        if (tossZone) {
            const label = tossZone.type === 'spawn' ? 'spawn protection zone' : `protected structure '${tossZone.name}'`;
            console.log(`[SafeTossBatch] Inside ${label} — tossing ${items.length} item type(s) without digging`);
            for (const item of items) {
                try { await bot.toss(item.type, null, item.count); } catch (_) {}
            }
            return;
        }

        const isUnderground = _isUnderground(bot, pos);
        const prevMovements = bot.pathfinder.movements;

        try {
            if (isUnderground) {
                // --- Underground: single dump run for all items ---
                const TUNNEL_LEN = 8;
                const directions = [
                    { dx: 1, dz: 0, label: '+X' },
                    { dx: -1, dz: 0, label: '-X' },
                    { dx: 0, dz: 1, label: '+Z' },
                    { dx: 0, dz: -1, label: '-Z' },
                ];

                for (const dir of directions) {
                    // Verify all blocks in this direction are diggable at feet+head
                    let canDig = true;
                    for (let step = 1; step <= TUNNEL_LEN; step++) {
                        const feetBlock = bot.blockAt(pos.offset(dir.dx * step, 0, dir.dz * step));
                        const headBlock = bot.blockAt(pos.offset(dir.dx * step, 1, dir.dz * step));
                        if (!feetBlock || !headBlock
                            || !feetBlock.diggable || !headBlock.diggable
                            || _isDangerous(feetBlock.name) || _isDangerous(headBlock.name)) {
                            canDig = false;
                            break;
                        }
                    }
                    if (!canDig) continue;

                    // Verify solid floor under the tunnel
                    let hasFloor = true;
                    for (let step = 1; step <= TUNNEL_LEN; step++) {
                        const floor = bot.blockAt(pos.offset(dir.dx * step, -1, dir.dz * step));
                        if (!floor || floor.name === 'air' || floor.name === 'cave_air'
                            || _isDangerous(floor.name)) {
                            hasFloor = false;
                            break;
                        }
                    }
                    if (!hasFloor) continue;

                    // Need a diggable floor at the end for the dump hole
                    const dumpFloor = bot.blockAt(pos.offset(dir.dx * TUNNEL_LEN, -1, dir.dz * TUNNEL_LEN));
                    if (!dumpFloor || !dumpFloor.diggable || _isDangerous(dumpFloor.name)) continue;

                    console.log(`[SafeTossBatch] Dump run ${dir.label} — walk-dig ${TUNNEL_LEN} blocks, dropping ${items.length} item type(s)`);
                    const startPos = bot.entity.position.clone();

                    try {
                        // Walk-and-dig one step at a time
                        for (let step = 1; step <= TUNNEL_LEN; step++) {
                            const stepPos = pos.offset(dir.dx * step, 0, dir.dz * step);
                            const headBlock = bot.blockAt(stepPos.offset(0, 1, 0));
                            const feetBlock = bot.blockAt(stepPos);

                            if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
                                await _equipBestToolFor(bot, headBlock);
                                await bot.dig(headBlock);
                            }
                            if (feetBlock && feetBlock.name !== 'air' && feetBlock.name !== 'cave_air') {
                                await _equipBestToolFor(bot, feetBlock);
                                await bot.dig(feetBlock);
                            }

                            await goToGoal(bot, new pf.goals.GoalNear(stepPos.x, stepPos.y, stepPos.z, 0));
                        }

                        // Dig 1-block hole at the dump spot
                        const endPos = pos.offset(dir.dx * TUNNEL_LEN, 0, dir.dz * TUNNEL_LEN);
                        const holePos = endPos.offset(0, -1, 0);
                        const holeBlock = bot.blockAt(holePos);
                        if (holeBlock && holeBlock.name !== 'air' && holeBlock.name !== 'cave_air') {
                            await _equipBestToolFor(bot, holeBlock);
                            await bot.dig(holeBlock);
                        }

                        // Drop ALL items into the same hole
                        await bot.lookAt(holePos.offset(0.5, 0.5, 0.5));
                        for (const item of items) {
                            try {
                                await bot.toss(item.type, null, item.count);
                            } catch (e) {
                                console.warn(`[SafeTossBatch] Failed to toss ${item.name}: ${e.message}`);
                            }
                        }
                        console.log(`[SafeTossBatch] Dropped ${items.length} item type(s) in hole at ${holePos}, walking back`);

                        // Walk back
                        await new Promise(r => setTimeout(r, 300));
                        await goToGoal(bot, new pf.goals.GoalNear(startPos.x, startPos.y, startPos.z, 1));
                        console.log('[SafeTossBatch] Dump run complete — back at start');
                        return;
                    } catch (e) {
                        console.warn(`[SafeTossBatch] Dump run ${dir.label} failed:`, e.message);
                        try {
                            await goToGoal(bot, new pf.goals.GoalNear(startPos.x, startPos.y, startPos.z, 1));
                        } catch (_) { /* best effort return */ }
                    }
                }
            } else {
                // Surface: dig 1 block down, toss all items in, seal
                const holePos = pos.offset(0, -1, 0);
                const floorBlock = bot.blockAt(holePos);
                if (floorBlock && floorBlock.diggable && !_isDangerous(floorBlock.name)) {
                    const originalName = floorBlock.name;
                    console.log(`[SafeTossBatch] Surface hole — ${originalName} at ${holePos}, dropping ${items.length} item type(s)`);
                    try {
                        await _equipBestToolFor(bot, floorBlock);
                        await bot.dig(floorBlock);
                        await bot.lookAt(holePos.offset(0.5, 0.5, 0.5));
                        for (const item of items) {
                            try {
                                await bot.toss(item.type, null, item.count);
                            } catch (e) {
                                console.warn(`[SafeTossBatch] Failed to toss ${item.name}: ${e.message}`);
                            }
                        }
                        await new Promise(r => setTimeout(r, 400));
                        await _sealHole(bot, holePos, originalName);
                        console.log('[SafeTossBatch] Surface dump complete');
                        return;
                    } catch (e) {
                        console.warn('[SafeTossBatch] Surface hole failed:', e.message);
                    }
                }
            }

            // Last resort — toss everything normally
            console.log('[SafeTossBatch] No disposal method worked, tossing normally');
            for (const item of items) {
                try { await bot.toss(item.type, null, item.count); } catch (_) {}
            }
        } finally {
            if (prevMovements) {
                try { bot.pathfinder.setMovements(prevMovements); } catch (_) {}
            }
        }
    });
}

export const safeTossBatch = wrapSkill('safeTossBatch', _impl_safeTossBatch);


// === discard ===

async function _impl_discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await safeToss(bot, item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    markDiscarded();
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}
export const discard = wrapSkill('discard', _impl_discard);


// === putInChest ===

async function _impl_putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}
export const putInChest = wrapSkill('putInChest', _impl_putInChest);


// === takeFromChest ===

async function _impl_takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);

    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }

    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;

    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;

        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);

        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }

    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}
export const takeFromChest = wrapSkill('takeFromChest', _impl_takeFromChest);


// === viewChest ===

async function _impl_viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}
export const viewChest = wrapSkill('viewChest', _impl_viewChest);


// === giveToPlayer ===

async function _impl_giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}
export const giveToPlayer = wrapSkill('giveToPlayer', _impl_giveToPlayer);
