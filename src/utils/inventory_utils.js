/**
 * Smart inventory management utilities.
 * Scores items by value and identifies junk to discard.
 */

// Items the bot should NEVER discard (high value)
const KEEP_ALWAYS = new Set([
    // Tools & weapons
    'diamond_sword', 'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe',
    'iron_sword', 'iron_pickaxe', 'iron_axe', 'iron_shovel',
    'stone_sword', 'stone_pickaxe', 'stone_axe', 'stone_shovel',
    'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel',
    'netherite_sword', 'netherite_pickaxe', 'netherite_axe', 'netherite_shovel',
    'bow', 'crossbow', 'shield', 'fishing_rod', 'flint_and_steel',
    // Armor
    'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
    'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
    'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
    'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots',
    // Precious resources
    'diamond', 'emerald', 'gold_ingot', 'iron_ingot', 'raw_iron', 'raw_gold',
    'lapis_lazuli', 'redstone', 'ender_pearl', 'blaze_rod', 'nether_star',
    // Utility items
    'crafting_table', 'furnace', 'chest', 'bucket', 'water_bucket', 'lava_bucket',
    'torch', 'bed', 'red_bed', 'cyan_bed',
]);

// Items that are almost always safe to discard (low value / bulk junk)
// Lower score = more discardable
function getItemValue(itemName) {
    // Tier 0: Trash — discard first
    if ([
        'rotten_flesh', 'poisonous_potato', 'spider_eye',
    ].includes(itemName)) return 0;

    // Tier 1: Bulk stone & common blocks — usually junk
    if ([
        'cobblestone', 'andesite', 'diorite', 'granite', 'tuff',
        'cobbled_deepslate', 'deepslate', 'netherrack', 'basalt', 'smooth_basalt',
        'blackstone', 'dirt', 'gravel', 'sand', 'mud', 'clay_ball',
        'dripstone_block', 'calcite', 'mossy_cobblestone',
    ].includes(itemName)) return 1;

    // Tier 2: Common drops & basic materials
    if ([
        'string', 'bone', 'arrow', 'gunpowder', 'feather', 'ink_sac',
        'egg', 'leather', 'flint', 'snowball', 'vine',
        'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling',
        'oak_leaves', 'flower_pot', 'oak_fence',
        'amethyst_block', 'amethyst_shard',
    ].includes(itemName)) return 2;

    // Tier 3: Useful but not critical
    if ([
        'oak_planks', 'birch_planks', 'spruce_planks', 'stick',
        'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'jungle_log',
        'coal', 'charcoal', 'wheat', 'bread',
        'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton',
        'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    ].includes(itemName)) return 3;

    // Tier 4: Valuable materials
    if ([
        'iron_ingot', 'raw_iron', 'gold_ingot', 'raw_gold',
        'redstone', 'lapis_lazuli', 'copper_ingot', 'raw_copper',
    ].includes(itemName)) return 4;

    // Tier 5: Never discard
    if (KEEP_ALWAYS.has(itemName)) return 5;

    // Default: medium value (unknown items get benefit of the doubt)
    return 2;
}

/**
 * Analyze inventory and return ranked discard suggestions.
 * @param {object} bot - The mineflayer bot
 * @param {number} slotsNeeded - How many slots we need to free up (default 5)
 * @returns {{ suggestions: Array<{name: string, count: number, value: number}>, message: string }}
 */
export function getDiscardSuggestions(bot, slotsNeeded = 5) {
    const inventory = {};
    for (const slot of bot.inventory.slots) {
        if (slot != null && slot.name) {
            if (!inventory[slot.name]) inventory[slot.name] = 0;
            inventory[slot.name] += slot.count;
        }
    }

    // Score and sort: lowest value first, then highest count
    const scored = Object.entries(inventory)
        .map(([name, count]) => ({ name, count, value: getItemValue(name) }))
        .filter(item => item.value < 5) // never suggest protected items
        .sort((a, b) => a.value - b.value || b.count - a.count);

    // Pick enough items to free the needed slots
    const suggestions = [];
    let freedSlots = 0;
    for (const item of scored) {
        if (freedSlots >= slotsNeeded) break;
        suggestions.push(item);
        // Each stack slot holds up to 64; discarding a full stack frees 1 slot
        freedSlots += Math.ceil(item.count / 64);
    }

    // Build a human-readable (LLM-readable) message
    const cmds = suggestions
        .slice(0, 3) // max 3 suggestions to avoid overwhelming the LLM
        .map(s => `!discard("${s.name}", ${s.count})`)
        .join(', then ');

    const message = suggestions.length > 0
        ? `To free inventory space, discard junk items: ${cmds}`
        : 'No obvious junk items to discard. Consider dropping your least needed items.';

    return { suggestions, message };
}

/**
 * Auto-discard the lowest-value items to free up inventory space.
 * @param {object} bot - The mineflayer bot
 * @param {number} slotsNeeded - How many slots to free
 * @returns {Promise<string>} Description of what was discarded
 */
export async function autoDiscard(bot, slotsNeeded = 5) {
    const { suggestions } = getDiscardSuggestions(bot, slotsNeeded);
    if (suggestions.length === 0) {
        return 'No junk items found to auto-discard.';
    }

    const discarded = [];
    for (const item of suggestions) {
        try {
            let remaining = item.count;
            while (remaining > 0) {
                const found = bot.inventory.findInventoryItem(item.name);
                if (!found) break;
                const toDrop = Math.min(remaining, found.count);
                await bot.toss(found.type, null, toDrop);
                remaining -= toDrop;
            }
            discarded.push(`${item.count} ${item.name}`);
        } catch (e) {
            // Skip items that fail to discard
        }
    }

    return discarded.length > 0
        ? `Auto-discarded: ${discarded.join(', ')}. Freed ${discarded.length} inventory slot(s).`
        : 'Failed to auto-discard items.';
}
