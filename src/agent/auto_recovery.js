/**
 * Auto-Recovery Engine for Mindcraft-McGavin
 * 
 * Intercepts failed command results and automatically resolves common
 * failure chains without LLM involvement. Uses recursive dependency
 * resolution (Odyssey pattern), inventory-aware discard (existing
 * inventory_utils), and mineflayer-crafting-util for craft planning.
 * 
 * Recovery flow:
 *   Command fails → match error pattern → resolve prerequisites
 *   recursively → execute corrective chain → retry original command
 */

import { autoDiscard, getDiscardSuggestions, isDiscardCooldownActive } from '../utils/inventory_utils.js';

// ============================================================
// FAILURE PATTERN REGISTRY
// Each pattern: { test: RegExp|Function, recovery: string, priority: number }
// Lower priority = checked first
// ============================================================
const FAILURE_PATTERNS = [
    {
        name: 'inventory_full',
        test: /inventory full|no free inventory|inventory is full/i,
        recovery: 'CLEAR_INVENTORY',
        priority: 0,  // Always check first — blocks everything
    },
    {
        name: 'wrong_tool',
        test: /don't have right tools|need a pickaxe|need at least a/i,
        recovery: 'CRAFT_REQUIRED_TOOL',
        priority: 1,
    },
    {
        name: 'need_crafting_table',
        test: /need a crafting table|no crafting table nearby|requires a crafting table/i,
        recovery: 'PLACE_CRAFTING_TABLE',
        priority: 2,
    },
    {
        name: 'need_furnace',
        test: /need a furnace|no furnace nearby|requires a furnace/i,
        recovery: 'PLACE_FURNACE',
        priority: 3,
    },
    {
        name: 'bedrock_hit',
        test: /bedrock is infinity|can't break bedrock|dig time for bedrock/i,
        recovery: 'DIG_UP_ESCAPE',
        priority: 4,
    },
    {
        name: 'pathfind_timeout',
        test: /took too long to decide path|path to goal|pathfinding timeout/i,
        recovery: 'PATHFIND_RETRY',
        priority: 5,
    },
    {
        name: 'block_not_found',
        test: /could not find any|no .+ nearby|couldn't find/i,
        recovery: 'SEARCH_WIDER',
        priority: 6,
    },
];

// ============================================================
// TOOL TIER HIERARCHY
// Used to determine what tool to craft when mining requires one
// ============================================================
const PICKAXE_TIERS = [
    { name: 'netherite_pickaxe', tier: 5, material: 'netherite_ingot', materialCount: 0 }, // upgrade, not craft
    { name: 'diamond_pickaxe', tier: 4, material: 'diamond', materialCount: 3 },
    { name: 'iron_pickaxe', tier: 3, material: 'iron_ingot', materialCount: 3 },
    { name: 'stone_pickaxe', tier: 2, material: 'cobblestone', materialCount: 3 },
    { name: 'wooden_pickaxe', tier: 1, material: 'oak_planks', materialCount: 3 },
];

const AXE_TIERS = [
    { name: 'diamond_axe', tier: 4, material: 'diamond', materialCount: 3 },
    { name: 'iron_axe', tier: 3, material: 'iron_ingot', materialCount: 3 },
    { name: 'stone_axe', tier: 2, material: 'cobblestone', materialCount: 3 },
    { name: 'wooden_axe', tier: 1, material: 'oak_planks', materialCount: 3 },
];

// Minimum pickaxe tier required for certain blocks (by minecraft-data harvestTools)
// We'll also query minecraft-data dynamically, but these are fast-path overrides
const BLOCK_MIN_TIER = {
    'diamond_ore': 3, 'deepslate_diamond_ore': 3, // iron+
    'gold_ore': 3, 'deepslate_gold_ore': 3, 'nether_gold_ore': 1,
    'emerald_ore': 3, 'deepslate_emerald_ore': 3,
    'redstone_ore': 3, 'deepslate_redstone_ore': 3,
    'lapis_ore': 2, 'deepslate_lapis_ore': 2, // stone+
    'iron_ore': 2, 'deepslate_iron_ore': 2,
    'copper_ore': 2, 'deepslate_copper_ore': 2,
    'coal_ore': 1, 'deepslate_coal_ore': 1, // wooden+
    'nether_quartz_ore': 1,
    'stone': 1, 'cobblestone': 1, 'deepslate': 1,
    'obsidian': 4, // diamond+
};

