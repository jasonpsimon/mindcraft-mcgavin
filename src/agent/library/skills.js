import { readFileSync, existsSync } from 'fs';
import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../utils/inventory_utils.js';
import { withBotLock, botMutex } from '../bot_mutex.js';
import { wrapSkill } from '../../observability/skill_lifecycle.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

// Block-family equivalence: when the LLM requests a specific variant but any
// member of the family would satisfy the goal, expand the search to all members.
// Prevents loops where the bot asks for "oak_log" in a biome with only spruce.
// Add new families as needed — each key is a family name; value is the full member list.
const BLOCK_FAMILIES = {
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
function expandBlockFamily(blockType) {
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

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    // BT-10i (2026-04-19): durability filter. Drop weapons at <5% remaining
    // durability before the attackDamage sort so we don't pick a sword that
    // shatters mid-swing and leaves the bot empty-handed. Fall back to the
    // unfiltered list if filtering removes every candidate — better to
    // swing a near-broken weapon than fists. mineflayer exposes item wear
    // via `item.durabilityUsed` (0 = pristine); max comes from
    // `item.maxDurability` when present, else infer from item stats.
    const _healthy = weapons.filter(w => {
        const max = w.maxDurability;
        if (!max || typeof w.durabilityUsed !== 'number') return true;  // unknown — assume fine
        return (max - w.durabilityUsed) / max >= 0.05;
    });
    if (_healthy.length > 0) weapons = _healthy;
    // Bug fix 2026-04-15: previous comparator returned a boolean (a < b), which
    // is treated as 0 by sort and produced random ordering. Use proper b-a for
    // descending sort by attackDamage. Also handle missing attackDamage values.
    weapons.sort((a, b) => (b.attackDamage || 0) - (a.attackDamage || 0));
    let weapon = weapons[0];
    if (weapon && bot.heldItem?.type !== weapon.type)
        await bot.equip(weapon, 'hand');
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
async function _equipBestToolFor(bot, block) {
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

async function _impl_craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        const missingItems = Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ');
        const emptySlots = bot.inventory.emptySlotCount();
        let hint = `You do not have the resources to craft a ${itemName}. It requires: ${missingItems}.`;
        if (emptySlots === 0) {
            const currentGoal = bot._goalHint || null;
            const { message: discardAdvice } = getDiscardSuggestions(bot, 5, currentGoal);
            hint += ` Your inventory is FULL (0 empty slots). ${discardAdvice} Then use !collectBlocks to gather what you need.`;
        } else {
            hint += ` Use !collectBlocks to gather the missing items.`;
        }
        log(bot, hint);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export const craftRecipe = wrapSkill('craftRecipe', _impl_craftRecipe);

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

async function _impl_smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export const smeltItem = wrapSkill('smeltItem', _impl_smeltItem);

async function _impl_clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}
export const clearNearestFurnace = wrapSkill('clearNearestFurnace', _impl_clearNearestFurnace);


async function _impl_attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}
export const attackNearest = wrapSkill('attackNearest', _impl_attackNearest);

async function _impl_attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}
export const attackEntity = wrapSkill('attackEntity', _impl_attackEntity);

