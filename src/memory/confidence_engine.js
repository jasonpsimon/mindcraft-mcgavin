/**
 * Confidence Engine — Decides whether to bypass the LLM based on procedural memory.
 *
 * Three decision levels:
 *   HIGH   (≥ 0.85) → Execute cached action directly, no LLM call
 *   MEDIUM (0.5–0.84) → Call LLM but provide cached action as a suggestion
 *   LOW    (< 0.5)  → Full LLM reasoning, no hint from procedural memory
 *
 * The engine also extracts a lightweight state snapshot from the game state
 * to use as part of the procedural memory context key.
 */

import { ProceduralMemory } from './procedural_memory.js';

// Decision levels
export const CONFIDENCE_HIGH = 'HIGH';
export const CONFIDENCE_MEDIUM = 'MEDIUM';
export const CONFIDENCE_LOW = 'LOW';

export class ConfidenceEngine {
    constructor(agentName, options = {}) {
        this.agentName = agentName;
        this.procedural = new ProceduralMemory(agentName, options);

        // Thresholds (configurable via settings)
        this.highThreshold = options.highThreshold || 0.85;
        this.mediumThreshold = options.mediumThreshold || 0.5;

        // Stats tracking
        this.stats = {
            totalDecisions: 0,
            bypassed: 0,      // HIGH confidence, skipped LLM
            suggested: 0,     // MEDIUM confidence, LLM with hint
            fullReasoning: 0, // LOW confidence, full LLM
            bypassSuccesses: 0,
            bypassFailures: 0
        };

        // Safety: commands that should never be bypassed (destructive/risky)
        this.neverBypass = new Set(options.neverBypass || [
            '!attack',
            '!attackPlayer',
            '!newAction',  // code generation needs full reasoning
            '!goal',
            '!endGoal',
        ]);
    }

    /**
     * Make a decision about how to handle the current action.
     *
     * @param {string} goal - Current self-prompt goal (or null)
     * @param {string} triggerMessage - The message that triggered this action
     * @param {object} gameState - Output from getFullState() or similar
     * @returns {{ level: string, action: string|null, confidence: number, contextHash: string }}
     */
    evaluate(goal, triggerMessage, gameState = null) {
        this.stats.totalDecisions++;

        const stateSnapshot = gameState ? this._extractStateSnapshot(gameState) : null;
        const contextHash = this.procedural.buildContextKey(goal, triggerMessage, stateSnapshot);
        const entry = this.procedural.lookup(contextHash);

        // No memory of this context
        if (!entry) {
            this.stats.fullReasoning++;
            return {
                level: CONFIDENCE_LOW,
                action: null,
                confidence: 0,
                contextHash
            };
        }

        const confidence = entry._effectiveConfidence;
        const isReliable = this.procedural.isReliable(entry);

        // Check if the cached command is in the never-bypass list
        const commandName = this._extractCommandName(entry.command);
        const canBypass = commandName && !this.neverBypass.has(commandName);

        // HIGH confidence + reliable + safe to bypass
        if (confidence >= this.highThreshold && isReliable && canBypass) {
            this.stats.bypassed++;
            return {
                level: CONFIDENCE_HIGH,
                action: entry.command,
                confidence,
                contextHash
            };
        }

        // MEDIUM confidence — suggest but still call LLM
        if (confidence >= this.mediumThreshold && isReliable) {
            this.stats.suggested++;
            return {
                level: CONFIDENCE_MEDIUM,
                action: entry.command,
                confidence,
                contextHash
            };
        }

        // LOW confidence — full LLM reasoning
        this.stats.fullReasoning++;
        return {
            level: CONFIDENCE_LOW,
            action: entry.command, // still available for reference, but not used
            confidence,
            contextHash
        };
    }

    /**
     * Record the outcome of an action for learning.
     * Call this after every command execution.
     *
     * @param {string} contextHash - From the evaluate() result
     * @param {string} command - The command that was actually executed
     * @param {boolean} success - Whether the command succeeded
     * @param {boolean} wasBypassed - Whether this was a direct bypass (no LLM)
     * @param {object} metadata - Additional context for debugging
     */
    recordOutcome(contextHash, command, success, wasBypassed = false, metadata = {}) {
        this.procedural.recordAction(contextHash, command, success, metadata);

        if (wasBypassed) {
            if (success) {
                this.stats.bypassSuccesses++;
            } else {
                this.stats.bypassFailures++;
                // If a bypass failed, the confidence will naturally drop
                // via the procedural memory's success/failure tracking
                console.warn(`[ConfidenceEngine] Bypass failed for command: ${command}`);
            }
        }
    }

    /**
     * Extract a minimal state snapshot for context matching.
     * Only includes dimensions that affect action selection.
     */
    _extractStateSnapshot(gameState) {
        const snapshot = {};

        if (gameState.gameplay) {
            snapshot.biome = gameState.gameplay.biome;
            snapshot.timeLabel = gameState.gameplay.timeLabel;
            snapshot.health = gameState.gameplay.health;
            snapshot.hunger = gameState.gameplay.hunger;
        }

        if (gameState.inventory?.counts) {
            const inv = gameState.inventory.counts;
            snapshot.hasCraftingTable = !!(inv['crafting_table']);
            snapshot.hasPickaxe = !!(
                inv['wooden_pickaxe'] || inv['stone_pickaxe'] ||
                inv['iron_pickaxe'] || inv['diamond_pickaxe'] ||
                inv['netherite_pickaxe']
            );
        }

        return snapshot;
    }

    /**
     * Extract the command name from a full response string.
     * e.g., "Let me collect some wood. !collectBlocks('oak_log', 10)" → "!collectBlocks"
     */
    _extractCommandName(text) {
        if (!text) return null;
        const match = text.match(/!([\w]+)/);
        return match ? `!${match[1]}` : null;
    }

    /**
     * Build a suggestion string to inject into the LLM prompt for MEDIUM confidence.
     * Gives the LLM a hint without forcing the action.
     */
    buildSuggestion(entry) {
        if (!entry || !entry.action) return '';
        return `\n[Memory hint: A similar situation was handled with "${entry.action}" (confidence: ${(entry.confidence * 100).toFixed(0)}%). Consider this approach, but use your judgment.]\n`;
    }

    /**
     * Get engine statistics for monitoring.
     */
    getStats() {
        return {
            ...this.stats,
            proceduralStats: this.procedural.getStats(),
            bypassRate: this.stats.totalDecisions > 0
                ? (this.stats.bypassed / this.stats.totalDecisions * 100).toFixed(1) + '%'
                : '0%',
            bypassAccuracy: (this.stats.bypassSuccesses + this.stats.bypassFailures) > 0
                ? (this.stats.bypassSuccesses / (this.stats.bypassSuccesses + this.stats.bypassFailures) * 100).toFixed(1) + '%'
                : 'N/A'
        };
    }

    /**
     * Reset runtime stats (not procedural memory).
     */
    resetStats() {
        this.stats = {
            totalDecisions: 0,
            bypassed: 0,
            suggested: 0,
            fullReasoning: 0,
            bypassSuccesses: 0,
            bypassFailures: 0
        };
    }
}