// ============================================================
// CRAFTING PREREQUISITES — what you need and how to get it
// Used when mineflayer-crafting-util isn't loaded or for quick lookups
// ============================================================
const CRAFT_CHAIN = {
    'oak_planks':       { from: 'craft', needs: [{ item: 'oak_log', count: 1 }], yields: 4, table: false },
    'spruce_planks':    { from: 'craft', needs: [{ item: 'spruce_log', count: 1 }], yields: 4, table: false },
    'birch_planks':     { from: 'craft', needs: [{ item: 'birch_log', count: 1 }], yields: 4, table: false },
    'stick':            { from: 'craft', needs: [{ item: '_planks', count: 2 }], yields: 4, table: false },
    'crafting_table':   { from: 'craft', needs: [{ item: '_planks', count: 4 }], yields: 1, table: false },
    'furnace':          { from: 'craft', needs: [{ item: 'cobblestone', count: 8 }], yields: 1, table: true },
    'wooden_pickaxe':   { from: 'craft', needs: [{ item: '_planks', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'wooden_axe':       { from: 'craft', needs: [{ item: '_planks', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'wooden_sword':     { from: 'craft', needs: [{ item: '_planks', count: 2 }, { item: 'stick', count: 1 }], yields: 1, table: true },
    'wooden_shovel':    { from: 'craft', needs: [{ item: '_planks', count: 1 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'stone_pickaxe':    { from: 'craft', needs: [{ item: 'cobblestone', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'stone_axe':        { from: 'craft', needs: [{ item: 'cobblestone', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'stone_sword':      { from: 'craft', needs: [{ item: 'cobblestone', count: 2 }, { item: 'stick', count: 1 }], yields: 1, table: true },
    'iron_pickaxe':     { from: 'craft', needs: [{ item: 'iron_ingot', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'iron_axe':         { from: 'craft', needs: [{ item: 'iron_ingot', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'iron_sword':       { from: 'craft', needs: [{ item: 'iron_ingot', count: 2 }, { item: 'stick', count: 1 }], yields: 1, table: true },
    'diamond_pickaxe':  { from: 'craft', needs: [{ item: 'diamond', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'diamond_axe':      { from: 'craft', needs: [{ item: 'diamond', count: 3 }, { item: 'stick', count: 2 }], yields: 1, table: true },
    'diamond_sword':    { from: 'craft', needs: [{ item: 'diamond', count: 2 }, { item: 'stick', count: 1 }], yields: 1, table: true },
    'torch':            { from: 'craft', needs: [{ item: 'coal', count: 1 }, { item: 'stick', count: 1 }], yields: 4, table: false },
    'iron_ingot':       { from: 'smelt', needs: [{ item: 'raw_iron', count: 1 }], yields: 1, fuel: true },
    'gold_ingot':       { from: 'smelt', needs: [{ item: 'raw_gold', count: 1 }], yields: 1, fuel: true },
    'copper_ingot':     { from: 'smelt', needs: [{ item: 'raw_copper', count: 1 }], yields: 1, fuel: true },
    'charcoal':         { from: 'smelt', needs: [{ item: '_log', count: 1 }], yields: 1, fuel: true },
};

// Items that can substitute for generic '_planks' and '_log' references
const PLANK_TYPES = ['oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks', 'jungle_planks', 'acacia_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks'];
const LOG_TYPES = ['oak_log', 'spruce_log', 'birch_log', 'dark_oak_log', 'jungle_log', 'acacia_log', 'mangrove_log', 'cherry_log'];
const FUEL_TYPES = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'stick', 'oak_log', 'spruce_log', 'birch_log'];

// ============================================================
// AUTO-RECOVERY ENGINE CLASS
// ============================================================
export class AutoRecoveryEngine {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.recoveryDepth = 0;
        this.maxRecoveryDepth = 8;  // prevent infinite recursion
        this.recentFailures = [];   // track repeated failures
        this.maxRepeatedFailures = 3;
        this._recovering = false;
    }

    /**
     * Main entry point: check a command result for failures and auto-recover.
     * @param {string} commandName - The command that was executed (e.g., '!collectBlocks')
     * @param {string} result - The result/output string from command execution
     * @param {string} originalCommand - The full original command string for retry
     * @returns {Promise<{recovered: boolean, result: string}>}
     */
    async checkAndRecover(commandName, result, originalCommand) {
        if (!result || typeof result !== 'string') {
            return { recovered: false, result };
        }

        // Don't nest recovery — if we're already recovering, let it fail through
        if (this._recovering) {
            return { recovered: false, result };
        }

        // Check for repeated failures (same command failing 3+ times)
        const failureKey = `${commandName}:${result.substring(0, 80)}`;
        this.recentFailures.push({ key: failureKey, time: Date.now() });
        // Prune old failures (>60s)
        this.recentFailures = this.recentFailures.filter(f => Date.now() - f.time < 60000);
        const repeatedCount = this.recentFailures.filter(f => f.key === failureKey).length;
        if (repeatedCount >= this.maxRepeatedFailures) {
            console.log(`[AutoRecovery] Command ${commandName} has failed ${repeatedCount} times with same error — giving up`);
            this.recentFailures = this.recentFailures.filter(f => f.key !== failureKey);
            return { 
                recovered: false, 
                result: result + `\n[AUTO-RECOVERY] This action has failed ${repeatedCount} times. Try a completely different approach.`
            };
        }

        // Match against failure patterns
        for (const pattern of FAILURE_PATTERNS) {
            const matched = pattern.test instanceof RegExp 
                ? pattern.test.test(result) 
                : pattern.test(result);
            
            if (matched) {
                console.log(`[AutoRecovery] Matched failure pattern: ${pattern.name}`);
                this._recovering = true;
                this.recoveryDepth = 0;
                
                try {
                    const recoveryResult = await this.executeRecovery(
                        pattern.recovery, commandName, result, originalCommand
                    );
                    return recoveryResult;
                } catch (e) {
                    console.warn(`[AutoRecovery] Recovery failed: ${e.message}`);
                    return { recovered: false, result: result + `\n[AUTO-RECOVERY] Attempted fix but failed: ${e.message}` };
                } finally {
                    this._recovering = false;
                    this.recoveryDepth = 0;
                }
            }
        }

        return { recovered: false, result };
    }

    /**
     * Execute a specific recovery action.
     */
    async executeRecovery(recoveryType, commandName, failResult, originalCommand) {
        this.recoveryDepth++;
        if (this.recoveryDepth > this.maxRecoveryDepth) {
            throw new Error(`Recovery depth exceeded (${this.maxRecoveryDepth}) — dependency chain too deep`);
        }

        console.log(`[AutoRecovery] Executing recovery: ${recoveryType} (depth ${this.recoveryDepth})`);

        switch (recoveryType) {
            case 'CLEAR_INVENTORY':
                return await this.recoverInventoryFull(originalCommand);
            case 'CRAFT_REQUIRED_TOOL':
                return await this.recoverWrongTool(failResult, originalCommand);
            case 'PLACE_CRAFTING_TABLE':
                return await this.recoverNeedCraftingTable(originalCommand);
            case 'PLACE_FURNACE':
                return await this.recoverNeedFurnace(originalCommand);
            case 'DIG_UP_ESCAPE':
                return await this.recoverBedrockHit(originalCommand);
            case 'PATHFIND_RETRY':
                return await this.recoverPathfindTimeout(originalCommand);
            case 'SEARCH_WIDER':
                return { recovered: false, result: failResult + '\n[AUTO-RECOVERY] Block not found nearby. Try searching a different area.' };
            default:
                return { recovered: false, result: failResult };
        }
    }

    // ============================================================
    // RECOVERY HANDLERS
    // ============================================================

    /**
     * INVENTORY FULL: Auto-discard junk, then retry original command.
     */
    async recoverInventoryFull(originalCommand) {
        const goal = this.agent.self_prompter?.prompt || null;
        console.log('[AutoRecovery] Clearing inventory (goal-aware discard)...');

        const discardResult = await autoDiscard(this.bot, 5, goal);
        console.log(`[AutoRecovery] Discard result: ${discardResult}`);

        if (discardResult.includes('No junk items') || discardResult.includes('Failed')) {
            return { 
                recovered: false, 
                result: `[AUTO-RECOVERY] Inventory full but no junk to discard. ${discardResult}. Drop items manually or use a chest.`
            };
        }

        // Retry the original command
        if (originalCommand) {
            console.log(`[AutoRecovery] Retrying after discard: ${originalCommand}`);
            return { recovered: true, result: `[AUTO-RECOVERY] ${discardResult} Retrying original action...`, retry: originalCommand };
        }

        return { recovered: true, result: `[AUTO-RECOVERY] ${discardResult}` };
    }

    /**
     * WRONG TOOL: Figure out what tool is needed, craft the best available, retry.
     */
    async recoverWrongTool(failResult, originalCommand) {
        // First: is inventory full? Clear it before crafting
        if (this.getEmptySlots() < 2) {
            console.log('[AutoRecovery] Inventory nearly full — clearing before tool craft');
            await this.recoverInventoryFull(null);
        }

        // Determine what block we're trying to mine
        const blockMatch = failResult.match(/harvest (\w+)|mine (\w+)/i);
        const blockName = blockMatch ? (blockMatch[1] || blockMatch[2]) : null;

        // Determine minimum tier needed
        let minTier = 1; // default wooden
        if (blockName && BLOCK_MIN_TIER[blockName]) {
            minTier = BLOCK_MIN_TIER[blockName];
        }

        // Find the best pickaxe we can craft right now
        const tool = await this.craftBestTool(PICKAXE_TIERS, minTier);
        if (tool) {
            console.log(`[AutoRecovery] Crafted ${tool} — retrying`);
            // Equip it
            try {
                const item = this.bot.inventory.items().find(i => i.name === tool);
                if (item) await this.bot.equip(item, 'hand');
            } catch (e) {
                console.warn(`[AutoRecovery] Failed to equip ${tool}: ${e.message}`);
            }
            if (originalCommand) {
                return { recovered: true, result: `[AUTO-RECOVERY] Crafted and equipped ${tool}. Retrying...`, retry: originalCommand };
            }
            return { recovered: true, result: `[AUTO-RECOVERY] Crafted and equipped ${tool}.` };
        }

        // Couldn't craft any suitable tool — need to gather materials
        const gathered = await this.gatherForTool(minTier);
        if (gathered) {
            // Try crafting again after gathering
            const tool2 = await this.craftBestTool(PICKAXE_TIERS, minTier);
            if (tool2) {
                try {
                    const item = this.bot.inventory.items().find(i => i.name === tool2);
                    if (item) await this.bot.equip(item, 'hand');
                } catch (e) { /* */ }
                if (originalCommand) {
                    return { recovered: true, result: `[AUTO-RECOVERY] Gathered materials and crafted ${tool2}. Retrying...`, retry: originalCommand };
                }
                return { recovered: true, result: `[AUTO-RECOVERY] Gathered materials and crafted ${tool2}.` };
            }
        }

        return { 
            recovered: false, 
            result: `[AUTO-RECOVERY] Couldn't craft required tool (need tier ${minTier}+). Need to gather materials first.` 
        };
    }

    /**
     * NEED CRAFTING TABLE: Place one, or craft one, or gather wood to craft one.
     */
    async recoverNeedCraftingTable(originalCommand) {
        // Check inventory full first
        if (this.getEmptySlots() < 2) {
            await this.recoverInventoryFull(null);
        }

        // Do we have a crafting table in inventory?
        if (this.hasItem('crafting_table')) {
            const placed = await this.placeBlock('crafting_table');
            if (placed && originalCommand) {
                return { recovered: true, result: '[AUTO-RECOVERY] Placed crafting table. Retrying...', retry: originalCommand };
            } else if (placed) {
                return { recovered: true, result: '[AUTO-RECOVERY] Placed crafting table.' };
            }
        }

        // Do we have planks to craft one?
        const planks = this.findAnyItem(PLANK_TYPES);
        if (planks && this.countItem(planks) >= 4) {
            await this.craftItem('crafting_table', 1);
            if (this.hasItem('crafting_table')) {
                const placed = await this.placeBlock('crafting_table');
                if (placed && originalCommand) {
                    return { recovered: true, result: '[AUTO-RECOVERY] Crafted and placed crafting table. Retrying...', retry: originalCommand };
                }
            }
        }

        // Do we have logs to make planks?
        const log = this.findAnyItem(LOG_TYPES);
        if (log) {
            const plankType = log.replace('_log', '_planks');
            await this.craftItem(plankType, 1); // yields 4 planks
            await this.craftItem('crafting_table', 1);
            if (this.hasItem('crafting_table')) {
                const placed = await this.placeBlock('crafting_table');
                if (placed && originalCommand) {
                    return { recovered: true, result: '[AUTO-RECOVERY] Crafted planks → crafting table → placed. Retrying...', retry: originalCommand };
                }
            }
        }

        // Need to collect wood first
        const collected = await this.collectNearestLog(4);
        if (collected) {
            const collectedLog = this.findAnyItem(LOG_TYPES);
            if (collectedLog) {
                const plankType = collectedLog.replace('_log', '_planks');
                await this.craftItem(plankType, 1);
                await this.craftItem('crafting_table', 1);
                if (this.hasItem('crafting_table')) {
                    const placed = await this.placeBlock('crafting_table');
                    if (placed && originalCommand) {
                        return { recovered: true, result: '[AUTO-RECOVERY] Collected logs → planks → crafting table → placed. Retrying...', retry: originalCommand };
                    }
                }
            }
        }

        return { recovered: false, result: '[AUTO-RECOVERY] Could not obtain crafting table. No logs nearby.' };
    }

    /**
     * NEED FURNACE: Place one, or craft one (needs 8 cobblestone + crafting table).
     */
    async recoverNeedFurnace(originalCommand) {
        if (this.getEmptySlots() < 2) {
            await this.recoverInventoryFull(null);
        }

        // Have a furnace?
        if (this.hasItem('furnace')) {
            const placed = await this.placeBlock('furnace');
            if (placed && originalCommand) {
                return { recovered: true, result: '[AUTO-RECOVERY] Placed furnace. Retrying...', retry: originalCommand };
            }
        }

        // Have 8 cobblestone? Craft it (needs crafting table)
        if (this.countItem('cobblestone') >= 8) {
            // Ensure we have a crafting table nearby
            await this.ensureCraftingTable();
            await this.craftItem('furnace', 1);
            if (this.hasItem('furnace')) {
                const placed = await this.placeBlock('furnace');
                if (placed && originalCommand) {
                    return { recovered: true, result: '[AUTO-RECOVERY] Crafted and placed furnace. Retrying...', retry: originalCommand };
                }
            }
        }

        return { recovered: false, result: '[AUTO-RECOVERY] Need 8 cobblestone to craft a furnace. Mine some stone first.' };
    }

    /**
     * BEDROCK HIT: Switch to !digUp.
     */
    async recoverBedrockHit(originalCommand) {
        console.log('[AutoRecovery] Hit bedrock — switching to digUp');
        return { 
            recovered: true, 
            result: '[AUTO-RECOVERY] Hit bedrock — cannot dig down further. Switching to dig up.',
            retry: '!digUp(12)' 
        };
    }

    /**
     * PATHFIND TIMEOUT: Try a shorter distance or simpler goal.
     */
    async recoverPathfindTimeout(originalCommand) {
        // If the original was goToPosition/goToPlayer, retry with a closer target
        console.log('[AutoRecovery] Pathfinding timeout — not auto-retrying (LLM should choose different approach)');
        return { 
            recovered: false, 
            result: `[AUTO-RECOVERY] Pathfinding failed — can't reach the target. Try a closer location or use !digDown/!digUp to change elevation.` 
        };
    }

    // ============================================================
    // HELPER METHODS
    // ============================================================

    /**
     * Get count of empty inventory slots.
     */
    getEmptySlots() {
        const slots = this.bot.inventory.slots.slice(9, 45); // main inventory
        return slots.filter(s => s === null).length;
    }

    /**
     * Check if bot has an item.
     */
    hasItem(itemName) {
        return this.bot.inventory.items().some(i => i.name === itemName);
    }

    /**
     * Count how many of an item the bot has.
     */
    countItem(itemName) {
        return this.bot.inventory.items()
            .filter(i => i.name === itemName)
            .reduce((sum, i) => sum + i.count, 0);
    }

    /**
     * Find the first item matching any name in the list.
     */
    findAnyItem(nameList) {
        for (const name of nameList) {
            if (this.hasItem(name)) return name;
        }
        return null;
    }

    /**
     * Count total of any item matching a list of names.
     */
    countAnyItem(nameList) {
        let total = 0;
        for (const name of nameList) {
            total += this.countItem(name);
        }
        return total;
    }

    /**
     * Craft the best tool from a tier list that we have materials for.
     * Walks down from best to minimum tier, checks inventory, crafts if possible.
     * @param {Array} tierList - PICKAXE_TIERS or AXE_TIERS
     * @param {number} minTier - Minimum acceptable tier
     * @returns {string|null} Name of crafted tool, or null
     */
    async craftBestTool(tierList, minTier = 1) {
        // Already have a good enough tool?
        for (const t of tierList) {
            if (t.tier >= minTier && this.hasItem(t.name)) {
                console.log(`[AutoRecovery] Already have ${t.name} (tier ${t.tier})`);
                return t.name;
            }
        }

        // Try crafting from best available down to minimum tier
        for (const t of tierList) {
            if (t.tier < minTier) continue;
            if (t.tier === 5) continue; // skip netherite (upgrade path)

            const recipe = CRAFT_CHAIN[t.name];
            if (!recipe) continue;

            // Check if we have all materials
            let canCraft = true;
            for (const need of recipe.needs) {
                const resolved = this.resolveGenericItem(need.item);
                if (!resolved || this.countItem(resolved) < need.count) {
                    canCraft = false;
                    break;
                }
            }

            if (canCraft) {
                // Ensure crafting table is available if needed
                if (recipe.table) {
                    const tableReady = await this.ensureCraftingTable();
                    if (!tableReady) continue;
                }
                
                await this.craftItem(t.name, 1);
                if (this.hasItem(t.name)) {
                    return t.name;
                }
            }
        }

        return null;
    }

    /**
     * Try to gather materials for a tool of the given tier.
     * Walks the dependency chain: tier 1 needs planks+sticks, planks need logs, etc.
     */
    async gatherForTool(targetTier) {
        console.log(`[AutoRecovery] Gathering materials for tier ${targetTier} tool`);

        // Always need sticks (2)
        if (this.countItem('stick') < 2) {
            // Need planks for sticks
            if (this.countAnyItem(PLANK_TYPES) < 2) {
                // Need logs for planks
                await this.collectNearestLog(2);
                const log = this.findAnyItem(LOG_TYPES);
                if (log) {
                    const plankType = log.replace('_log', '_planks');
                    await this.craftItem(plankType, 1); // yields 4
                }
            }
            await this.craftItem('stick', 1); // yields 4
        }

        if (targetTier <= 1) {
            // Wooden tools: need planks
            if (this.countAnyItem(PLANK_TYPES) < 3) {
                await this.collectNearestLog(2);
                const log = this.findAnyItem(LOG_TYPES);
                if (log) {
                    const plankType = log.replace('_log', '_planks');
                    await this.craftItem(plankType, 1);
                }
            }
            return this.countAnyItem(PLANK_TYPES) >= 3 && this.countItem('stick') >= 2;
        }

        if (targetTier <= 2) {
            // Stone tools: need cobblestone — need wooden pickaxe first
            if (!this.hasItem('stone_pickaxe') && !this.hasItem('iron_pickaxe') && !this.hasItem('diamond_pickaxe')) {
                // Craft wooden pickaxe first
                const wp = await this.craftBestTool(PICKAXE_TIERS, 1);
                if (!wp) return false;
                try {
                    const item = this.bot.inventory.items().find(i => i.name === wp);
                    if (item) await this.bot.equip(item, 'hand');
                } catch (e) { /* */ }
            }
            // Now mine cobblestone
            if (this.countItem('cobblestone') < 3) {
                await this.collectBlock('cobblestone', 3 - this.countItem('cobblestone'));
                // If cobblestone not found, try mining stone (drops cobblestone)
                if (this.countItem('cobblestone') < 3) {
                    await this.collectBlock('stone', 3 - this.countItem('cobblestone'));
                }
            }
            return this.countItem('cobblestone') >= 3 && this.countItem('stick') >= 2;
        }

        // Tier 3+ (iron, diamond) — these require smelting or finding, too complex for auto-recovery
        // Return false and let the LLM figure out higher-tier tool acquisition
        console.log(`[AutoRecovery] Tier ${targetTier}+ tool requires smelting/rare materials — deferring to LLM`);
        return false;
    }

    /**
     * Resolve generic item references like '_planks' or '_log' to actual inventory items.
     */
    resolveGenericItem(itemName) {
        if (itemName === '_planks') return this.findAnyItem(PLANK_TYPES);
        if (itemName === '_log') return this.findAnyItem(LOG_TYPES);
        if (this.hasItem(itemName)) return itemName;
        return null;
    }

    /**
     * Ensure a crafting table is placed nearby.
     */
    async ensureCraftingTable() {
        // Check if there's already one nearby
        const nearby = this.bot.findBlock({
            matching: (block) => block.name === 'crafting_table',
            maxDistance: 6,
        });
        if (nearby) return true;

        // Place from inventory
        if (this.hasItem('crafting_table')) {
            return await this.placeBlock('crafting_table');
        }

        // Craft one
        const planks = this.findAnyItem(PLANK_TYPES);
        if (planks && this.countItem(planks) >= 4) {
            await this.craftItem('crafting_table', 1);
            if (this.hasItem('crafting_table')) {
                return await this.placeBlock('crafting_table');
            }
        }

        // Need to get planks from logs
        const log = this.findAnyItem(LOG_TYPES);
        if (log) {
            const plankType = log.replace('_log', '_planks');
            await this.craftItem(plankType, 1);
            await this.craftItem('crafting_table', 1);
            if (this.hasItem('crafting_table')) {
                return await this.placeBlock('crafting_table');
            }
        }

        // Need to collect logs
        const collected = await this.collectNearestLog(1);
        if (collected) {
            const foundLog = this.findAnyItem(LOG_TYPES);
            if (foundLog) {
                const plankType = foundLog.replace('_log', '_planks');
                await this.craftItem(plankType, 1);
                await this.craftItem('crafting_table', 1);
                if (this.hasItem('crafting_table')) {
                    return await this.placeBlock('crafting_table');
                }
            }
        }

        console.warn('[AutoRecovery] Could not obtain or place crafting table');
        return false;
    }

    /**
     * Collect the nearest log blocks.
     */
    async collectBlock(blockType, count) {
        try {
            const skills = await import('../library/skills.js');
            await skills.collectBlock(this.bot, blockType, count, this.agent);
            return true;
        } catch (e) {
            console.warn(`[AutoRecovery] collectBlock(${blockType}) failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Collect nearest log of any type.
     */
    async collectNearestLog(count) {
        for (const logType of LOG_TYPES) {
            const block = this.bot.findBlock({
                matching: (b) => b.name === logType,
                maxDistance: 32,
            });
            if (block) {
                return await this.collectBlock(logType, count);
            }
        }
        console.warn('[AutoRecovery] No logs found within 32 blocks');
        return false;
    }

    /**
     * Craft an item using the bot's craft method.
     */
    async craftItem(itemName, count) {
        try {
            const skills = await import('../library/skills.js');
            await skills.craftRecipe(this.bot, itemName, count);
            console.log(`[AutoRecovery] Crafted ${count} ${itemName}`);
            return true;
        } catch (e) {
            console.warn(`[AutoRecovery] craftItem(${itemName}) failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Place a block from inventory near the bot.
     */
    async placeBlock(blockName) {
        try {
            const skills = await import('../library/skills.js');
            await skills.placeBlock(this.bot, blockName, 1, 0, 0, 'bottom');
            console.log(`[AutoRecovery] Placed ${blockName}`);
            return true;
        } catch (e) {
            console.warn(`[AutoRecovery] placeBlock(${blockName}) failed: ${e.message}`);
            return false;
        }
    }
}
