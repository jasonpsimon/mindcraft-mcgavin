/**
 * blocks.js — block interaction skills: collect, break, place, pick up items,
 * auto-break stuck plants, and the useToolOnBlock helper used by social.js.
 *
 * Extracted from skills.js in Task 8 of the skills.js refactor plan.
 */

import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../../utils/inventory_utils.js';
import { withBotLock } from '../../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import {
  log, createMovements, expandBlockFamily,
  _isInAnyProtectedZone, _equipBestToolFor,
  _isUnderground, _isDangerous,
} from './_shared.js';
import { goToGoal, goToPosition } from './movement.js';
import { equip } from './inventory.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

// L1.4-wire BT 2 (2026-04-20): named-skill allowlist for ops that should
// pass through protected-zone tripwires. A caller opts a sub-op in by setting
// `bot._allowProtectedZoneOps = '<skillName>'` around the sensitive call(s)
// (and clearing in finally — see `_impl_tillAndSow` for the reference pattern,
// mirrors BT-7b's `_placeIntent` shape). The gates in `_impl_breakBlockAt`
// and `_impl_placeBlock` honor the flag only when the named skill is in this
// Set. Default (flag unset OR name not listed) preserves full protection.
// Adding a new allowlisted op = one-line append here + matching try/finally
// at the skill's entry point.
const PROTECTED_ZONE_ALLOWLIST = new Set(['tillAndSow']);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

// ---------------------------------------------------------------------------
// Plant-pattern constants used by autoBreakStuckPlant
// ---------------------------------------------------------------------------

// Plant-like blocks that are safe to break inside the spawn zone.
// Leaves are included here (per JP 2026-04-14) — they decay naturally in
// Minecraft anyway, so breaking one to clear a path is benign.
//
// Bug A fix (2026-04-15): patterns now use word-boundary anchors where the
// token would otherwise match solid-terrain block names. E.g. bare "grass"
// would match both "short_grass" (plant) and "grass_block" (solid dirt cube).
// "(^|_)grass$" matches the former, skips the latter.
const PLANT_LIKE_PATTERN = /bush|fern|(^|_)grass$|vine|flower|sprout|lichen|sugar_cane|dead_bush|nether_sprouts|kelp|seagrass|sea_pickle|lily_pad|dripleaf|pitcher_plant|torchflower|spore_blossom|leaves/i;
// Tree-associated structural blocks — do NOT break inside protected zones
// (logs, wood, saplings, nether tree stems, bamboo/azalea blocks).
// Leaves intentionally NOT in this list per JP: leaves behave like plants.
// Mangrove roots NOT in this list — they block movement and should be breakable.
const TREE_PART_PATTERN = /(^|_)(log|wood|sapling|propagule|hyphae)$|^(bamboo_block|bamboo_sapling|azalea|flowering_azalea)$/i;

// Tight allowlist: blocks that actually impede bot movement and are allowed
// to be broken inside protected zones. Everything else (short_grass, flowers,
// ferns, dead_bush, glow_lichen, kelp, seagrass, sea_pickle, lily_pad,
// pitcher_plant, torchflower, spore_blossom, nether_sprouts, small_dripleaf)
// is passable — the bot walks right through them, no need to break.
const MOVEMENT_BLOCKING_PLANTS = new Set([
    'sweet_berry_bush',       // solid hitbox + damages on contact
    'vine',                   // dense wall vines block pathing
    'big_dripleaf',           // solid platform
    'mangrove_roots',         // solid hitbox, blocks movement
    'muddy_mangrove_roots',   // solid hitbox, blocks movement
    // All leaf types — solid hitbox, common obstruction near trees
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'dark_oak_leaves',
    'jungle_leaves', 'acacia_leaves', 'mangrove_leaves', 'cherry_leaves',
    'pale_oak_leaves', 'azalea_leaves', 'flowering_azalea_leaves',
]);

// Hard exclusion list — solid-terrain blocks that would otherwise be
// misclassified as plants. Never break these even if they match the
// plant pattern. Belt-and-suspenders with the tightened regex above.
const SOLID_GROUND_BLOCKS = new Set([
    'grass_block', 'moss_block', 'mycelium', 'podzol',
    'rooted_dirt', 'dirt_path', 'farmland',
]);

// ---------------------------------------------------------------------------
// useToolOnBlock — private helper, exported for social.js
// ---------------------------------------------------------------------------