async function _impl_defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    // OPT-I (2026-04-19): pause modes so defendSelf doesn't re-enter via
    // self_defense while we're already fighting. The try/finally guarantees
    // unpause on every exit path (normal return, early `interrupt_code` return,
    // or a thrown error) — the modes controller only auto-unpauses when the
    // agent is idle, and during an active goal the agent is never idle, so
    // without this the mode stays paused for the rest of the goal's runtime
    // (bot hits mob once, then can't re-engage, dies silently).
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    try {
        // BT-10i (2026-04-19): shield to offhand once, before the fight loop.
        // Mineflayer's pvp blocks with shield when offhand-equipped; equipping
        // per-iteration would be wasteful and would re-trigger every 500ms.
        // Errors logged + swallowed (same policy as _equipBestToolFor) —
        // if equip fails for any reason, combat continues without shield.
        try {
            const _shield = bot.inventory.items().find(it => it.name === 'shield');
            const _offhand = bot.inventory.slots[45];  // offhand slot in mineflayer
            if (_shield && _offhand?.type !== _shield.type) {
                await bot.equip(_shield, 'off-hand');
            }
        } catch (_equipErr) {
            console.warn(`[defendSelf] shield equip skipped: ${_equipErr.message}`);
        }
        let attacked = false;
        let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        while (enemy) {
            await equipHighestAttack(bot);
            if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
                try {
                    bot.pathfinder.setMovements(createMovements(bot));
                    await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
                } catch (err) {/* might error if entity dies, ignore */}
            }
            if (bot.entity.position.distanceTo(enemy.position) <= 2) {
                try {
                    bot.pathfinder.setMovements(createMovements(bot));
                    let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                    await bot.pathfinder.goto(inverted_goal, true);
                } catch (err) {/* might error if entity dies, ignore */}
            }
            bot.pvp.attack(enemy);
            attacked = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        bot.pvp.stop();
        if (attacked)
            log(bot, `Successfully defended self.`);
        else
            log(bot, `No enemies nearby to defend self from.`);
        return attacked;
    } finally {
        bot.modes.unpause('self_defense');
        bot.modes.unpause('cowardice');
    }
}
export const defendSelf = wrapSkill('defendSelf', _impl_defendSelf);



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
        let movements = createMovements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
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
        console.log(`[ProtectedZone] Blocked break at (${x}, ${y}, ${z}) — inside ${breakZone.radius}-block ${label}`);
        log(bot, `Cannot break blocks near ${label} (within ${breakZone.radius} blocks). Move further away first.`);
        return false;
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
        console.log(`[ProtectedZone] Blocked place at (${x}, ${y}, ${z}) — inside ${placeZone.radius}-block ${label}`);
        log(bot, `Cannot place blocks near ${label} (within ${placeZone.radius} blocks). Move further away first.`);
        return false;
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

// === BT-25 (2026-04-19): durability-aware armor replacement ===
// Used by the `!addRule(...armor/durability...)` dispatch case in
// actions.js. Reactive: scans equipped armor slots, swaps in a same-or-
// better-tier replacement from inventory, falls back to crafting the
// same tier if inventory has nothing usable. Re-entry throttled because
// the rule fires every self-prompter iteration.

const ARMOR_TIERS = { leather: 1, chainmail: 2, iron: 3, golden: 4, diamond: 5, netherite: 6 };
const ARMOR_PIECES = [
    { slot: 5, bodyPart: 'head',  suffix: 'helmet' },
    { slot: 6, bodyPart: 'torso', suffix: 'chestplate' },
    { slot: 7, bodyPart: 'legs',  suffix: 'leggings' },
    { slot: 8, bodyPart: 'feet',  suffix: 'boots' },
];

