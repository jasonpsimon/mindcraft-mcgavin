/**
 * Procedural Memory — Learned action sequences with confidence tracking.
 *
 * Stores (context → action → result) tuples from successful command executions.
 * Over time, high-confidence entries allow the bot to execute actions directly
 * without calling the LLM, reducing inference cost and latency.
 *
 * Context keys are built from: current goal + last user message + relevant game state.
 * Actions are the exact command strings the bot used.
 * Results track success/failure counts to build confidence scores.
 *
 * File-backed persistence to ./bots/{name}/procedural_memory.json
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

export class ProceduralMemory {
    constructor(agentName, options = {}) {
        this.agentName = agentName;
        this.memoryDir = `./bots/${agentName}`;
        this.memoryFile = `${this.memoryDir}/procedural_memory.json`;

        // Map of contextHash → ProceduralEntry
        this.entries = new Map();

        // Config
        this.maxEntries = options.maxEntries || 1000;
        this.decayRate = options.decayRate || 0.01; // confidence decay per hour unused
        this.minSuccessesForBypass = options.minSuccessesForBypass || 3; // need at least N successes before bypass is considered

        // Debounced save: batch writes instead of blocking on every recordAction()
        this._saveTimer = null;
        this._saveDebounceMs = options.saveDebounceMs || 5000; // flush every 5s
        this._dirty = false;

        this.load();
    }

    /**
     * Build a context key from the current situation.
     * Combines goal, trigger message, and relevant state into a hashable string.
     */
    buildContextKey(goal, triggerMessage, stateSnapshot = null) {
        // Normalize inputs
        const parts = [];

        if (goal) parts.push(`goal:${goal.trim().toLowerCase()}`);
        if (triggerMessage) parts.push(`trigger:${this._normalizeMessage(triggerMessage)}`);

        // Include relevant state dimensions (not full state — just what matters for action selection)
        if (stateSnapshot) {
            if (stateSnapshot.hasCraftingTable !== undefined)
                parts.push(`craft:${stateSnapshot.hasCraftingTable}`);
            if (stateSnapshot.hasPickaxe !== undefined)
                parts.push(`pick:${stateSnapshot.hasPickaxe}`);
            if (stateSnapshot.biome)
                parts.push(`biome:${stateSnapshot.biome}`);
            if (stateSnapshot.timeLabel)
                parts.push(`time:${stateSnapshot.timeLabel}`);
            if (stateSnapshot.health !== undefined)
                parts.push(`hp:${stateSnapshot.health <= 6 ? 'low' : stateSnapshot.health <= 14 ? 'mid' : 'high'}`);
            if (stateSnapshot.hunger !== undefined)
                parts.push(`food:${stateSnapshot.hunger <= 6 ? 'low' : stateSnapshot.hunger <= 14 ? 'mid' : 'high'}`);
        }

        const contextString = parts.join('|');
        return this._hash(contextString);
    }

    /**
     * Record an action execution result.
     * Called after every command execution with whether it succeeded.
     */
    recordAction(contextHash, command, success, metadata = {}) {
        let entry = this.entries.get(contextHash);

        if (!entry) {
            entry = {
                contextHash,
                command,
                successes: 0,
                failures: 0,
                lastUsed: Date.now(),
                createdAt: Date.now(),
                metadata // stores original goal, trigger, etc. for debugging
            };
            this.entries.set(contextHash, entry);
        }

        if (success) {
            entry.successes++;
        } else {
            entry.failures++;
        }
        entry.lastUsed = Date.now();

        // If the command changed (LLM gave a different answer), update it on success
        if (success && command !== entry.command) {
            entry.command = command;
        }

        this._enforceMaxEntries();
        this.save();

        return entry;
    }

    /**
     * Look up a procedural memory entry by context hash.
     * Returns null if no entry exists.
     */
    lookup(contextHash) {
        const entry = this.entries.get(contextHash);
        if (!entry) return null;

        // Apply time-based decay to the effective confidence
        const hoursUnused = (Date.now() - entry.lastUsed) / (1000 * 60 * 60);
        entry._effectiveConfidence = this._calculateConfidence(entry, hoursUnused);

        return entry;
    }

    /**
     * Calculate raw confidence score for an entry.
     * Based on success ratio, total attempts, and time decay.
     */
    _calculateConfidence(entry, hoursUnused = 0) {
        const total = entry.successes + entry.failures;
        if (total === 0) return 0;

        // Base confidence from success ratio
        const successRatio = entry.successes / total;

        // Scale up with more data points (Wilson score lower bound approximation)
        // With few data points, confidence is pulled toward 0.5
        const z = 1.96; // 95% confidence interval
        const n = total;
        const phat = successRatio;
        const wilsonLower = (phat + z*z/(2*n) - z * Math.sqrt((phat*(1-phat) + z*z/(4*n))/n)) / (1 + z*z/n);

        // Apply time decay
        const decay = Math.max(0, 1 - (this.decayRate * hoursUnused));

        return Math.max(0, Math.min(1, wilsonLower * decay));
    }

    /**
     * Check if an entry has enough data to be considered for LLM bypass.
     */
    isReliable(entry) {
        if (!entry) return false;
        return (entry.successes >= this.minSuccessesForBypass);
    }

    /**
     * Get all entries sorted by confidence (highest first).
     * Useful for debugging and inspection.
     */
    getTopEntries(limit = 20) {
        const entries = Array.from(this.entries.values());
        const now = Date.now();

        return entries
            .map(e => ({
                ...e,
                confidence: this._calculateConfidence(e, (now - e.lastUsed) / (1000 * 60 * 60))
            }))
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, limit);
    }

    /**
     * Normalize a user message for consistent context matching.
     * Strips player names, lowercases, removes extra whitespace.
     */
    _normalizeMessage(message) {
        return message
            .replace(/^[^:]+:\s*/, '') // strip "username: " prefix
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    _hash(str) {
        return createHash('sha256').update(str).digest('hex').substring(0, 16);
    }

    /**
     * Evict least-useful entries when over capacity.
     * Scores by confidence * recency, removes lowest.
     */
    _enforceMaxEntries() {
        if (this.entries.size <= this.maxEntries) return;

        const now = Date.now();
        const scored = Array.from(this.entries.entries()).map(([hash, entry]) => {
            const hoursUnused = (now - entry.lastUsed) / (1000 * 60 * 60);
            const confidence = this._calculateConfidence(entry, hoursUnused);
            const recencyBonus = 1 / (1 + hoursUnused / 24); // decays over days
            return { hash, score: confidence * 0.7 + recencyBonus * 0.3 };
        });

        scored.sort((a, b) => a.score - b.score);
        const toRemove = scored.slice(0, this.entries.size - this.maxEntries);
        for (const { hash } of toRemove) {
            this.entries.delete(hash);
        }
    }

    /**
     * Schedule a debounced save. Batches multiple writes into one I/O operation.
     * If called multiple times within the debounce window, only the last triggers a write.
     */
    save() {
        this._dirty = true;
        if (this._saveTimer) return; // already scheduled

        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._flushSave();
        }, this._saveDebounceMs);
    }

    /**
     * Actually write to disk (async, non-blocking).
     */
    async _flushSave() {
        if (!this._dirty) return;
        this._dirty = false;

        try {
            await mkdir(this.memoryDir, { recursive: true });
            const data = Object.fromEntries(this.entries);
            await writeFile(this.memoryFile, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Failed to save procedural memory:', error);
        }
    }

    /**
     * Force an immediate save (e.g., on shutdown).
     */
    async saveNow() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        await this._flushSave();
    }

    load() {
        try {
            if (!existsSync(this.memoryFile)) return;
            const data = JSON.parse(readFileSync(this.memoryFile, 'utf8'));
            this.entries = new Map(Object.entries(data));
            console.log(`Loaded ${this.entries.size} procedural memory entries for ${this.agentName}`);
        } catch (error) {
            console.error('Failed to load procedural memory:', error);
            this.entries = new Map();
        }
    }

    async clear() {
        this.entries = new Map();
        await this.saveNow(); // immediate write on explicit clear
    }

    getStats(highThreshold = 0.85, mediumThreshold = 0.5) {
        const entries = Array.from(this.entries.values());
        const now = Date.now();
        let highConf = 0, medConf = 0, lowConf = 0;

        for (const entry of entries) {
            const hours = (now - entry.lastUsed) / (1000 * 60 * 60);
            const conf = this._calculateConfidence(entry, hours);
            if (conf >= highThreshold) highConf++;
            else if (conf >= mediumThreshold) medConf++;
            else lowConf++;
        }

        return {
            totalEntries: entries.length,
            highConfidence: highConf,
            mediumConfidence: medConf,
            lowConfidence: lowConf,
            totalSuccesses: entries.reduce((sum, e) => sum + e.successes, 0),
            totalFailures: entries.reduce((sum, e) => sum + e.failures, 0)
        };
    }
}
