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


// Wood-type convenience lists. Covers every plank / log / sapling variant up
// through MC 1.21 (oak, birch, spruce, dark_oak, jungle, acacia, mangrove,
// cherry, bamboo, pale_oak). Mangrove uses "propagule" instead of "sapling".
const ALL_PLANKS = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks',
    'jungle_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks',
    'bamboo_planks', 'pale_oak_planks',
];
const ALL_LOGS = [
    'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log',
    'jungle_log', 'acacia_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
];
const ALL_SAPLINGS = [
    'oak_sapling', 'birch_sapling', 'spruce_sapling', 'dark_oak_sapling',
    'jungle_sapling', 'acacia_sapling', 'cherry_sapling', 'pale_oak_sapling',
    'mangrove_propagule',
];

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

// Goal keyword → items that become protected when that keyword is in the goal.
// Items already in KEEP_ALWAYS (crafting_table, furnace, chest, torch, buckets,
// bed, precious resources) are always protected regardless of goal — listing
// them here is explicit/defensive, not required.
const GOAL_ITEM_MAP = {
    // Building materials
    'build': ['cobblestone', 'stone', ...ALL_PLANKS, ...ALL_LOGS, 'glass', 'brick', 'sandstone', 'crafting_table'],
    'house': ['cobblestone', 'stone', ...ALL_PLANKS, ...ALL_LOGS, 'glass', 'oak_door', 'oak_fence', 'crafting_table', 'furnace', 'bed', 'torch'],
    'shelter': ['cobblestone', 'stone', ...ALL_PLANKS, ...ALL_LOGS, 'dirt', 'crafting_table', 'torch'],
    'stone': ['cobblestone', 'stone', 'smooth_stone', 'andesite', 'diorite', 'granite', 'tuff'],
    'wall': ['cobblestone', 'stone', 'deepslate', 'cobbled_deepslate', 'brick'],
    'bridge': ['cobblestone', 'stone', ...ALL_PLANKS],
    'tower': ['cobblestone', 'stone', ...ALL_PLANKS, 'ladder'],
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
    'survive': ['coal', 'torch', 'cooked_beef', 'cooked_porkchop', 'bread', 'cobblestone', 'crafting_table', 'furnace'],
    'food': ['wheat', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'egg', 'furnace'],
    'cook': ['coal', 'charcoal', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton', 'furnace'],

    // Crafting & tools
    'craft': [...ALL_PLANKS, 'stick', ...ALL_LOGS, 'cobblestone', 'iron_ingot', 'crafting_table'],
    'tool':  [...ALL_PLANKS, 'stick', ...ALL_LOGS, 'cobblestone', 'iron_ingot', 'diamond', 'crafting_table'],
    'pickaxe': [...ALL_PLANKS, 'stick', ...ALL_LOGS, 'cobblestone', 'iron_ingot', 'diamond', 'crafting_table'],
    'sword': [...ALL_PLANKS, 'stick', ...ALL_LOGS, 'cobblestone', 'iron_ingot', 'diamond', 'crafting_table'],
    'armor': ['iron_ingot', 'diamond', 'leather', 'gold_ingot', 'crafting_table'],
    'smelt': ['coal', 'charcoal', 'raw_iron', 'raw_gold', 'raw_copper', 'cobblestone', 'furnace'],
    'furnace': ['cobblestone', 'coal', 'charcoal', 'furnace'],

    // Mining
    'mine': ['torch', 'coal', 'cobblestone', ...ALL_PLANKS, 'stick', 'crafting_table', 'furnace'],
    'diamond': ['iron_ingot', 'torch', 'coal', 'cobblestone', ...ALL_PLANKS, 'stick', 'water_bucket', 'crafting_table', 'furnace'],
    'iron': ['cobblestone', 'coal', 'torch', 'stick', ...ALL_PLANKS, 'crafting_table', 'furnace'],

    // Redstone
    'redstone': ['redstone', 'cobblestone', 'stick', 'torch', 'crafting_table'],
    'piston': ['cobblestone', 'redstone', 'iron_ingot', ...ALL_PLANKS, 'crafting_table'],

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
    // Tier 5: KEEP_ALWAYS always wins — check FIRST so goal-protection never
    // downgrades a never-discard item from 5 to 4. (Value 4 items can still
    // appear in getDiscardSuggestions as last-resort candidates.)
    if (KEEP_ALWAYS.has(itemName)) return 5;

    // If the goal needs this item, bump it to "valuable"
    if (goalProtected.has(itemName)) return 4;

    // Tier 0: Trash — discard first
    if ([
        'rotten_flesh', 'poisonous_potato', 'spider_eye',
    ].includes(itemName)) return 0;

    // Tier 1: Bulk stone/soil & common bulk blocks — usually junk
    if ([
        // Cobblestone / igneous
        'cobblestone', 'mossy_cobblestone',
        'andesite', 'diorite', 'granite', 'tuff',
        // Deepslate family
        'deepslate', 'cobbled_deepslate',
        // Nether stone
        'netherrack', 'basalt', 'smooth_basalt', 'blackstone', 'magma_block',
        'soul_sand', 'soul_soil',
        // Sandstone family
        'sandstone', 'red_sandstone',
        // End
        'end_stone',
        // Ocean-monument bulk
        'prismarine', 'prismarine_bricks', 'dark_prismarine',
        // Soil variants (collected with shovel — harmless to discard)
        'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
        // Loose ground / clay
        'gravel', 'sand', 'red_sand', 'mud', 'clay_ball',
        // Cave-decorative bulk
        'dripstone_block', 'calcite',
        // Badlands
        'terracotta',
    ].includes(itemName)) return 1;

    // Tier 2: Common drops & basic materials
    if ([
        'string', 'bone', 'arrow', 'gunpowder', 'feather', 'ink_sac',
        'egg', 'leather', 'flint', 'snowball', 'vine',
        ...ALL_SAPLINGS,
        'oak_leaves', 'flower_pot', 'oak_fence',
        'amethyst_block', 'amethyst_shard',
    ].includes(itemName)) return 2;

    // Tier 3: Useful but not critical
    if ([
        ...ALL_PLANKS, 'stick',
        ...ALL_LOGS,
        'coal', 'charcoal', 'wheat', 'bread',
        'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton',
        'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    ].includes(itemName)) return 3;

    // Tier 4: Valuable materials (note: raw_iron/gold/copper/ingots also in
    //   KEEP_ALWAYS so they'll return 5 earlier. Kept here for clarity.)
    if ([
        'iron_ingot', 'raw_iron', 'gold_ingot', 'raw_gold',
        'redstone', 'lapis_lazuli', 'copper_ingot', 'raw_copper',
    ].includes(itemName)) return 4;

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

/**
 * Count how many inventory slots are occupied by "junk" (value <= 1, goal-aware).
 * Tier 0 = trash (rotten_flesh, spider_eye, poisonous_potato).
 * Tier 1 = bulk junk (cobblestone, dirt, gravel, sand, netherrack, etc.).
 * Items bumped to tier 4 by the current goal are excluded.
 * @param {object} bot - The mineflayer bot
 * @param {string|null} goal - The bot's current goal (to protect relevant items)
 * @returns {number} Number of inventory slots containing junk items.
 */
export function getJunkStackCount(bot, goal = null) {
    const goalProtected = getGoalProtectedItems(goal);
    let stacks = 0;
    for (const slot of bot.inventory.slots) {
        if (slot == null || !slot.name) continue;
        if (getItemValue(slot.name, goalProtected) <= 1) stacks++;
    }
    return stacks;
}

/**
 * Discard ALL junk items in one pass (goal-aware). Drains every tier 0 and tier 1 stack.
 * Use this when you want to fully clear the bot's junk backlog — not just free a few slots.
 * Collapses what would otherwise be N future SafeToss cycles into a single disposal run.
 * @param {object} bot - The mineflayer bot
 * @param {string|null} goal - The bot's current goal (to protect relevant items)
 * @returns {Promise<string>} Description of what was discarded
 */
export async function autoDiscardAllJunk(bot, goal = null) {
    const goalProtected = getGoalProtectedItems(goal);

    // Aggregate every junk stack (tier 0 + tier 1, goal-aware)
    const inventory = {};
    for (const slot of bot.inventory.slots) {
        if (slot == null || !slot.name) continue;
        if (getItemValue(slot.name, goalProtected) > 1) continue;
        if (!inventory[slot.name]) inventory[slot.name] = 0;
        inventory[slot.name] += slot.count;
    }

    const items = Object.entries(inventory).map(([name, count]) => ({ name, count }));
    if (items.length === 0) return 'No junk items found to auto-discard.';

    const discarded = [];
    for (const item of items) {
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
            // Skip items that fail to discard; keep draining the rest
        }
    }

    return discarded.length > 0
        ? `Auto-discarded all junk: ${discarded.join(', ')}. Drained ${discarded.length} slot(s).`
        : 'Failed to auto-discard junk items.';
}