function _armorTier(itemName) {
    if (!itemName) return 0;
    for (const [prefix, rank] of Object.entries(ARMOR_TIERS)) {
        if (itemName.startsWith(prefix + '_')) return rank;
    }
    return 0;
}

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
        let bestRank = 0;
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
        if (equippedTier > 0) {
            const tierName = Object.entries(ARMOR_TIERS).find(([, r]) => r === equippedTier)?.[0];
            if (!tierName) continue;
            const craftName = `${tierName}_${piece.suffix}`;
            log(bot, `[ReplaceArmor] No spare ${piece.suffix} in inventory — attempting to craft ${craftName}`);
            try {
                await _impl_craftRecipe(bot, craftName, 1);
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


/**
 * Check if a position is within the spawn protection zone.
 * Returns true if the position is within SPAWN_RADIUS blocks of world spawn (XZ only).
 */
const SPAWN_PROTECTION_RADIUS = 250;
const SPAWN_ESCAPE_DISTANCE = 375;  // walk to this distance from spawn on escape (50% buffer past 250-block protection)
function _isInSpawnZone(bot, x, z) {
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
function _isNearProtectedZone(bot, x, y, z) {
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

function _isInAnyProtectedZone(bot, x, y, z) {
    // Spawn zone is Y-agnostic by design — it gates the new-player wilderness
    // regardless of depth. No y check here.
    if (_isInSpawnZone(bot, x, z)) return { type: 'spawn', radius: SPAWN_PROTECTION_RADIUS };
    const structure = _isNearProtectedZone(bot, x, y, z);
    if (structure) return { type: structure.type || 'structure', name: structure.name, radius: structure.radius };
    return null;
}

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

/**
 * Mutate the mineflayer-collectblock plugin's internal Movements instance
 * to use mindcraft-mcgavin's safer defaults instead of the plugin's
 * unconfigured defaults.
 *
 * WHY: when `!collectBlocks("X_ore", N)` targets a block below ground,
 * the plugin calls `bot.collectBlock.collect(block)` which uses its own
 * `Movements` object (created once at plugin init with pathfinder defaults:
 * maxDropDown=4, digCost=1, canDig=true, no terrain-safety config). With
 * cheap dig cost and permissive drops, pathfinder computes the shortest
 * path — a straight-down vertical shaft — as the cheapest route to the
 * ore. Visible result: the bot mines straight down, risking lava/caves
 * and disobeying the fork's "no straight-down digging" safety norm.
 *
 * FIX: mutate bot.collectBlock.movements in place so every future
 * collect() call uses our safer settings. The plugin resets
 * dontMineUnderFallingBlock and dontCreateFlow to false on each collect
 * (plugin source line ~192), but maxDropDown / digCost / canSwim /
 * terrain-safe config survive because the plugin doesn't touch them.
 *
 * Called once at agent startup from agent.js after loadPlayerStructures.
 *
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

export { detectNearbyPlayerStructures, startPlayerStructureScanner };


/**
 * Configure a pf.Movements instance for safer terrain traversal across biomes,
 * especially swamps, dripstone caves, nether, and other damage-prone terrain.
 * Non-destructive: mutates the Movements object in place.
 *
 * Rationale: mineflayer-pathfinder's default Movements already treats blocks
 * with empty boundingBox (grass, ferns, bushes, sugar_cane, vines, flowers,
 * propagules, hanging_roots, etc.) as walk-through, and already avoids fire +
 * cobweb + lava. We add additional damage-on-contact blocks so pathfinder
 * routes around them instead of through them.
 *
 * Solid blocks that require destruction (mangrove_roots, muddy_mangrove_roots)
 * are handled via destructive movements (pathfinder breaks them) + the
 * autoBreakStuckPlant helper when pathfinder can't find a path at all.
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
 * Attempt to unstick the bot by breaking an adjacent plant-type block.
 * Call this after pathfinder reports no path — often a single plant-like
 * block is blocking forward progress. Scans cardinal + diagonal neighbors
 * at feet and head height for names matching plant-like patterns, breaks
 * the first matching block found.
 *
 * Spawn protection nuance (per JP 2026-04-14):
 * - Inside the spawn protection zone: allowed to break only blocks that
 *   actually impede movement (sweet_berry_bush, vine, big_dripleaf,
 *   mangrove_roots, leaves) — see MOVEMENT_BLOCKING_PLANTS. Passable
 *   alter the spawn area.
 * - Inside the spawn protection zone: will NOT break TREES (anything with
 *   _log, _wood, _leaves, _sapling, propagule, _roots, _hyphae, _stem
 *   nether variants, bamboo_block, azalea variants) — landscape features
 *   that are intentional or player-placed.
 * - Outside the spawn zone: breaks any plant-pattern match (including
 *   mangrove roots for swamp traversal).
 *
 * General-purpose primitives breakBlockAt / placeBlock remain strict inside
 * spawn — this plant-specific exception is scoped to autoBreakStuckPlant.
 *
 * Player-structure protection (whiteboard item #7) should add an additional
 * guard here once implemented.
 *
 * Returns true if a block was broken (caller should retry their pathfind).
 */
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
 * Determine if the bot is underground by counting solid blocks around it.
 * Underground = 3+ of 4 cardinal neighbors at feet level are solid,
 * OR the bot is below Y=50 (deep enough to be in a mine shaft).
 */
function _isUnderground(bot, pos) {
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

/**
 * Check if a block name is dangerous (lava, water, bedrock).
 */
function _isDangerous(name) {
    return ['lava', 'water', 'bedrock', 'air', 'cave_air'].includes(name);
}

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

async function _impl_consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}
export const consume = wrapSkill('consume', _impl_consume);


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

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    const nonDestructiveMovements = createMovements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;
    nonDestructiveMovements.canSwim = true;     // pathfinder handles water as swimmable
    nonDestructiveMovements.maxDropDown = 3;     // vanilla no-damage limit (was default 4 = sometimes-fall-damage)
    // _configureTerrainSafeMovements already applied by createMovements factory

    // Bump pathfinder timeouts for complex underground terrain
    bot.pathfinder.thinkTimeout = 10000;  // 10s total (default 5s)
    bot.pathfinder.tickTimeout = 80;      // 80ms per tick (default 40ms)

    const pathfind_timeout = 4000;
    let final_movements;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else {
        // OPT-B: build destructiveMovements lazily — only when the non-destructive
        // path lookup fails. Saves one createMovements() + _configureTerrainSafeMovements()
        // pass on every call that finds a walkable path (the common case).
        const destructiveMovements = createMovements(bot);
        destructiveMovements.canSwim = true;         // pathfinder handles water as swimmable
        destructiveMovements.maxDropDown = 3;         // vanilla no-damage limit
        // _configureTerrainSafeMovements already applied by createMovements factory
        final_movements = destructiveMovements;
        if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
            log(bot, `Found destructive path.`);
        }
        else {
            log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
        }
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // Before giving up, try to auto-clear a plant-like obstacle and retry
        // ONCE. Handles common swamp/jungle stuck cases (mangrove propagule,
        // dense ferns, vines). autoBreakStuckPlant respects spawn protection.
        const errMsg = err?.message || '';
        const isStuckError = /Path was stopped|no path|goal was changed|could not be completed/i.test(errMsg);
        if (isStuckError) {
            try {
                const broke = await autoBreakStuckPlant(bot);
                if (broke) {
                    log(bot, `Broke a blocking plant and retrying path.`);
                    const retryInterval = startDoorInterval(bot);
                    try {
                        await bot.pathfinder.goto(goal);
                        clearInterval(retryInterval);
                        return true;
                    } catch (retryErr) {
                        clearInterval(retryInterval);
                        // Fall through — rethrow the original error with a note
                    }
                }
            } catch (breakErr) {
                console.warn(`[goToGoal] autoBreakStuckPlant failed: ${breakErr.message}`);
            }
        }
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

async function _impl_goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}
export const goToPosition = wrapSkill('goToPosition', _impl_goToPosition);

async function _impl_goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
        // Block-family fallback: if the specific type wasn't found, try all
        // family variants (e.g., oak_log miss -> try spruce_log, birch_log, ...).
        // Prevents the LLM from looping on a wood type absent in this biome.
        if (!block) {
            const variants = expandBlockFamily(blockType);
            if (variants.length > 1) {
                for (const variant of variants) {
                    if (variant === blockType) continue;
                    block = world.getNearestBlock(bot, variant, range);
                    if (block) {
                        log(bot, `No ${blockType} found — using ${variant} instead.`);
                        break;
                    }
                }
            }
        }
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export const goToNearestBlock = wrapSkill('goToNearestBlock', _impl_goToNearestBlock);

async function _impl_goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}
export const goToNearestEntity = wrapSkill('goToNearestEntity', _impl_goToNearestEntity);

async function _impl_goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}
export const goToPlayer = wrapSkill('goToPlayer', _impl_goToPlayer);


async function _impl_followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = createMovements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}
export const followPlayer = wrapSkill('followPlayer', _impl_followPlayer);


