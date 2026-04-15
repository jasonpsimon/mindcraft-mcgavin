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

// Items where the bot only needs ONE. Extras are treated as tier 1 junk.
// Applied BEFORE KEEP_ALWAYS in snapshotInventory, so items in both sets
// respect the 1-each limit.
const SINGLETON_KEEPS = new Set([
    'crafting_table',
    'furnace',
    'bow',
    'shield',
    'flint_and_steel',
    'bucket',
    'water_bucket',
]);

// Items where up to 1 full stack is kept; extras (total > cap) become tier 1 junk.
// Cap defaults to 64 (one stack) unless overridden (e.g., ender_pearls stack to 16).
const STACK_CAPS = new Map([
    // Stack-limited vanilla exception
    ['ender_pearl', 16],

    // Utility / mob-drop bulk
    ['blaze_rod', 64],
    ['blaze_powder', 64],
    ['torch', 64],
    ['bone', 64],
    ['string', 64],
    ['gunpowder', 64],
    ['arrow', 64],
    ['feather', 64],
    ['leather', 64],
    ['slime_ball', 64],
    ['magma_cream', 64],
    ['ghast_tear', 64],
    ['glowstone_dust', 64],
    ['amethyst_shard', 64],

    // Food
    ['wheat', 64],
    ['bread', 64],

    // Ingots / raw / crystals (resources only — ore BLOCKS are junk, see tier 1)
    ['iron_ingot', 64], ['raw_iron', 64],
    ['gold_ingot', 64], ['raw_gold', 64],
    ['copper_ingot', 64], ['raw_copper', 64],
    ['netherite_ingot', 64], ['netherite_scrap', 64],
    ['diamond', 64], ['emerald', 64],
    ['redstone', 64], ['lapis_lazuli', 64],
    ['coal', 64], ['charcoal', 64],
    ['quartz', 64],
]);

// Tiered items — tools, weapons, and armor that exist in a fixed quality hierarchy.
//
// Purpose: replace the per-item "tools/weapons/armor are all KEEP_ALWAYS tier 5"
// rule with a tier-aware classifier. When the bot owns multiple tiers of the
// same role (e.g., wooden + stone + iron pickaxe), only the best-tier instances
// stay protected; lower-tier instances become tier 1 junk and are discarded by
// autoDiscardAllJunk.
//
// Each role's array is ordered BEST → WORST. "Best" = has highest index 0.
// The bot is considered to "own" a tier if inventory total for that name > 0;
// durability and count are not consulted.
//
// Caveats intentionally not solved (document, don't code around):
//   - Durability ignored: a 1-use iron_pickaxe still beats a freshly-crafted
//     wooden one. Practically fine — bots craft replacements when tools break,
//     and recoverWrongTool handles the no-tool case.
//   - Enchantments ignored: an Efficiency V wooden_pickaxe would be classified
//     as junk if plain iron exists. Edge case for gemma-4 (no enchanting yet).
//   - Non-tiered tools (bow, crossbow, shield, fishing_rod, flint_and_steel,
//     shears) are handled elsewhere — bow/shield/flint_and_steel via
//     SINGLETON_KEEPS; crossbow/fishing_rod/shears remain unlimited in
//     KEEP_ALWAYS.
//
// Inclusion rationale:
//   - Chainmail: rare (loot/trade only, uncraftable) but present in vanilla.
//     Ranked below iron (matches protection-point hierarchy), above golden.
//   - Golden: mediocre durability but present in vanilla. Included so the bot
//     doesn't hoard golden pickaxes when better tiers exist.
//   - Hoes: seldom crafted by a survival bot but MC supports them. Included
//     for consistency.
const TIERED_ITEMS = {
    pickaxe:    ['netherite_pickaxe',    'diamond_pickaxe',    'iron_pickaxe',    'stone_pickaxe',    'wooden_pickaxe',    'golden_pickaxe'],
    axe:        ['netherite_axe',        'diamond_axe',        'iron_axe',        'stone_axe',        'wooden_axe',        'golden_axe'],
    shovel:     ['netherite_shovel',     'diamond_shovel',     'iron_shovel',     'stone_shovel',     'wooden_shovel',     'golden_shovel'],
    hoe:        ['netherite_hoe',        'diamond_hoe',        'iron_hoe',        'stone_hoe',        'wooden_hoe',        'golden_hoe'],
    sword:      ['netherite_sword',      'diamond_sword',      'iron_sword',      'stone_sword',      'wooden_sword',      'golden_sword'],
    helmet:     ['netherite_helmet',     'diamond_helmet',     'iron_helmet',     'chainmail_helmet',     'golden_helmet',     'leather_helmet'],
    chestplate: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'leather_chestplate'],
    leggings:   ['netherite_leggings',   'diamond_leggings',   'iron_leggings',   'chainmail_leggings',   'golden_leggings',   'leather_leggings'],
    boots:      ['netherite_boots',      'diamond_boots',      'iron_boots',      'chainmail_boots',      'golden_boots',      'leather_boots'],
};

