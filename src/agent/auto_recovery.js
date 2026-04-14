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
import * as skills from './library/skills.js';
import { withBotLock } from './bot_mutex.js';

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
        test: /no \w+ nearby to collect|no more \w+ nearby to collect|could not find any \w+ to collect/i,
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
        this.recoveryDepth = 0;
        this.maxRecoveryDepth = 8;  // prevent infinite recursion
        this.recentFailures = [];   // track repeated failures
        this.maxRepeatedFailures = 3;
        this._recovering = false;
        this._cachedItems = null;   // inventory snapshot for current recovery pass
        // Instance copy of patterns — extensible at runtime via addPattern/removePattern
        this.patterns = [...FAILURE_PATTERNS];
    }

    /**
     * Add a custom failure pattern at runtime.
     * @param {string} name - Unique identifier for the pattern
     * @param {RegExp|Function} test - Regex or function to match against command results
     * @param {string} recovery - Recovery action key (must be handled by executeRecovery)
     * @param {number} priority - Lower = checked first (default: 10)
     */
    addPattern(name, test, recovery, priority = 10) {
        // Replace if same name exists
        this.patterns = this.patterns.filter(p => p.name !== name);
        this.patterns.push({ name, test, recovery, priority });
        this.patterns.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Remove a failure pattern by name.
     * @param {string} name - Pattern name to remove
     * @returns {boolean} Whether a pattern was removed
     */
    removePattern(name) {
        const before = this.patterns.length;
        this.patterns = this.patterns.filter(p => p.name !== name);
        return this.patterns.length < before;
    }

    /**
     * Get the bot's inventory items — uses cached snapshot during recovery passes
     * to avoid repeated enumeration. Cache is set at recovery start and cleared on exit.
     */
    _getItems() {
        if (this._cachedItems) return this._cachedItems;
        return this.agent.bot.inventory.items();
    }

    /** Snapshot inventory at recovery start, clear on exit. */
    _snapshotInventory() {
        this._cachedItems = this.agent.bot.inventory.items();
    }
    _clearSnapshot() {
        this._cachedItems = null;
    }
    /** Invalidate cache after inventory-mutating actions (craft, discard, collect). */
    _invalidateSnapshot() {
        this._cachedItems = null;
    }

    /**
     * Build a standard success recovery result.
     * Appends "Retrying..." and includes retry command when originalCommand is provided.
     */
    _successResult(message, originalCommand) {
        if (originalCommand) {
            return { recovered: true, result: `[AUTO-RECOVERY] ${message} Retrying...`, retry: originalCommand };
        }
        return { recovered: true, result: `[AUTO-RECOVERY] ${message}` };
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

        // Match against failure patterns (instance copy — extensible at runtime)
        for (const pattern of this.patterns) {
            const matched = pattern.test instanceof RegExp
                ? pattern.test.test(result)
                : pattern.test(result);

            if (matched) {
                console.log(`[AutoRecovery] Matched failure pattern: ${pattern.name}`);

                // Track only actual failures — prune entries older than 60s
                const failureKey = `${commandName}:${result.substring(0, 80)}`;
                this.recentFailures.push({ key: failureKey, time: Date.now() });
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

                this._recovering = true;
                this.recoveryDepth = 0;
                this._snapshotInventory();

                try {
                    // Hold the bot exclusively for the entire recovery — blocks any
                    // LLM-issued command (also wrapped in withBotLock) from racing us.
                    const recoveryResult = await withBotLock(
                        `autoRecovery:${pattern.name}`,
                        () => this.executeRecovery(pattern.recovery, commandName, result, originalCommand)
                    );
                    return recoveryResult;
                } catch (e) {
                    console.warn(`[AutoRecovery] Recovery failed: ${e.message}`);
                    return { recovered: false, result: result + `\n[AUTO-RECOVERY] Attempted fix but failed: ${e.message}` };
                } finally {
                    this._recovering = false;
                    this.recoveryDepth = 0;
                    this._clearSnapshot();
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
        // Respect the discard cooldown — if we just discarded, don't do it again
        if (isDiscardCooldownActive()) {
            console.log('[AutoRecovery] Discard cooldown active — skipping (recently discarded)');
            return {
                recovered: false,
                result: '[AUTO-RECOVERY] Recently discarded items — waiting for cooldown before discarding again.'
            };
        }

        const goal = this.agent.self_prompter?.prompt || null;
        console.log('[AutoRecovery] Clearing inventory (goal-aware discard)...');

        const discardResult = await autoDiscard(this.agent.bot, 5, goal);
        this._invalidateSnapshot();
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
        }
        return this._successResult(discardResult, originalCommand);
    }

    /**
     * WRONG TOOL: Figure out what tool is needed, craft the best available, retry.
     */
    async recoverWrongTool(failResult, originalCommand) {
        // First: is inventory full? Pre-check if we can even make room before trying
        if (this.getEmptySlots() < 2) {
            const goal = this.agent.self_prompter?.prompt || null;
            const { suggestions } = getDiscardSuggestions(this.agent.bot, 2, goal);
            if (suggestions.length === 0) {
                console.log('[AutoRecovery] Inventory nearly full and no junk to discard — cannot craft tool');
                return {
                    recovered: false,
                    result: '[AUTO-RECOVERY] Need to craft a tool but inventory is full with no junk to discard. Use a chest or drop items manually.'
                };
            }
            console.log('[AutoRecovery] Inventory nearly full — clearing before tool craft');
            const discardResult = await this.recoverInventoryFull(null);
            if (!discardResult.recovered) {
                return discardResult;  // Could not clear inventory — bail out
            }
        }

        // Determine what block we're trying to work with
        const blockMatch = failResult.match(/harvest (\w+)|mine (\w+)|break (\w+)/i);
        const blockName = blockMatch ? (blockMatch[1] || blockMatch[2] || blockMatch[3]) : null;

        // Detect if this is an axe-type operation (wood, leaves) vs pickaxe (stone, ore)
        const failLower = failResult.toLowerCase();
        const needsAxe = (/(?<!pick)axe/i.test(failResult)) ||
            (blockName && (blockName.includes('log') || blockName.includes('planks') ||
             blockName.includes('wood') || blockName.includes('leaves')));
        const tierList = needsAxe ? AXE_TIERS : PICKAXE_TIERS;

        // Determine minimum tier needed — hardcoded fast-path, then dynamic minecraft-data fallback
        let minTier = 1; // default wooden
        if (!needsAxe && blockName) {
            if (BLOCK_MIN_TIER[blockName]) {
                minTier = BLOCK_MIN_TIER[blockName];
            } else {
                // Dynamic lookup: query minecraft-data harvestTools for blocks not in our map
                minTier = this._getTierFromMinecraftData(blockName) || 1;
            }
        }

        // Find the best tool we can craft right now
        const tool = await this.craftBestTool(tierList, minTier);
        if (tool) {
            console.log(`[AutoRecovery] Crafted ${tool} — retrying`);
            await this.equipItem(tool);
            return this._successResult(`Crafted and equipped ${tool}.`, originalCommand);
        }

        // Couldn't craft any suitable tool — need to gather materials
        const gathered = await this.gatherForTool(minTier);
        if (gathered) {
            const tool2 = await this.craftBestTool(tierList, minTier);
            if (tool2) {
                await this.equipItem(tool2);
                return this._successResult(`Gathered materials and crafted ${tool2}.`, originalCommand);
            }
        }

        return { 
            recovered: false, 
            result: `[AUTO-RECOVERY] Couldn't craft required tool (need tier ${minTier}+). Need to gather materials first.` 
        };
    }

    /**
     * NEED CRAFTING TABLE: Delegate to ensureCraftingTable, wrap result for recovery.
     */
    async recoverNeedCraftingTable(originalCommand) {
        if (this.getEmptySlots() < 2) {
            const discardResult = await this.recoverInventoryFull(null);
            if (!discardResult.recovered) {
                return discardResult;  // Could not clear inventory — bail out
            }
        }

        const success = await this.ensureCraftingTable();
        if (success) {
            return this._successResult('Crafting table ready.', originalCommand);
        }
        return { recovered: false, result: '[AUTO-RECOVERY] Could not obtain crafting table. No logs nearby.' };
    }

    /**
     * NEED FURNACE: Place one, or craft one (needs 8 cobblestone + crafting table).
     */
    async recoverNeedFurnace(originalCommand) {
        if (this.getEmptySlots() < 2) {
            const discardResult = await this.recoverInventoryFull(null);
            if (!discardResult.recovered) {
                return discardResult;  // Could not clear inventory — bail out
            }
        }

        // Check if we have fuel — a furnace without fuel is useless
        const hasFuel = this.findAnyItem(FUEL_TYPES);
        if (!hasFuel) {
            console.log('[AutoRecovery] No fuel available — furnace would be useless');
            return {
                recovered: false,
                result: '[AUTO-RECOVERY] Need a furnace but have no fuel (coal, charcoal, or wood). Gather fuel first.'
            };
        }

        // Have a furnace?
        if (this.hasItem('furnace')) {
            const placed = await this.placeBlock('furnace');
            if (placed) {
                return this._successResult('Placed furnace.', originalCommand);
            }
        }

        // Have 8 cobblestone? Craft it (needs crafting table)
        if (this.countItem('cobblestone') >= 8) {
            await this.ensureCraftingTable();
            await this.craftItem('furnace', 1);
            if (this.hasItem('furnace')) {
                const placed = await this.placeBlock('furnace');
                if (placed) {
                    return this._successResult('Crafted and placed furnace.', originalCommand);
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
     * Equip an item to the bot's hand. Uses fresh inventory (not cached)
     * since this typically follows a craft/collect that mutated inventory.
     */
    async equipItem(itemName) {
        try {
            const item = this.agent.bot.inventory.items().find(i => i.name === itemName);
            if (item) {
                await this.agent.bot.equip(item, 'hand');
                return true;
            }
            return false;
        } catch (e) {
            console.warn(`[AutoRecovery] Failed to equip ${itemName}: ${e.message}`);
            return false;
        }
    }

    /**
     * Get count of empty inventory slots.
     */
    getEmptySlots() {
        const slots = this.agent.bot.inventory.slots.slice(9, 45); // main inventory
        return slots.filter(s => s === null).length;
    }

    /**
     * Check if bot has an item.
     */
    hasItem(itemName) {
        return this._getItems().some(i => i.name === itemName);
    }

    /**
     * Count how many of an item the bot has.
     */
    countItem(itemName) {
        return this._getItems()
            .filter(i => i.name === itemName)
            .reduce((sum, i) => sum + i.count, 0);
    }

    /**
     * Find the first item matching any name in the list.
     */
    findAnyItem(nameList) {
        const items = this._getItems();
        for (const name of nameList) {
            if (items.some(i => i.name === name)) return name;
        }
        return null;
    }

    /**
     * Count total of any item matching a list of names.
     */
    countAnyItem(nameList) {
        const items = this._getItems();
        let total = 0;
        for (const name of nameList) {
            total += items.filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0);
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
                await this.equipItem(wp);
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
     * Query minecraft-data harvestTools to determine the minimum pickaxe tier for a block.
     * Maps tool item IDs back to our tier system. Returns null if block not found or no tool required.
     */
    _getTierFromMinecraftData(blockName) {
        try {
            const mcData = this.agent.bot.registry;
            if (!mcData) return null;

            const blockData = mcData.blocksByName?.[blockName];
            if (!blockData?.harvestTools) return null;

            // Map tool item names to tier numbers
            const TOOL_NAME_TO_TIER = {
                'wooden_pickaxe': 1, 'wooden_axe': 1,
                'stone_pickaxe': 2, 'stone_axe': 2,
                'iron_pickaxe': 3, 'iron_axe': 3,
                'diamond_pickaxe': 4, 'diamond_axe': 4,
                'netherite_pickaxe': 5, 'netherite_axe': 5,
                'golden_pickaxe': 1, 'golden_axe': 1,
            };

            // Find the lowest tier tool that can harvest this block
            let lowestTier = 5;
            for (const toolId of Object.keys(blockData.harvestTools)) {
                const item = mcData.items[parseInt(toolId)];
                if (item && TOOL_NAME_TO_TIER[item.name] !== undefined) {
                    lowestTier = Math.min(lowestTier, TOOL_NAME_TO_TIER[item.name]);
                }
            }
            return lowestTier <= 5 ? lowestTier : null;
        } catch (e) {
            console.warn(`[AutoRecovery] minecraft-data lookup failed for ${blockName}: ${e.message}`);
            return null;
        }
    }

    /**
     * Ensure a crafting table is placed nearby.
     */
    async ensureCraftingTable() {
        // Check if there's already one nearby
        const nearby = this.agent.bot.findBlock({
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
            await skills.collectBlock(this.agent.bot, blockType, count);
            this._invalidateSnapshot();
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
            const block = this.agent.bot.findBlock({
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
            await skills.craftRecipe(this.agent.bot, itemName, count);
            this._invalidateSnapshot();
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
            const pos = this.agent.bot.entity.position;
            await skills.placeBlock(
                this.agent.bot, blockName,
                Math.floor(pos.x) + 1, Math.floor(pos.y), Math.floor(pos.z),
                'bottom'
            );
            this._invalidateSnapshot();
            console.log(`[AutoRecovery] Placed ${blockName}`);
            return true;
        } catch (e) {
            console.warn(`[AutoRecovery] placeBlock(${blockName}) failed: ${e.message}`);
            return false;
        }
    }
}
