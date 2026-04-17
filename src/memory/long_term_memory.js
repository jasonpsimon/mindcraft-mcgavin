/**
 * Long-Term Memory — Persistent knowledge that survives restarts.
 *
 * Uses a second Vectra LocalIndex (separate from episodic memory) to store
 * durable knowledge: base locations, resource maps, player preferences,
 * learned strategies, and facts extracted from gameplay.
 *
 * Unlike episodic memory (which stores raw conversation chunks), long-term
 * memory stores distilled knowledge as discrete facts with categories.
 *
 * Categories:
 *   - place     — named locations (base, farms, portals, death sites)
 *   - resource  — where resources were found, quantities
 *   - player    — player preferences, behavior patterns
 *   - strategy  — what worked/failed for specific tasks
 *   - fact      — general learned knowledge (recipes, mechanics, etc.)
 *
 * Replaces the trivial memory_bank.js (24-line key-value store) with
 * semantic search across all stored knowledge.
 *
 * Stored at: ./bots/{name}/longterm_index/
 */

import { formatAge, wordOverlapScore, initVectraIndex } from './memory_utils.js';
import { logRecall } from '../observability/recall_log.js';

const VALID_CATEGORIES = ['place', 'resource', 'player', 'strategy', 'fact'];

export class LongTermMemory {
    constructor(agentName, embeddingModel = null, options = {}) {
        this.agentName = agentName;
        this.embeddingModel = embeddingModel;

        this.indexPath = `./bots/${agentName}/longterm_index`;
        this.index = null;
        this._indexReady = false;

        // Config
        this.maxFacts = options.maxFacts || 1000;
        this.topK = options.topK || 5;

        // In-memory cache for fast access and backwards compatibility with memory_bank
        this.facts = new Map(); // id → { text, category, metadata, timestamp }

        // Legacy place storage (backwards compatible with MemoryBank)
        this.places = new Map(); // name → [x, y, z]
    }

    /**
     * Ensure the Vectra index is created and ready.
     */
    async _ensureIndex() {
        if (this._indexReady) return;

        try {
            const { index, items } = await initVectraIndex(this.indexPath, 'LongTermMemory');
            this.index = index;

            for (const item of items) {
                this.facts.set(item.id, {
                    text: item.metadata.text,
                    category: item.metadata.category,
                    metadata: item.metadata,
                    timestamp: item.metadata.timestamp
                });

                // Rebuild places cache from stored place facts
                if (item.metadata.category === 'place' && item.metadata.coords) {
                    this.places.set(item.metadata.name, item.metadata.coords);
                }
            }

            if (items.length > 0) {
                console.log(`[LongTermMemory] Cached ${this.facts.size} facts for ${this.agentName}`);
            }

            this._indexReady = true;
        } catch (err) {
            console.error('[LongTermMemory] Failed to initialize Vectra index:', err.message);
            this._indexReady = false;
        }
    }

    // ==================== STORE METHODS ====================