/**
 * Use a tool on a specific block.
 * @param {MinecraftBot} bot
 * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
 * @param {Block} block - the block reference to use the tool on.
 * @returns {Promise<boolean>} true if action succeeded
 */
export async function useToolOnBlock(bot, toolName, block) {
    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView &&
            !blockInView.position.equals(block.position) &&
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView?.name || 'unknown'} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView?.name || 'unknown'} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
}

// ---------------------------------------------------------------------------
// collectBlock
// ---------------------------------------------------------------------------

async function _impl_collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = [blockType];
    // Shorthand: "iron" → "iron_ore", etc.
    if (['coal', 'diamond', 'emerald', 'iron', 'gold', 'copper', 'lapis_lazuli', 'redstone'].includes(blockType))
        blocktypes.push(blockType + '_ore');
    // Regular ore ↔ deepslate ore (both directions)
    if (blockType.endsWith('ore') && !blockType.startsWith('deepslate_'))
        blocktypes.push('deepslate_' + blockType);
    if (blockType.startsWith('deepslate_'))
        blocktypes.push(blockType.replace('deepslate_', ''));
    // Nether ore variants
    if (blockType === 'gold_ore' || blockType === 'gold')
        blocktypes.push('nether_gold_ore');
    if (blockType === 'nether_gold_ore')
        blocktypes.push('gold_ore', 'deepslate_gold_ore');
    if (blockType === 'quartz' || blockType === 'quartz_ore' || blockType === 'nether_quartz_ore')
        blocktypes.push('nether_quartz_ore');
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    // Block-family expansion: if the requested type belongs to a known family
    // (e.g., oak_log -> all log types), expand so the bot finds whichever
    // variant exists in the current biome. Prevents the LLM from looping on
    // a specific wood type that doesn't grow here.
    const familyExpanded = expandBlockFamily(blockType);
    if (familyExpanded.length > 1) {
        for (const variant of familyExpanded) {
            if (!blocktypes.includes(variant)) blocktypes.push(variant);
        }
    }
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    // Auto-replant: track tree base positions when collecting logs
    const LOG_TO_SAPLING = {
        'oak_log': 'oak_sapling', 'birch_log': 'birch_sapling',
        'spruce_log': 'spruce_sapling', 'dark_oak_log': 'dark_oak_sapling',
        'jungle_log': 'jungle_sapling', 'acacia_log': 'acacia_sapling',
        'mangrove_log': 'mangrove_propagule', 'cherry_log': 'cherry_sapling',
        'pale_oak_log': 'pale_oak_sapling',
    };
    const isLog = Object.keys(LOG_TO_SAPLING).some(l => blocktypes.includes(l));
    const treeBasePositions = []; // store {x, y, z, saplingType}

    const movements = createMovements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }

            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 8);

        // #7 ProtectedZone enforcement: filter out any candidates inside a
        // protected zone (spawn / manual structure / auto-detected village).
        // Without this, collectBlock would dig grass_block/dirt/ore in spawn
        // via bot.dig or bot.collectBlock.collect — both bypass breakBlockAt.
        // Regression observed 2026-04-15: bot broke grass_block in spawn.
        const totalFound = blocks.length;
        blocks = blocks.filter(b => {
            const p = b.position || b;
            return !_isInAnyProtectedZone(bot, p.x, p.y, p.z);
        });
        const filtered = totalFound - blocks.length;
        if (filtered > 0) {
            console.log(`[ProtectedZone] collectBlock filtered ${filtered} candidate ${blockType} block(s) inside protected zones`);
        }

        if (blocks.length === 0) {
            if (totalFound > 0 && filtered === totalFound) {
                // All candidates were in protected zones — actionable error for the
                // LLM. Wording matches the AutoRecovery `inside_protected_zone`
                // regex so the bot will auto-escape the nearest zone and retry.
                log(bot, `All ${totalFound} nearby ${blockType} are inside protected zones (near spawn, protected structure, or village). Move further away and try again.`);
            } else if (collected === 0) {
                log(bot, `No ${blockType} nearby to collect.`);
            } else {
                log(bot, `No more ${blockType} nearby to collect.`);
            }
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}. You need a pickaxe for stone/ore, axe for wood goes faster. Craft wooden tools first: collect logs → craft planks → craft sticks → craft wooden_pickaxe.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await _equipBestToolFor(bot, block);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success) {
                collected++;
                // Track tree base: record the lowest Y position we chopped at
                if (isLog && block) {
                    const saplingType = LOG_TO_SAPLING[block.name] || LOG_TO_SAPLING[blockType];
                    if (saplingType) {
                        // Only record if this is the lowest log at this x,z (the stump)
                        const existing = treeBasePositions.find(p => p.x === block.position.x && p.z === block.position.z);
                        if (!existing || block.position.y < existing.y) {
                            if (existing) {
                                existing.y = block.position.y;
                            } else {
                                treeBasePositions.push({
                                    x: block.position.x,
                                    y: block.position.y,
                                    z: block.position.z,
                                    saplingType
                                });
                            }
                        }
                    }
                }
            }
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                const currentGoal = bot._goalHint || null;
                const { message: discardHint } = getDiscardSuggestions(bot, 5, currentGoal);
                log(bot, `Failed to collect ${blockType}: Inventory full. ${discardHint}`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }

        if (bot.interrupt_code)
            break;
    }
    log(bot, `Collected ${collected} ${blockType}.`);

    // Auto-replant saplings at tree base positions
    if (isLog && treeBasePositions.length > 0 && collected > 0) {
        let replanted = 0;
        for (const base of treeBasePositions) {
            try {
                const saplingItem = bot.inventory.findInventoryItem(base.saplingType);
                if (!saplingItem) break; // no saplings left

                // Check if the block at the base is now air (tree was fully chopped)
                const baseBlock = bot.blockAt(new Vec3(base.x, base.y, base.z));
                if (baseBlock && baseBlock.name === 'air') {
                    // Check the block below is solid (dirt/grass)
                    const belowBlock = bot.blockAt(new Vec3(base.x, base.y - 1, base.z));
                    if (belowBlock && (belowBlock.name === 'dirt' || belowBlock.name === 'grass_block' ||
                        belowBlock.name === 'podzol' || belowBlock.name === 'mud' ||
                        belowBlock.name === 'rooted_dirt' || belowBlock.name === 'coarse_dirt' ||
                        belowBlock.name === 'mycelium' || belowBlock.name === 'moss_block')) {
                        await placeBlock(bot, base.saplingType, base.x, base.y, base.z);
                        replanted++;
                    }
                }
            } catch (e) {
                // Replanting failed, not critical — just skip
            }
        }
        if (replanted > 0) {
            log(bot, `Replanted ${replanted} ${treeBasePositions[0]?.saplingType || 'sapling'}(s) where trees were chopped.`);
        }
    }

    return collected > 0;
}

