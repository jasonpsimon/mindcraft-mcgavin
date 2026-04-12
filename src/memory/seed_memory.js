/**
 * Memory Seed — Pre-populates long-term memory with Minecraft fundamentals.
 *
 * Seeds the bot with knowledge it shouldn't have to waste inference cycles
 * discovering: crafting progressions, biome-resource mappings, survival
 * priorities, and combat basics.
 *
 * Called during agent.start() when long-term memory is empty.
 * Uses the store() API so everything goes through proper dedup and embedding.
 *
 * Usage:
 *   import { seedMemory } from '../memory/seed_memory.js';
 *   await seedMemory(agent.long_term_memory);
 */

/**
 * All seed facts organized by category.
 * These are foundational Minecraft knowledge that every player knows.
 */
const SEED_FACTS = [
    // ==================== STRATEGY: Crafting Progressions ====================
    {
        text: 'Tool progression: wooden tools → stone tools → iron tools → diamond tools → netherite tools. Always upgrade as soon as materials are available.',
        category: 'strategy',
        task: 'tool_progression'
    },
    {
        text: 'To craft wooden tools: punch tree → get oak_log → craft oak_planks (1 log = 4 planks) → craft sticks (2 planks = 4 sticks) → craft wooden_pickaxe (3 planks + 2 sticks).',
        category: 'strategy',
        task: 'early_game_crafting'
    },
    {
        text: 'To get stone tools: need wooden_pickaxe first → mine cobblestone → craft stone_pickaxe (3 cobblestone + 2 sticks). Stone is much faster than wood.',
        category: 'strategy',
        task: 'stone_tools'
    },
    {
        text: 'To get iron tools: need stone_pickaxe → mine iron_ore → smelt raw_iron in furnace → craft iron_pickaxe (3 iron_ingot + 2 sticks). Iron can mine diamonds.',
        category: 'strategy',
        task: 'iron_tools'
    },
    {
        text: 'To get diamond tools: need iron_pickaxe → mine at y=-59 to y=16 (deepslate layer) → find diamond_ore → craft diamond_pickaxe (3 diamond + 2 sticks).',
        category: 'strategy',
        task: 'diamond_tools'
    },
    {
        text: 'Crafting table is required for all tools, weapons, and armor. Recipe: 4 planks in a 2x2 grid. Place it down to access 3x3 crafting.',
        category: 'strategy',
        task: 'crafting_table'
    },
    {
        text: 'Furnace recipe: 8 cobblestone in a ring (leave center empty). Used for smelting ores, cooking food, and making charcoal.',
        category: 'strategy',
        task: 'furnace'
    },

    // ==================== STRATEGY: Survival Priorities ====================
    {
        text: 'First night survival priority: 1) Punch trees for wood 2) Craft planks + sticks 3) Craft wooden pickaxe 4) Mine stone + coal 5) Build shelter or dig into hillside 6) Craft furnace + torches. Must have shelter before nightfall.',
        category: 'strategy',
        task: 'first_night'
    },
    {
        text: 'Food priority: kill animals (cow, pig, chicken, sheep) for raw meat → cook in furnace. Cooked beef and porkchop restore 8 hunger (best common food). Bread (3 wheat) is reliable but slower to get.',
        category: 'strategy',
        task: 'food'
    },
    {
        text: 'Always keep hunger above 7 (visible drumsticks) — below 7 you cannot sprint. At 0 hunger you take starvation damage. Eat before combat.',
        category: 'strategy',
        task: 'hunger_management'
    },
    {
        text: 'Sleep in a bed at night to skip darkness and avoid phantoms. Bed recipe: 3 wool + 3 planks. If no bed, stay in a lit shelter — mobs spawn in darkness.',
        category: 'strategy',
        task: 'sleep'
    },
    {
        text: 'Light prevents mob spawning. Place torches every 12 blocks in caves and around your base. Coal + stick = 4 torches. Charcoal works too (smelt logs).',
        category: 'strategy',
        task: 'lighting'
    },

    // ==================== STRATEGY: Combat ====================
    {
        text: 'Hostile mobs: zombie (melee, burns in sun), skeleton (ranged bow, burns in sun), creeper (explodes near you, silent), spider (jumps, neutral in day), enderman (teleports, hostile if you look at it).',
        category: 'strategy',
        task: 'mob_knowledge'
    },
    {
        text: 'Combat basics: wait for attack cooldown (sword swing timing) before hitting again — spam clicking does less damage. Shield blocks 100% of frontal damage. Back away from creepers.',
        category: 'strategy',
        task: 'combat'
    },
    {
        text: 'When low health in combat: retreat and eat food to regenerate. Health regenerates when hunger is above 18 (9 full drumsticks). Golden apples give instant absorption.',
        category: 'strategy',
        task: 'combat_healing'
    },

    // ==================== STRATEGY: Mining ====================
    {
        text: 'Best mining strategy: branch mine at y=-59 for diamonds. Dig a main tunnel, then branches every 2 blocks to the side. Always bring torches and a water bucket.',
        category: 'strategy',
        task: 'mining'
    },
    {
        text: 'Water bucket is the most important tool for mining: extinguishes lava, breaks falls, and creates obsidian. Always carry one.',
        category: 'strategy',
        task: 'water_bucket'
    },
    {
        text: 'Never dig straight down — you can fall into lava or a cave. Dig in a 1x2 staircase pattern instead. Always have a way back up.',
        category: 'strategy',
        task: 'safe_mining'
    },
    {
        text: 'Ore distribution: coal (y=0-320, common), iron (y=-64-72, peak at y=16), gold (y=-64-32), diamond (y=-64-16, peak at y=-59), emerald (mountains only), lapis (y=-64-64).',
        category: 'strategy',
        task: 'ore_distribution'
    },

    // ==================== FACT: Resource Knowledge ====================
    {
        text: 'Wood types: oak, birch, spruce, dark_oak, jungle, acacia, mangrove, cherry. All work the same for crafting — any log → any planks → sticks → tools.',
        category: 'fact'
    },
    {
        text: 'Iron is the most versatile material: tools, armor, shields, buckets, hoppers, rails, anvils. Prioritize iron mining early.',
        category: 'fact'
    },
    {
        text: 'Coal is found on surface and in caves. If no coal, smelt oak_log in furnace to get charcoal (works identically for torches and smelting fuel).',
        category: 'fact'
    },
    {
        text: 'String from spiders + sticks = bow. Bow + arrows (flint + stick + feather) = ranged combat. Flint comes from gravel (10% drop rate).',
        category: 'fact'
    },
    {
        text: 'Leather from cows = leather armor (weakest but easy). Iron armor is a major upgrade. Full iron set: 24 iron ingots.',
        category: 'fact'
    },
    {
        text: 'Chest recipe: 8 planks in a ring. Use chests to store items at base. Double chest = 2 chests side by side = 54 slots.',
        category: 'fact'
    },

    // ==================== FACT: Biome Resources ====================
    {
        text: 'Plains biome: flat terrain, villages common, cows/pigs/sheep/horses spawn. Good starting biome.',
        category: 'fact'
    },
    {
        text: 'Forest biome: abundant wood (oak, birch), wolves, flowers. Good for early wood gathering.',
        category: 'fact'
    },
    {
        text: 'Desert biome: sand, sandstone, cactus, dead bushes, desert temples (loot), no passive mobs. Dangerous at night — no shelter.',
        category: 'fact'
    },
    {
        text: 'Taiga/snowy biome: spruce trees, wolves, foxes, sweet berries (food source), igloos. Snow slows travel.',
        category: 'fact'
    },
    {
        text: 'Mountain biome: goats, emerald ore (trade with villagers), high altitude coal/iron exposed on cliff faces.',
        category: 'fact'
    },
    {
        text: 'Jungle biome: tall jungle trees, cocoa beans, parrots, ocelots, jungle temples (traps + loot). Dense but resource-rich.',
        category: 'fact'
    },
    {
        text: 'Swamp biome: slimes spawn at night (slimeballs for sticky pistons/leads), witch huts, lily pads, blue orchids.',
        category: 'fact'
    },

    // ==================== FACT: Farming ====================
    {
        text: 'Wheat farm: hoe dirt near water → plant wheat_seeds (from breaking grass) → wait to grow → harvest. 3 wheat = 1 bread.',
        category: 'fact'
    },
    {
        text: 'Animal breeding: wheat for cows/sheep, seeds for chickens, carrots for pigs, carrots/potatoes/beetroot for villagers. Feed 2 adults = 1 baby.',
        category: 'fact'
    },
    {
        text: 'Sugar cane grows next to water on sand/dirt. Used for paper (3 sugar_cane) → books → bookshelves → enchanting table setup.',
        category: 'fact'
    },

    // ==================== FACT: Nether ====================
    {
        text: 'Nether portal: 10 obsidian in a 4x5 frame (corners optional). Mine obsidian with diamond_pickaxe. Light with flint_and_steel.',
        category: 'fact'
    },
    {
        text: 'Nether dangers: lava lakes, ghasts (fireballs), zombie piglins (neutral unless provoked), blazes (fire), magma cubes. Bring fire resistance potions if possible.',
        category: 'fact'
    },
    {
        text: 'Nether resources: nether quartz (XP), glowstone, blaze rods (from blazes → brewing stand), nether wart (from fortresses → potions), ancient debris (netherite, y=15).',
        category: 'fact'
    }
];