// Flat set of every name that appears in any TIERED_ITEMS role, built once at
// module load for fast membership check in the snapshot/label helpers.
const TIERED_ITEM_NAMES = new Set(Object.values(TIERED_ITEMS).flat());

// Beds are interchangeable across color variants — keep 1 of any, rest are junk.
const BED_GROUP = new Set([
    'bed',                  // generic / plain
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
    'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
    'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
    'brown_bed', 'green_bed', 'red_bed', 'black_bed',
]);

// All shulker box variants (plain purple + 16 dyed). Portable storage,
// nest-friendly for sub-containers — always keep unlimited.
const SHULKER_BOXES = [
    'shulker_box',
    'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
    'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
    'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
    'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
];

// Items the bot should NEVER discard (high value).
//
// Tools, weapons, and armor used to live here — they were moved to TIERED_ITEMS
// in 2026-04-15's #11 commit, where snapshotInventory now protects only the best
// tier the bot owns per role and treats lower tiers as tier 1 junk.
//
// Non-tiered tools (bow, crossbow, shield, fishing_rod, flint_and_steel, shears)
// stay here. Some of those also appear in SINGLETON_KEEPS — the chain in
// snapshotInventory checks SINGLETON_KEEPS first, so "keep exactly 1" wins over
// "keep unlimited" for items in both sets.
//
// Also removed 2026-04-15: lava_bucket and chest, both now tier 1 junk.
const KEEP_ALWAYS = new Set([
    // Non-tiered tools & weapons — no quality hierarchy, so unlimited is fine
    'bow', 'crossbow', 'shield', 'fishing_rod', 'flint_and_steel', 'shears',
    // Precious resources
    'diamond', 'emerald', 'gold_ingot', 'iron_ingot', 'raw_iron', 'raw_gold',
    'lapis_lazuli', 'redstone', 'ender_pearl', 'blaze_rod', 'nether_star',
    'ancient_debris',   // extremely rare — keep unlimited until smelted to netherite_scrap
    // Utility items
    'crafting_table', 'furnace', 'bucket', 'water_bucket',
    'torch', 'bed', 'red_bed', 'cyan_bed',
    // Shulker boxes (all variants — portable storage, nest-friendly)
    ...SHULKER_BOXES,
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

    // Tier 1: Bulk stone/soil, common bulk blocks, ore blocks, & deprecated
    // utility items (lava_bucket, chest) — all treated as junk.
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
        // Ore BLOCKS — smelt to resources then drop the block form.
        // Bot's rule: keep the extracted resource, not the unprocessed ore.
        'iron_ore', 'deepslate_iron_ore',
        'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore',
        'copper_ore', 'deepslate_copper_ore',
        'diamond_ore', 'deepslate_diamond_ore',
        'emerald_ore', 'deepslate_emerald_ore',
        'redstone_ore', 'deepslate_redstone_ore',
        'lapis_ore', 'deepslate_lapis_ore',
        'coal_ore', 'deepslate_coal_ore',
        'nether_quartz_ore',
        // Deprecated KEEP_ALWAYS (as of 2026-04-15) — explicit drops
        'lava_bucket',  // fuel resource but JP doesn't want multiples hoarded
        'chest',        // bot uses shulker_boxes for mobile storage
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
 * Given inventory totals and the bot's best-owned tier per role, classify a
 * single item by tier.
 *
 * Returns { isJunk: true } when `name` is a lower-tier entry in a role where
 * the bot owns at least one higher-tier item. Returns { isJunk: false } when
 * `name` is the best tier the bot owns in its role (or tied, if multiple
 * tiers shouldn't happen since tiers are unique names). Returns `null` when
 * `name` isn't a tiered item at all — caller falls through to next check.
 *
 * @param {string} name - Inventory item name (e.g., "stone_pickaxe")
 * @param {Object<string, number>} bestTierPerRole - Role → best tier index
 *   (0 = best available in bot's inventory). Built by _computeBestTierPerRole.
 * @returns {{isJunk: boolean, role: string} | null}
 */
function classifyByTier(name, bestTierPerRole) {
    if (!TIERED_ITEM_NAMES.has(name)) return null;
    for (const [role, tierList] of Object.entries(TIERED_ITEMS)) {
        const idx = tierList.indexOf(name);
        if (idx === -1) continue;
        const bestIdx = bestTierPerRole[role];
        // bestIdx being undefined means the bot doesn't own ANY item in this
        // role — impossible when `name` itself is in this role and has total>0,
        // but guard anyway. Treat as "not junk" so we don't accidentally discard.
        if (bestIdx === undefined) return { isJunk: false, role };
        return { isJunk: idx > bestIdx, role };
    }
    return null;
}

/**
 * Scan totals and determine, for each role in TIERED_ITEMS, the index of the
 * best tier the bot currently owns (lower index = better). Roles where the
 * bot owns nothing are omitted.
 *
 * @param {Object<string, number>} totals - Aggregated inventory counts
 * @returns {Object<string, number>} role → best tier index
 */
function _computeBestTierPerRole(totals) {
    const best = {};
    for (const [role, tierList] of Object.entries(TIERED_ITEMS)) {
        for (let i = 0; i < tierList.length; i++) {
            if ((totals[tierList[i]] || 0) > 0) {
                best[role] = i;
                break;
            }
        }
    }
    return best;
}

/**
 * Walk the bot's inventory and return { name -> { total, discardable, value } }.
 *   - `total`: total count across all stacks.
 *   - `discardable`: count the bot can safely dispose. Depends on limit rules:
 *       * SINGLETON_KEEPS (keep 1)  → discardable = total - 1
 *       * BED_GROUP (keep 1 across all colors)  → keeper color discardable = total-1, other colors = total
 *       * STACK_CAPS (keep up to cap)  → discardable = max(0, total - cap)
 *       * TIERED_ITEMS (keep best-tier owned)  → lower-tier discardable = total, best-tier not in snapshot
 *       * default  → discardable = total
 *   - `value`: effective tier. Capped/singleton/bed/lower-tier-tool extras are
 *     forced to tier 1 (junk); everything else uses getItemValue.
 *
 * Priority of checks: SINGLETON_KEEPS > BED_GROUP > STACK_CAPS > TIERED_ITEMS > getItemValue.
 * Entries where `discardable <= 0` are omitted from the snapshot — those items
 * are fully protected.
 *
 * This helper is the single source of truth for inventory classification —
 * use it in place of ad-hoc aggregation loops.
 */
function snapshotInventory(bot, goalProtected) {
    const totals = {};
    for (const slot of bot.inventory.slots) {
        if (slot == null || !slot.name) continue;
        if (!totals[slot.name]) totals[slot.name] = 0;
        totals[slot.name] += slot.count;
    }

    // Precompute best-owned tier per role once, before per-item classification.
    const bestTierPerRole = _computeBestTierPerRole(totals);

    const snapshot = {};
    // BED_GROUP: first bed color encountered with total > 0 is the keeper;
    // all remaining bed colors are fully discardable.
    let bedKeeperChosen = false;

    for (const [name, total] of Object.entries(totals)) {
        // 1. Hard singletons — keep exactly 1
        if (SINGLETON_KEEPS.has(name)) {
            const extras = total - 1;
            if (extras <= 0) continue;
            snapshot[name] = { total, discardable: extras, value: 1 };
            continue;
        }

        // 2. Bed group — keep 1 of any color across the entire group
        if (BED_GROUP.has(name)) {
            if (!bedKeeperChosen) {
                bedKeeperChosen = true;
                const extras = total - 1;
                if (extras <= 0) continue;
                snapshot[name] = { total, discardable: extras, value: 1 };
            } else {
                // Already have a keeper bed — all of this color are junk
                snapshot[name] = { total, discardable: total, value: 1 };
            }
            continue;
        }

        // 3. Stack caps — keep up to cap
        if (STACK_CAPS.has(name)) {
            const cap = STACK_CAPS.get(name);
            const extras = total - cap;
            if (extras <= 0) continue;
            snapshot[name] = { total, discardable: extras, value: 1 };
            continue;
        }

        // 4. Tiered items (tools/weapons/armor) — keep only best tier owned
        const tiered = classifyByTier(name, bestTierPerRole);
        if (tiered !== null) {
            if (tiered.isJunk) {
                snapshot[name] = { total, discardable: total, value: 1 };
            }
            // else: best tier — no snapshot entry, fully protected
            continue;
        }

        // 5. Default — classification via getItemValue
        snapshot[name] = { total, discardable: total, value: getItemValue(name, goalProtected) };
    }
    return snapshot;
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
    const snapshot = snapshotInventory(bot, goalProtected);

    // Score and sort: lowest value first, then highest count
    const scored = Object.entries(snapshot)
        .map(([name, info]) => ({ name, count: info.discardable, value: info.value }))
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
            const kept = [...goalProtected].filter(i => bot.inventory.findInventoryItem(i) != null).slice(0, 3).join(', ');
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
 * Count how many distinct item types are flagged as junk (value <= 1, goal-aware).
 * Tier 0 = trash (rotten_flesh, spider_eye, poisonous_potato).
 * Tier 1 = bulk junk (cobblestone, dirt, gravel, sand, netherrack, etc.).
 * Items bumped to tier 4 by the current goal are excluded.
 * Extras of SINGLETON_KEEPS (crafting_table, furnace) count as one junk type
 * each when their total exceeds 1 — since snapshotInventory forces them to tier 1.
 * @param {object} bot - The mineflayer bot
 * @param {string|null} goal - The bot's current goal (to protect relevant items)
 * @returns {number} Number of distinct junk item types in inventory.
 */
export function getJunkStackCount(bot, goal = null) {
    const goalProtected = getGoalProtectedItems(goal);
    const snapshot = snapshotInventory(bot, goalProtected);
    let stacks = 0;
    for (const info of Object.values(snapshot)) {
        if (info.value <= 1) stacks++;
    }
    return stacks;
}

/**
 * Discard ALL junk items in one pass (goal-aware). Drains every tier 0 and tier 1 stack,
 * plus extras of SINGLETON_KEEPS (crafting_table, furnace) — keeps exactly 1 of each.
 * Use this when you want to fully clear the bot's junk backlog — not just free a few slots.
 * Collapses what would otherwise be N future SafeToss cycles into a single disposal run.
 * @param {object} bot - The mineflayer bot
 * @param {string|null} goal - The bot's current goal (to protect relevant items)
 * @returns {Promise<string>} Description of what was discarded
 */
export async function autoDiscardAllJunk(bot, goal = null) {
    const goalProtected = getGoalProtectedItems(goal);
    const snapshot = snapshotInventory(bot, goalProtected);

    const items = Object.entries(snapshot)
        .filter(([, info]) => info.value <= 1)
        .map(([name, info]) => ({ name, count: info.discardable }));

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
            // snapshot.discardable already accounts for SINGLETON_KEEPS / BED_GROUP
            // / STACK_CAPS / TIERED_ITEMS — so `item.count` is exactly what we need
            // to drop, and the `remaining` cap guarantees we never drop below the
            // limit regardless of how stacks are split across inventory slots.
            //
            // Three label categories, distinguishable at a glance in logs:
            //   "N lower-tier X"  — X is an inferior tier, better exists in inventory
            //   "N extra X"       — X hit a SINGLETON_KEEPS / BED_GROUP / STACK_CAPS cap
            //   "N X"             — X is plain tier 0/1 junk (ores, bulk stone, etc.)
            let label;
            if (TIERED_ITEM_NAMES.has(item.name)) {
                label = `${item.count} lower-tier ${item.name}`;
            } else if (SINGLETON_KEEPS.has(item.name) || BED_GROUP.has(item.name) || STACK_CAPS.has(item.name)) {
                label = `${item.count} extra ${item.name}`;
            } else {
                label = `${item.count} ${item.name}`;
            }
            discarded.push(label);
            markDiscarded();
        } catch (e) {
            // Skip items that fail to discard; keep draining the rest
        }
    }

    return discarded.length > 0
        ? `Auto-discarded all junk: ${discarded.join(', ')}. Drained ${discarded.length} slot(s).`
        : 'Failed to auto-discard junk items.';
}

