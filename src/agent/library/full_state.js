import {
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";
import convoManager from '../conversation.js';

/**
 * Get the full game state as a structured object.
 * Safe to call before the bot has fully spawned — returns safe defaults
 * for any property that isn't available yet.
 */
export function getFullState(agent) {
    const bot = agent.bot;

    // Guard: bot not connected or entity not loaded yet
    if (!bot || !bot.entity) {
        return _emptyState(agent?.name || 'unknown');
    }

    // Position — safe default if entity exists but position is undefined
    let position = { x: 0, y: 0, z: 0 };
    try {
        const pos = getPosition(bot);
        if (pos) {
            position = {
                x: Number(pos.x.toFixed(2)),
                y: Number(pos.y.toFixed(2)),
                z: Number(pos.z.toFixed(2))
            };
        }
    } catch (e) { console.warn('[FullState] position read failed, using default:', e.message); }

    // Weather
    let weather = 'Clear';
    try {
        if (bot.thunderState > 0) weather = 'Thunderstorm';
        else if (bot.rainState > 0) weather = 'Rain';
    } catch (e) { console.warn('[FullState] weather read failed, using default:', e.message); }

    // Time
    let timeLabel = 'Unknown';
    let timeOfDay = 0;
    try {
        timeOfDay = bot.time?.timeOfDay || 0;
        if (timeOfDay < 6000) timeLabel = 'Morning';
        else if (timeOfDay < 12000) timeLabel = 'Afternoon';
        else timeLabel = 'Night';
    } catch (e) { console.warn('[FullState] time read failed, using default:', e.message); }

    // Surroundings — blocks can fail if chunks aren't loaded
    let below = 'unknown', legs = 'unknown', head = 'unknown', aboveHead = 'unknown';
    try {
        const belowBlock = getBlockAtPosition(bot, 0, -1, 0);
        below = belowBlock?.name || 'unknown';
        const legsBlock = getBlockAtPosition(bot, 0, 0, 0);
        legs = legsBlock?.name || 'unknown';
        const headBlock = getBlockAtPosition(bot, 0, 1, 0);
        head = headBlock?.name || 'unknown';
        aboveHead = getFirstBlockAboveHead(bot, null, 32) || 'unknown';
    } catch (e) { console.warn('[FullState] surroundings read failed, using defaults:', e.message); }

    // Players
    let players = [], bots = [];
    try {
        players = getNearbyPlayerNames(bot);
        bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
        players = players.filter(p => !bots.includes(p));
    } catch (e) { console.warn('[FullState] players read failed, using defaults:', e.message); }

    // Inventory — can fail if inventory isn't loaded
    let counts = {}, stacksUsed = 0, totalSlots = 36;
    let equipment = { helmet: null, chestplate: null, leggings: null, boots: null, mainHand: null };
    try {
        counts = getInventoryCounts(bot);
        stacksUsed = bot.inventory.items().length;
        totalSlots = bot.inventory.slots.length;

        const helmet = bot.inventory.slots[5];
        const chestplate = bot.inventory.slots[6];
        const leggings = bot.inventory.slots[7];
        const boots = bot.inventory.slots[8];
        equipment = {
            helmet: helmet ? helmet.name : null,
            chestplate: chestplate ? chestplate.name : null,
            leggings: leggings ? leggings.name : null,
            boots: boots ? boots.name : null,
            mainHand: bot.heldItem ? bot.heldItem.name : null
        };
    } catch (e) { console.warn('[FullState] inventory read failed, using defaults:', e.message); }

    // Entity types
    let entityTypes = [];
    try {
        entityTypes = getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item');
    } catch (e) { console.warn('[FullState] entityTypes read failed, using default:', e.message); }

    // Modes
    let modesSummary = '';
    try {
        modesSummary = bot.modes?.getMiniDocs() || '';
    } catch (e) { console.warn('[FullState] modes read failed, using default:', e.message); }

    return {
        name: agent.name,
        gameplay: {
            position,
            dimension: bot.game?.dimension || 'overworld',
            gamemode: bot.game?.gameMode || 'survival',
            health: Math.round(bot.health ?? 20),
            hunger: Math.round(bot.food ?? 20),
            biome: _safeBiome(bot),
            weather,
            timeOfDay,
            timeLabel
        },
        action: {
            current: agent.isIdle() ? 'Idle' : agent.actions.currentActionLabel,
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: aboveHead
        },
        inventory: {
            counts,
            stacksUsed,
            totalSlots,
            equipment
        },
        nearby: {
            humanPlayers: players,
            botPlayers: bots,
            entityTypes,
        },
        modes: {
            summary: modesSummary
        }
    };
}

/**
 * Return a minimal empty state for when the bot isn't connected.
 */
function _emptyState(name) {
    return {
        name,
        gameplay: {
            position: { x: 0, y: 0, z: 0 },
            dimension: 'overworld',
            gamemode: 'survival',
            health: 20,
            hunger: 20,
            biome: 'unknown',
            weather: 'Clear',
            timeOfDay: 0,
            timeLabel: 'Unknown'
        },
        action: { current: 'Idle', isIdle: true },
        surroundings: { below: 'unknown', legs: 'unknown', head: 'unknown', firstBlockAboveHead: 'unknown' },
        inventory: {
            counts: {},
            stacksUsed: 0,
            totalSlots: 36,
            equipment: { helmet: null, chestplate: null, leggings: null, boots: null, mainHand: null }
        },
        nearby: { humanPlayers: [], botPlayers: [], entityTypes: [] },
        modes: { summary: '' }
    };
}

/**
 * Safe biome lookup — getBiomeName can throw if chunks aren't loaded.
 */
function _safeBiome(bot) {
    try {
        return getBiomeName(bot) || 'unknown';
    } catch (e) {
        console.warn('[FullState] biome read failed, using default:', e.message);
        return 'unknown';
    }
}