    /**
     * Store a fact with a category.
     *
     * @param {string} text - The knowledge to store
     * @param {string} category - One of: place, resource, player, strategy, fact
     * @param {object} metadata - Additional context
     * @returns {object} The stored fact
     */
    async store(text, category = 'fact', metadata = {}) {
        if (!VALID_CATEGORIES.includes(category)) {
            console.warn(`[LongTermMemory] Invalid category "${category}", defaulting to "fact"`);
            category = 'fact';
        }

        // Check for duplicates — upsert if similar fact exists
        const existing = await this._findDuplicate(text, category);
        if (existing) {
            return this._updateFact(existing.id, text, metadata);
        }

        const id = `ltm-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const timestamp = Date.now();

        const itemMetadata = {
            text,
            category,
            timestamp,
            ...metadata
        };

        // Store in Vectra with embedding
        if (this.embeddingModel) {
            try {
                await this._ensureIndex();
                const vector = await this.embeddingModel.embed(text);
                if (this.index && vector) {
                    await this.index.insertItem({ id, vector, metadata: itemMetadata });
                }
            } catch (err) {
                console.warn('[LongTermMemory] Vectra insert failed:', err.message);
            }
        }

        // Always cache in memory
        this.facts.set(id, { text, category, metadata: itemMetadata, timestamp });
        await this._enforceMaxFacts();

        console.log(`[LongTermMemory] Stored ${category}: "${text.substring(0, 60)}..."`);
        return { id, text, category, metadata: itemMetadata };
    }

    /**
     * Store a named place (backwards compatible with MemoryBank.rememberPlace).
     */
    async rememberPlace(name, x, y, z) {
        const coords = [x, y, z];
        this.places.set(name, coords);

        const text = `Location "${name}" is at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}`;
        await this.store(text, 'place', { name, coords });
    }

    /**
     * Store a resource location.
     */
    async rememberResource(resource, x, y, z, quantity = null) {
        const qtyStr = quantity ? ` (${quantity} found)` : '';
        const text = `Found ${resource}${qtyStr} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}`;
        await this.store(text, 'resource', { resource, coords: [x, y, z], quantity });
    }

    /**
     * Store a player preference or observation.
     */
    async rememberPlayer(playerName, observation) {
        const text = `Player ${playerName}: ${observation}`;
        await this.store(text, 'player', { playerName });
    }

    /**
     * Store a strategy that worked or failed.
     */
    async rememberStrategy(task, strategy, success) {
        const outcome = success ? 'succeeded' : 'failed';
        const text = `Strategy for "${task}": ${strategy} — ${outcome}`;
        await this.store(text, 'strategy', { task, success });
    }

    // ==================== RECALL METHODS ====================

    /**
     * Recall a named place (backwards compatible with MemoryBank.recallPlace).
     */
    recallPlace(name) {
        return this.places.get(name) || null;
    }

    /**
     * Query long-term memory by semantic similarity.
     *
     * @param {string} query - What to search for
     * @param {number} k - Number of results
     * @param {string} category - Optional category filter
     * @returns {Array} Top-K matching facts
     */
    async recall(query, k = null, category = null) {
        k = k || this.topK;
        if (this.facts.size === 0) {
            // BT-4: empty corpus is a distinct retrieval outcome.
            logRecall({ subsystem: 'long_term', query, k, returned: 0, backend: 'none', extras: { category: category || null } });
            return [];
        }

        // Try Vectra semantic search. BT-4: hoist the filtered result
        // out of the try block so logRecall fires outside the catch
        // (symmetric with episodic retrieve).
        let vectraFiltered = null;
        if (this.embeddingModel && this._indexReady && this.index) {
            try {
                const queryVector = await this.embeddingModel.embed(query);
                const results = await this.index.queryItems(queryVector, k * 2); // over-fetch for filtering

                let filtered = results.map(r => ({
                    id: r.item.id,
                    text: r.item.metadata.text,
                    category: r.item.metadata.category,
                    metadata: r.item.metadata,
                    score: r.score
                }));

                if (category) {
                    filtered = filtered.filter(r => r.category === category);
                }

                vectraFiltered = filtered.slice(0, k);
            } catch (err) {
                console.warn('[LongTermMemory] Vectra query failed, using word overlap:', err.message);
            }
        }

        if (vectraFiltered) {
            logRecall({
                subsystem: 'long_term', query, k,
                returned: vectraFiltered.length, backend: 'vectra',
                top_score: vectraFiltered[0]?.score,
                top_text: vectraFiltered[0]?.text,
                extras: {
                    category: category || null,
                    category_top: vectraFiltered[0]?.category || null,
                },
            });
            return vectraFiltered;
        }

        // Fallback: word overlap on cache
        const fallback = this._wordOverlapRecall(query, k, category);
        logRecall({
            subsystem: 'long_term', query, k,
            returned: fallback.length, backend: 'word-overlap',
            top_score: fallback[0]?.score,
            top_text: fallback[0]?.text,
            extras: {
                category: category || null,
                category_top: fallback[0]?.category || null,
            },
        });
        return fallback;
    }

    /**
     * Get all places (backwards compatible with MemoryBank.getKeys).
     */
    getPlaceKeys() {
        return Array.from(this.places.keys()).join(', ');
    }

    /**
     * Get all places as JSON (backwards compatible with MemoryBank.getJson).
     */
    getPlacesJson() {
        return Object.fromEntries(this.places);
    }

    /**
     * Format relevant long-term knowledge for the LLM prompt.
     *
     * @param {string} query - Current context
     * @param {number} k - Number of facts to retrieve
     * @returns {string} Formatted knowledge string
     */
    async getFormattedKnowledge(query, k = null) {
        const facts = await this.recall(query, k);
        if (facts.length === 0) return '';

        const parts = facts.map(f => {
            const age = formatAge(f.metadata?.timestamp || f.timestamp);
            return `[${f.category}|${age}] ${f.text}`;
        });

        return 'Long-term knowledge:\n' + parts.join('\n');
    }

    // ==================== INTERNAL METHODS ====================

    /**
     * Check for a semantically similar fact to avoid duplicates.
     */
    async _findDuplicate(text, category) {
        if (this.embeddingModel && this._indexReady && this.index) {
            try {
                const vector = await this.embeddingModel.embed(text);
                const results = await this.index.queryItems(vector, 3);

                for (const r of results) {
                    if (r.score > 0.92 && r.item.metadata.category === category) {
                        return { id: r.item.id, ...r.item.metadata };
                    }
                }
            } catch (err) {
                // Fall through to no-duplicate
            }
        }

        // Fallback: exact text match in cache
        for (const [id, fact] of this.facts) {
            if (fact.text === text && fact.category === category) {
                return { id, ...fact };
            }
        }

        return null;
    }

    /**
     * Update an existing fact with new text/metadata.
     */
    async _updateFact(id, text, metadata) {
        const timestamp = Date.now();
        const existing = this.facts.get(id);
        if (!existing) return null;

        const updated = {
            text,
            category: existing.category,
            metadata: { ...existing.metadata, ...metadata, text, timestamp },
            timestamp
        };

        this.facts.set(id, updated);

        // Update in Vectra
        if (this.embeddingModel && this._indexReady && this.index) {
            try {
                const vector = await this.embeddingModel.embed(text);
                // Delete old and insert new (Vectra upsert)
                await this.index.deleteItem(id).catch(() => {});
                await this.index.insertItem({ id, vector, metadata: updated.metadata });
            } catch (err) {
                console.warn('[LongTermMemory] Vectra update failed:', err.message);
            }
        }

        console.log(`[LongTermMemory] Updated ${existing.category}: "${text.substring(0, 60)}..."`);
        return { id, ...updated };
    }

    /**
     * Word-overlap fallback recall.
     */
    _wordOverlapRecall(query, k, category = null) {
        let entries = Array.from(this.facts.entries());

        if (category) {
            entries = entries.filter(([_, f]) => f.category === category);
        }

        const scored = entries.map(([id, fact]) => ({
            id,
            text: fact.text,
            category: fact.category,
            metadata: fact.metadata,
            timestamp: fact.timestamp,
            score: wordOverlapScore(query, fact.text)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k);
    }


    /**
     * Evict oldest, lowest-value facts when over capacity.
     */
    async _enforceMaxFacts() {
        if (this.facts.size <= this.maxFacts) return;

        const now = Date.now();
        const scored = Array.from(this.facts.entries()).map(([id, fact]) => {
            const ageHours = (now - fact.timestamp) / (1000 * 60 * 60);
            const recency = 1 / (1 + ageHours / 168); // decays over weeks (not days)
            // Places and strategies are more valuable long-term
            const categoryBoost = (fact.category === 'place' || fact.category === 'strategy') ? 0.3 : 0;
            return { id, score: recency + categoryBoost };
        });

        scored.sort((a, b) => a.score - b.score);
        const toRemove = scored.slice(0, this.facts.size - this.maxFacts);

        for (const { id } of toRemove) {
            this.facts.delete(id);
            if (this.index && this._indexReady) {
                try { await this.index.deleteItem(id); } catch (err) { /* ok */ }
            }
        }
    }

    /**
     * Initialize with embedding model (called after prompter is ready).
     */
    async init(embeddingModel) {
        this.embeddingModel = embeddingModel;
        await this._ensureIndex();
    }

    async clear() {
        this.facts.clear();
        this.places.clear();
        if (this.index && this._indexReady) {
            try {
                await this.index.deleteIndex();
                await this.index.createIndex();
            } catch (err) {
                console.warn('[LongTermMemory] Failed to clear index:', err.message);
            }
        }
    }

    getStats() {
        const categories = {};
        for (const fact of this.facts.values()) {
            categories[fact.category] = (categories[fact.category] || 0) + 1;
        }
        return {
            totalFacts: this.facts.size,
            totalPlaces: this.places.size,
            categories,
            vectraReady: this._indexReady,
            hasEmbeddingModel: !!this.embeddingModel
        };
    }
}
