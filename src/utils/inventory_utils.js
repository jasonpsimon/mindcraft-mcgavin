import { safeToss } from '../agent/library/skills.js';

/**
 * Smart inventory management utilities.
 * Scores items by value and identifies junk to discard.
 * Goal-aware: protects items relevant to the current objective.
 */

// Cooldown after discarding to prevent the bot from picking items back up
let lastDiscardTime = 0;
const DISCARD_COOLDOWN_MS = 60000; // 60 seconds — gives bot plenty of time to move on

export function markDiscarded() {
    lastDiscardTime = Date.now();
}

export function isDiscardCooldownActive() {
    return (Date.now() - lastDiscardTime) < DISCARD_COOLDOWN_MS;
}


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

// Goal keyword → items that become protected when that keyword is in the goal
const GOAL_ITEM_MAP = {
    // Building materials
    'build': ['cobblestone', 'stone', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'glass', 'brick', 'sandstone'],
    'house': ['cobblestone', 'stone', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'glass', 'oak_door', 'oak_fence'],
    'shelter': ['cobblestone', 'stone', 'oak_planks', 'oak_log', 'dirt'],
    'stone': ['cobblestone', 'stone', 'smooth_stone', 'andesite', 'diorite', 'granite'],
    'wall': ['cobblestone', 'stone', 'deepslate', 'cobbled_deepslate', 'brick'],
    'bridge': ['cobblestone', 'stone', 'oak_planks'],
    'tower': ['cobblestone', 'stone', 'oak_planks', 'ladder'],
    'castle': ['cobblestone', 'stone', 'stone_bricks', 'deepslate', 'cobbled_deepslate'],
    'farm': ['dirt', 'wheat', 'wheat_seeds', 'bone_meal', 'oak_fence', 'water_bucket'],
    'garden': ['dirt', 'grass_block', 'flower_pot', 'bone_meal'],

    // Nether
    'nether': ['cobblestone', 'netherrack', 'blackstone', 'basalt', 'obsidian', 'flint_and_steel', 'gold_ingot'],
    'portal': ['obsidian', 'flint_and_steel'],
    'blaze': ['netherrack', 'cobblestone'],
    'fortress': ['netherrack', 'cobblestone'],

    // Combat & survival
    'fight': ['arrow', 'string', 'bone', 'gunpowder', 'flint'],
    'combat': ['arrow', 'string', 'bone', 'gunpowder', 'flint'],
    'survive': ['coal', 'torch', 'cooked_beef', 'cooked_porkchop', 'bread', 'cobblestone'],
    'food': ['wheat', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'egg'],
    'cook': ['coal', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton'],

    // Crafting & tools
    'craft': ['oak_planks', 'stick', 'oak_log', 'cobblestone', 'iron_ingot'],
    'tool': ['oak_planks', 'stick', 'oak_log', 'cobblestone', 'iron_ingot', 'diamond'],
    'pickaxe': ['oak_planks', 'stick', 'oak_log', 'cobblestone', 'iron_ingot', 'diamond'],
    'sword': ['oak_planks', 'stick', 'oak_log', 'cobblestone', 'iron_ingot', 'diamond'],
    'armor': ['iron_ingot', 'diamond', 'leather', 'gold_ingot'],
    'smelt': ['coal', 'charcoal', 'raw_iron', 'raw_gold', 'raw_copper', 'cobblestone'],
    'furnace': ['cobblestone', 'coal', 'charcoal'],

    // Mining
    'mine': ['torch', 'coal', 'cobblestone', 'oak_planks', 'stick'],
    'diamond': ['iron_ingot', 'torch', 'coal', 'cobblestone', 'oak_planks', 'stick', 'water_bucket'],
    'iron': ['cobblestone', 'coal', 'torch', 'stick', 'oak_planks'],

    // Redstone
    'redstone': ['redstone', 'cobblestone', 'stick', 'torch'],
    'piston': ['cobblestone', 'redstone', 'iron_ingot', 'oak_planks'],

    // Decoration
    'decorate': ['flower_pot', 'amethyst_block', 'calcite', 'dripstone_block'],
};

/**
 * Get the set of items protected by the current goal.
 * @param {string|null} goal - The bot's current goal text
 * @returns {Set<string>} Items that should not be discarded
 */
function getGoalProtectedItems(goal) {
    const protectedItems = new Set();
    if (!goal) return protectedItems;

    const goalLower = goal.toLowerCase();
    for (const [keyword, items] of Object.entries(GOAL_ITEM_MAP)) {
        if (goalLower.includes(keyword)) {
            for (const item of items) {
                protectedItems.add(item);
            }
        }
    }
    return protectedItems;
}

// Lower score = more discardable
function getItemValue(itemName, goalProtected = new Set()) {
    // If the goal needs this item, bump it to "valuable"
    if (goalProtected.has(itemName)) return 4;

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
 * @param {string|null} goal - The bot's current goal (to protect relevant items)
 * @returns {{ suggestions: Array<{name: string, count: number, value: number}>, message: string }}
 */
export function getDiscardSuggestions(bot, slotsNeeded = 5, goal = null) {
    const goalProtected = getGoalProtectedItems(goal);

    const inventory = {};
    for (const slot of bot.inventory.slots) {
        if (slot != null && slot.name) {
            if (!inventory[slot.name]) inventory[slot.name] = 0;
            inventory[slot.name] += slot.count;
        }
    }

    // Score and sort: lowest value first, then highest count
    const scored = Object.entries(inventory)
        .map(([name, count]) => ({ name, count, value: getItemValue(name, goalProtected) }))
        .filter(item => item.value < 5) // never suggest protected items
        .sort((a, b) => a.value - b.value || b.count - a.count);

    // Pick enough items to free the needed slots
    const suggestions = [];
    let freedSlots = 0;
    for (const item of scored) {
        if (freedSlots >= slotsNeeded) break;
        suggestions.push(item);
        freedSlots += Math.ceil(item.count / 64);
    }

    // Build an LLM-readable message
    const cmds = suggestions
        .slice(0, 3)
        .map(s => `!discard("${s.name}", ${s.count})`)
        .join(', then ');

    let message = '';
    if (suggestions.length > 0) {
        message = `To free inventory space, discard junk items: ${cmds}`;
        if (goalProtected.size > 0) {
            const kept = [...goalProtected].filter(i => inventory[i]).slice(0, 3).join(', ');
            if (kept) message += ` (keeping ${kept} — needed for your goal)`;
        }
    } else {
        message = 'No obvious junk items to discard. Consider dropping your least needed items.';
    }

    return { suggestions, message };
}

/**
 * Auto-discard the lowest-value items to free up inventory space.
 * @param {object} bot - The mineflayer bot
 * @param {number} slotsNeeded - How many slots to free
 * @param {string|null} goal - The bot's current goal (to protect relevant items)
 * @returns {Promise<string>} Description of what was discarded
 */
export async function autoDiscard(bot, slotsNeeded = 5, goal = null) {
    const { suggestions } = getDiscardSuggestions(bot, slotsNeeded, goal);
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
                await safeToss(bot, found.type, null, toDrop);
                remaining -= toDrop;
            }
            discarded.push(`${item.count} ${item.name}`);
            markDiscarded();
        } catch (e) {
            // Skip items that fail to discard
        }
    }

    return discarded.length > 0
        ? `Auto-discarded: ${discarded.join(', ')}. Freed ${discarded.length} inventory slot(s).`
        : 'Failed to auto-discard items.';
}