export const collectBlock = wrapSkill('collectBlock', _impl_collectBlock);

// ---------------------------------------------------------------------------
// pickupNearbyItems
// ---------------------------------------------------------------------------

async function _impl_pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        // OPT-C: no local Movements setup — goToGoal() unconditionally calls
        // bot.pathfinder.setMovements(final_movements) with its own safe factory
        // build (non-destructive first, destructive fallback), so any Movements
        // object set here is immediately overridden. canDig=false intent is
        // already satisfied by goToGoal's non-destructive-first strategy.
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}

export const pickupNearbyItems = wrapSkill('pickupNearbyItems', _impl_pickupNearbyItems);

// ---------------------------------------------------------------------------
// breakBlockAt
// ---------------------------------------------------------------------------

async function _impl_breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    const breakZone = _isInAnyProtectedZone(bot, x, y, z);
    if (breakZone) {
        const label = breakZone.type === 'spawn' ? 'spawn' : `protected structure '${breakZone.name}'`;
        // L1.4-wire BT 2: allowlisted ops (e.g. tillAndSow) pass through.
        if (bot._allowProtectedZoneOps && PROTECTED_ZONE_ALLOWLIST.has(bot._allowProtectedZoneOps)) {
            console.log(`[ProtectedZone] Bypassed break at (${x}, ${y}, ${z}) inside ${breakZone.radius}-block ${label} — allowlist: ${bot._allowProtectedZoneOps}`);
        } else {
            console.log(`[ProtectedZone] Blocked break at (${x}, ${y}, ${z}) — inside ${breakZone.radius}-block ${label}`);
            log(bot, `Cannot break blocks near ${label} (within ${breakZone.radius} blocks). Move further away first.`);
            return false;
        }
    }
    let block = bot.blockAt(new Vec3(x, y, z));
    if (!block) {
        console.log(`[Skills] breakBlockAt: chunk not loaded at (${x}, ${y}, ${z}), waiting...`);
        await bot.waitForChunksToLoad();
        block = bot.blockAt(new Vec3(x, y, z));
        if (!block) {
            console.log(`[Skills] breakBlockAt: still null after chunk wait at (${x}, ${y}, ${z})`);
            log(bot, `Block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} unavailable after waiting for chunks.`);
            return false;
        }
    }
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = createMovements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}. Craft a pickaxe first: collect logs → !craftRecipe("oak_planks", 1) → !craftRecipe("stick", 1) → !craftRecipe("wooden_pickaxe", 1).`);
                return false;
            }
        }
        console.log(`[Skills] breakBlockAt: digging ${block.name} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
        await _equipBestToolFor(bot, block);
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}
export const breakBlockAt = wrapSkill('breakBlockAt', _impl_breakBlockAt);

