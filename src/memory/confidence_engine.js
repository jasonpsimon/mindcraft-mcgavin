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
import { logRecall } from '../observability/recall_log.js';

// Decision levels
export const CONFIDENCE_HIGH = 'HIGH';
export const CONFIDENCE_MEDIUM = 'MEDIUM';
export const CONFIDENCE_LOW = 'LOW';

export class ConfidenceEngine {
    constructor(agentName, options = {}) {
        this.agentName = agentName;
        this.procedural = new ProceduralMemory(agentName, options);

        // Thresholds (configurable via settings)
        this.highThreshold = options.highThreshold || 0.98;
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

        // Safety: commands that should never be bypassed (destructive/risky or context-dependent)
        this.neverBypass = new Set(options.neverBypass || [
            '!attack',
            '!attackPlayer',
            '!newAction',       // code generation needs full reasoning
            '!goal',
            '!endGoal',
            '!collectBlocks',   // highly dependent on nearby blocks
            '!digDown',         // depends on current position/surroundings
            '!searchForBlock',  // needs LLM to pick the right block type
            '!goToCoordinates', // destination depends on current context
            '!goToPlayer',      // social context matters
            '!followPlayer',    // social context matters
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

        // BT-4 (option A): single-exit restructure so one [MemoryRecall]
        // line fires per evaluate() call. Each branch still bumps exactly
        // one stats counter and populates a {level, action, confidence,
        // contextHash} result — shape is consumed by agent.js:856 and by
        // buildSuggestionFromResult(). Checked by diff: every
        // stats.X++ / return pair in the 4-return original maps 1:1
        // to a stats.X++ / result = assignment below, branch order
        // preserved. Post-deploy invariant:
        //   stats.totalDecisions === bypassed + suggested + fullReasoning
        let result;
        if (!entry) {
            // No memory of this context
            this.stats.fullReasoning++;
            result = {
                level: CONFIDENCE_LOW,
                action: null,
                confidence: 0,
                contextHash
            };
        } else {
            const confidence = entry._effectiveConfidence;
            const isReliable = this.procedural.isReliable(entry);

            // Check if the cached command is in the never-bypass list
            const commandName = this._extractCommandName(entry.command);
            const canBypass = commandName && !this.neverBypass.has(commandName);

            if (confidence >= this.highThreshold && isReliable && canBypass) {
                // HIGH confidence + reliable + safe to bypass
                this.stats.bypassed++;
                result = {
                    level: CONFIDENCE_HIGH,
                    action: entry.command,
                    confidence,
                    contextHash
                };
            } else if (confidence >= this.mediumThreshold && isReliable) {
                // MEDIUM confidence — suggest but still call LLM
                this.stats.suggested++;
                result = {
                    level: CONFIDENCE_MEDIUM,
                    action: entry.command,
                    confidence,
                    contextHash
                };
            } else {
                // LOW confidence — full LLM reasoning
                this.stats.fullReasoning++;
                result = {
                    level: CONFIDENCE_LOW,
                    action: entry.command, // still available for reference, but not used
                    confidence,
                    contextHash
                };
            }
        }

        // BT-4: one [MemoryRecall] line per evaluate() call. try/catch
        // is defense-in-depth — logRecall is already non-throwing, but
        // a future refactor breaking that contract must not propagate
        // into the agent hot path.
        try {
            logRecall({
                subsystem: 'confidence',
                query: goal || '',
                k: 1,                     // procedural lookup is exact-match, not top-K
                returned: entry ? 1 : 0,
                backend: 'map',           // procedural memory is a hash map, not a vector index
                top_score: result.confidence,
                top_text: entry?.command,
                extras: {
                    trigger: triggerMessage || '',
                    tier: result.level,
                    threshold_high: this.highThreshold,
                    threshold_med: this.mediumThreshold,
                    context_hash: (contextHash || '').slice(0, 12),
                    record_count: this.procedural.entries.size,
                },
            });
        } catch (err) {
            console.warn('[ConfidenceEngine] recall log failed:', err?.message ?? err);
        }

        return result;
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
     *
     * @param {object} evaluateResult - The object returned by evaluate()
     *   Must have { action: string, confidence: number }
     * @returns {string} Hint string, or '' if input is invalid
     */
    buildSuggestionFromResult(evaluateResult) {
        if (!evaluateResult || typeof evaluateResult.confidence !== 'number' || !evaluateResult.action) return '';
        return `\n[Memory hint: A similar situation was handled with "${evaluateResult.action}" (confidence: ${(evaluateResult.confidence * 100).toFixed(0)}%). Consider this approach, but use your judgment.]\n`;
    }

    /**
     * Get engine statistics for monitoring.
     */
    getStats() {
        return {
            ...this.stats,
            proceduralStats: this.procedural.getStats(this.highThreshold, this.mediumThreshold),
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