/**
 * Seed long-term memory with Minecraft fundamentals.
 * Skips seeding if memory already has facts (avoids duplicate seeds).
 *
 * @param {LongTermMemory} longTermMemory - Initialized LTM instance
 * @returns {number} Number of facts seeded
 */
export async function seedMemory(longTermMemory) {
    if (!longTermMemory) {
        console.warn('[SeedMemory] No long-term memory instance provided.');
        return 0;
    }

    // Don't re-seed if already populated
    const stats = longTermMemory.getStats();
    if (stats.totalFacts > 10) {
        console.log(`[SeedMemory] Memory already has ${stats.totalFacts} facts, skipping seed.`);
        return 0;
    }

    console.log(`[SeedMemory] Seeding ${SEED_FACTS.length} Minecraft fundamentals...`);
    let seeded = 0;

    for (const fact of SEED_FACTS) {
        try {
            const metadata = {};
            if (fact.task) metadata.task = fact.task;

            await longTermMemory.store(fact.text, fact.category, metadata);
            seeded++;
        } catch (err) {
            console.warn(`[SeedMemory] Failed to seed: "${fact.text.substring(0, 40)}...":`, err.message);
        }
    }

    console.log(`[SeedMemory] Seeded ${seeded}/${SEED_FACTS.length} facts successfully.`);
    return seeded;
}

/**
 * Get seed facts for inspection/debugging.
 */
export function getSeedFacts() {
    return SEED_FACTS;
}