// ---------------------------------------------------------------------------
// placeBlock
// ---------------------------------------------------------------------------

async function _impl_placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    // BT-7b (2026-04-19): mark intent so placement_tracker can distinguish
    // LLM-driven !placeBlock calls (intentional — never cleaned up) from
    // pathfinder scaffolding / confusion placements (unknown-llm — eligible).
    // Flag is cleared in finally to survive all return paths and any throw.
    bot._placeIntent = 'intentional';
    try {
    const placeZone = _isInAnyProtectedZone(bot, x, y, z);
    if (placeZone) {
        const label = placeZone.type === 'spawn' ? 'spawn' : `protected structure '${placeZone.name}'`;
        // L1.4-wire BT 2: allowlisted ops (e.g. tillAndSow) pass through.
        if (bot._allowProtectedZoneOps && PROTECTED_ZONE_ALLOWLIST.has(bot._allowProtectedZoneOps)) {
            console.log(`[ProtectedZone] Bypassed place at (${x}, ${y}, ${z}) inside ${placeZone.radius}-block ${label} — allowlist: ${bot._allowProtectedZoneOps}`);
        } else {
            console.log(`[ProtectedZone] Blocked place at (${x}, ${y}, ${z}) — inside ${placeZone.radius}-block ${label}`);
            log(bot, `Cannot place blocks near ${label} (within ${placeZone.radius} blocks). Move further away first.`);
            return false;
        }
    }
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    let targetBlock = bot.blockAt(target_dest);
    if (!targetBlock) {
        console.log(`[Skills] placeBlock: chunk not loaded at ${target_dest}, waiting...`);
        await bot.waitForChunksToLoad();
        targetBlock = bot.blockAt(target_dest);
        if (!targetBlock) {
            log(bot, `Block at ${target_dest} unavailable after waiting for chunks.`);
            return false;
        }
    }
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': new Vec3(0, 1, 0),
        'bottom': new Vec3(0, -1, 0),
        'north': new Vec3(0, 0, -1),
        'south': new Vec3(0, 0, 1),
        'east': new Vec3(1, 0, 0),
        'west': new Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        let block = bot.blockAt(target_dest.plus(d));
        if (!block) {
            await bot.waitForChunksToLoad();
            block = bot.blockAt(target_dest.plus(d));
        }
        if (block && !empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(new Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail',
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(createMovements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
    } finally {
        // BT-7b: clear the intent flag on every exit path so the next
        // blockPlaced event (if it wasn't ours) doesn't inherit it.
        bot._placeIntent = null;
    }
}

export const placeBlock = wrapSkill('placeBlock', _impl_placeBlock);

// ---------------------------------------------------------------------------
// autoBreakStuckPlant
// ---------------------------------------------------------------------------

async function _impl_autoBreakStuckPlant(bot) {
    return await withBotLock('autoBreakStuckPlant', async () => {
        // Per-block failure blacklist (Bug C fix 2026-04-15). When a dig
        // throws (e.g. mode preemption / pathfinder race), don't immediately
        // retry the same block on the next invocation — try a different
        // neighbor instead. 30s cooldown gives modes time to finish and
        // the bot may have moved anyway.
        if (!bot._autoBreakBlacklist) bot._autoBreakBlacklist = new Map();
        const now = Date.now();
        // Prune expired entries
        for (const [key, until] of bot._autoBreakBlacklist) {
            if (until <= now) bot._autoBreakBlacklist.delete(key);
        }

        const pos = bot.entity.position.floored();
        // Neighbors at four Y layers relative to the bot:
        //   dy=-1 (below feet)  — catches bot standing on a tree canopy
        //                          whose only escape is to break the leaves
        //                          under it and drop (#29, motivated by the
        //                          2026-04-19 tree-top spawn stranding).
        //   dy= 0 (feet level)  — original 8 horizontal neighbors.
        //   dy= 1 (head level)  — original 8 horizontal neighbors.
        //   dy= 2 (above head)  — catches bot stuck under a low leaf ceiling.
        // SOLID_GROUND_BLOCKS hard-skip covers the "standing on dirt" case
        // so dy=-1 on a grass_block / dirt / stone returns before the
        // plant-check. Zone-aware allowlist (shipped d051ab1) ensures
        // structural tree parts (logs/wood) remain protected inside zones.
        const offsets = [
            // Below feet (dy=-1) — including directly below (the block
            // the bot is standing on).
            [0, -1, 0],
            [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
            [1, -1, 1], [1, -1, -1], [-1, -1, 1], [-1, -1, -1],
            // Feet level (dy=0).
            [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
            [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
            // Head level (dy=1).
            [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
            [1, 1, 1], [1, 1, -1], [-1, 1, 1], [-1, 1, -1],
            // Above head (dy=2) — including directly above.
            [0, 2, 0],
            [1, 2, 0], [-1, 2, 0], [0, 2, 1], [0, 2, -1],
            [1, 2, 1], [1, 2, -1], [-1, 2, 1], [-1, 2, -1],
        ];
        for (const [dx, dy, dz] of offsets) {
            const p = pos.offset(dx, dy, dz);
            const block = bot.blockAt(p);
            if (!block) continue;

            // Hard skip for solid-terrain blocks (Bug A fix)
            if (SOLID_GROUND_BLOCKS.has(block.name)) continue;

            // Check per-block cooldown from prior failures (Bug C fix)
            const blacklistKey = `${p.x},${p.y},${p.z}`;
            const cooldownUntil = bot._autoBreakBlacklist.get(blacklistKey);
            if (cooldownUntil && cooldownUntil > now) continue;

            const isPlant = PLANT_LIKE_PATTERN.test(block.name);
            const isTreePart = TREE_PART_PATTERN.test(block.name);

            // Only consider plant-like, tree-part, or known movement-blocking
            // blocks as unstick candidates. The MOVEMENT_BLOCKING_PLANTS check
            // catches blocks like mangrove_roots that don't match either pattern.
            if (!isPlant && !isTreePart && !MOVEMENT_BLOCKING_PLANTS.has(block.name)) continue;
            if (_isDangerous(block.name)) continue;

            // Protected-zone check: only break blocks that actually impede
            // movement. Passable plants (grass, flowers, ferns, etc.) are
            // left untouched. Tree structural blocks (logs, wood) always skipped.
            const breakZone = _isInAnyProtectedZone(bot, p.x, p.y, p.z);
            if (breakZone) {
                const label = breakZone.type === 'spawn' ? 'spawn zone' : `protected structure '${breakZone.name}'`;
                if (isTreePart) {
                    console.log(`[AutoBreakPlant] ${block.name} at (${p.x}, ${p.y}, ${p.z}) is a tree part inside ${label} — skipping`);
                    continue;
                }
                if (!MOVEMENT_BLOCKING_PLANTS.has(block.name)) {
                    // Passable plant — bot can walk through it, no need to break
                    continue;
                }
                console.log(`[AutoBreakPlant] Breaking movement-blocking ${block.name} inside ${label} at (${p.x}, ${p.y}, ${p.z})`);
            } else {
                // Outside spawn — break either plant or tree part
                console.log(`[AutoBreakPlant] Breaking ${block.name} at (${p.x}, ${p.y}, ${p.z}) to free movement`);
            }

            try {
                await _equipBestToolFor(bot, block);
                await bot.dig(block);
                return true;
            } catch (err) {
                console.warn(`[AutoBreakPlant] Failed to break ${block.name} at (${p.x}, ${p.y}, ${p.z}): ${err.message} — blacklisting for 30s`);
                bot._autoBreakBlacklist.set(blacklistKey, now + 30000);
            }
        }
        return false;
    });
}
export const autoBreakStuckPlant = wrapSkill('autoBreakStuckPlant', _impl_autoBreakStuckPlant);