async function _impl_moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(createMovements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = createMovements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}
export const moveAway = wrapSkill('moveAway', _impl_moveAway);

async function _impl_moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(createMovements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}
export const moveAwayFromEntity = wrapSkill('moveAwayFromEntity', _impl_moveAwayFromEntity);

async function _impl_avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(createMovements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}
export const avoidEnemies = wrapSkill('avoidEnemies', _impl_avoidEnemies);

async function _impl_stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}
export const stay = wrapSkill('stay', _impl_stay);

async function _impl_useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = new Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    if (!door_block) {
        await bot.waitForChunksToLoad();
        door_block = bot.blockAt(door_pos);
        if (!door_block) {
            log(bot, `Door block unavailable after waiting for chunks.`);
            return false;
        }
    }
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}
export const useDoor = wrapSkill('useDoor', _impl_useDoor);

async function _impl_goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    let bed = bot.blockAt(loc);
    if (!bed) {
        await bot.waitForChunksToLoad();
        bed = bot.blockAt(loc);
        if (!bed) {
            log(bot, `Bed block unavailable after waiting for chunks.`);
            return false;
        }
    }
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}
export const goToBed = wrapSkill('goToBed', _impl_goToBed);

async function _impl_tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    if (!block) {
        await bot.waitForChunksToLoad();
        block = bot.blockAt(pos);
        if (!block) {
            log(bot, `Block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} unavailable after waiting for chunks.`);
            return false;
        }
    }
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (!above) {
        await bot.waitForChunksToLoad();
        above = bot.blockAt(new Vec3(x, y+1, z));
    }
    if (above && above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(createMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}
export const tillAndSow = wrapSkill('tillAndSow', _impl_tillAndSow);

async function _impl_activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(createMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}
export const activateNearestBlock = wrapSkill('activateNearestBlock', _impl_activateNearestBlock);

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
async function _impl_showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}
export const showVillagerTrades = wrapSkill('showVillagerTrades', _impl_showVillagerTrades);

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
async function _impl_tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}
export const tradeWithVillager = wrapSkill('tradeWithVillager', _impl_tradeWithVillager);

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
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

                // Verify walls are rock-type (not dirt/grass surface depressions)
                const rockTypes = new Set([
                    'stone', 'deepslate', 'granite', 'diorite', 'andesite',
                    'tuff', 'calcite', 'dripstone_block', 'cobblestone',
                    'cobbled_deepslate', 'basalt', 'blackstone', 'netherrack',
                    'sandstone', 'red_sandstone', 'smooth_basalt',
                ]);
                let rockWalls = 0;
                const wallChecks = [
                    checkPos.offset(1, 0, 0), checkPos.offset(-1, 0, 0),
                    checkPos.offset(0, 0, 1), checkPos.offset(0, 0, -1),
                ];
                for (const wc of wallChecks) {
                    const wb = bot.blockAt(wc);
                    if (wb && rockTypes.has(wb.name)) rockWalls++;
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

    // Get the bot's facing direction (snapped to nearest cardinal)
    const yaw = bot.entity.yaw;
    // Minecraft yaw: 0 = south (+Z), pi/2 = west (-X), pi = north (-Z), 3pi/2 = east (+X)
    let dx = 0, dz = 0;
    const normalized = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    if (normalized >= 5.5 || normalized < 0.785) {
        dz = 1;  // south
    } else if (normalized >= 0.785 && normalized < 2.356) {
        dx = -1; // west
    } else if (normalized >= 2.356 && normalized < 3.927) {
        dz = -1; // north
    } else {
        dx = 1;  // east
    }

    let currentPos = bot.entity.position.floored();
    let descended = 0;
    const dirName = dz === 1 ? 'south' : dz === -1 ? 'north' : dx === -1 ? 'west' : 'east';
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
        // Whiteboard #6 asked for strict "left wall" placement; this behind-bot
        // variant is simpler and visible from both directions. Can refine later
        // if JP wants strict left-wall convention.
        // Threshold was 8 originally; lowered to 4 after observed typical
        // digDown(5) never triggered a placement.
        if (descended > 0 && descended % 4 === 0) {
            const torchX = currentPos.x - dx;
            const torchY = currentPos.y + 1;
            const torchZ = currentPos.z - dz;
            try {
                await placeTorchAt(bot, torchX, torchY, torchZ, 'bottom');
            } catch (torchErr) {
                console.warn(`[digDown] Torch placement at (${torchX}, ${torchY}, ${torchZ}) failed: ${torchErr.message}`);
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

    // Get the bot's facing direction (snapped to nearest cardinal)
    const yaw = bot.entity.yaw;
    let dx = 0, dz = 0;
    const normalized = ((yaw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    if (normalized >= 5.5 || normalized < 0.785) {
        dz = 1;  // south
    } else if (normalized >= 0.785 && normalized < 2.356) {
        dx = -1; // west
    } else if (normalized >= 2.356 && normalized < 3.927) {
        dz = -1; // north
    } else {
        dx = 1;  // east
    }

    let currentPos = bot.entity.position.floored();
    let ascended = 0;
    const dirName = dz === 1 ? 'south' : dz === -1 ? 'north' : dx === -1 ? 'west' : 'east';
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

async function _impl_useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }
export const useToolOn = wrapSkill('useToolOn', _impl_useToolOn);

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

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












