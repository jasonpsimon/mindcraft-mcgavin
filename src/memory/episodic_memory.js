/**
 * Episodic Memory — Semantic event storage replacing the lossy 500-char summary.
 *
 * Uses Vectra (pure Node.js, file-backed vector index) for storage and
 * semantic retrieval. No external server needed — sub-millisecond lookups.
 *
 * Architecture:
 *   - Each "episode" is a chunk of conversation turns + metadata
 *   - Episodes are embedded using the model's embed() function
 *   - Stored in a Vectra LocalIndex at ./bots/{name}/episodic_index/
 *   - Retrieval: embed the current context, query Vectra for top-K similar
 *   - Falls back to word-overlap similarity if embedding model is unavailable
 *
 * Replaces the summarizeMemories() flow in history.js:
 *   OLD: chunk 5 turns → LLM summarize → truncate to 500 chars → single string
 *   NEW: chunk turns → embed → store in Vectra → retrieve top-K at prompt time
 */

import { LocalIndex } from 'vectra';
import { mkdirSync, existsSync } from 'fs';

export class EpisodicMemory {
    constructor(agentName, embeddingModel = null, options = {}) {
        this.agentName = agentName;
        this.embeddingModel = embeddingModel;

        // Vectra index directory
        this.indexPath = `./bots/${agentName}/episodic_index`;
        this.index = null; // initialized lazily in _ensureIndex()
        this._indexReady = false;

        // Config
        this.maxEpisodes = options.maxEpisodes || 500;
        this.topK = options.topK || 3;
        this.maxTokensPerEpisode = options.maxTokensPerEpisode || 300;

        // In-memory fallback for when Vectra or embeddings aren't available
        // Also serves as a fast lookup for metadata (Vectra stores metadata but
        // listing all items for eviction scoring is cheaper from memory)
        this.episodeCache = [];
        this.nextId = 0;
    }

    /**
     * Ensure the Vectra index is created and ready.
     * Called lazily on first write/read operation.
     */
    async _ensureIndex() {
        if (this._indexReady) return;

        try {
            mkdirSync(this.indexPath, { recursive: true });
            this.index = new LocalIndex(this.indexPath);

            if (!await this.index.isIndexCreated()) {
                await this.index.createIndex();
                console.log(`[EpisodicMemory] Created Vectra index at ${this.indexPath}`);
            } else {
                // Load existing items into cache
                const items = await this.index.listItems();
                this.episodeCache = items.map(item => ({
                    id: item.id,
                    text: item.metadata.text,
                    timestamp: item.metadata.timestamp,
                    metadata: item.metadata
                }));
                this.nextId = this.episodeCache.length > 0
                    ? Math.max(...this.episodeCache.map(e => parseInt(e.id.replace('ep-', '')) || 0)) + 1
                    : 0;
                console.log(`[EpisodicMemory] Loaded ${this.episodeCache.length} episodes from Vectra for ${this.agentName}`);
            }

            this._indexReady = true;
        } catch (err) {
            console.error('[EpisodicMemory] Failed to initialize Vectra index:', err.message);
            this._indexReady = false;
        }
    }

    /**
     * Store a new episode from a chunk of conversation turns.
     * Called when history.js would have called summarizeMemories().
     *
     * @param {Array} turns - Array of {role, content} message objects
     * @param {object} metadata - Optional context (goal, action, etc.)
     */
    async addEpisode(turns, metadata = {}) {
        const text = this._turnsToText(turns);
        if (!text || text.trim().length === 0) return;

        const compressed = this._compressText(text);
        const id = `ep-${this.nextId++}`;
        const timestamp = Date.now();

        const itemMetadata = {
            text: compressed,
            timestamp,
            type: metadata.type || 'conversation',
            goal: metadata.goal || null
        };

        // Try to embed and store in Vectra
        if (this.embeddingModel) {
            try {
                await this._ensureIndex();
                const vector = await this.embeddingModel.embed(compressed);

                if (this.index && vector) {
                    await this.index.insertItem({
                        id,
                        vector,
                        metadata: itemMetadata
                    });
                }
            } catch (err) {
                console.warn('[EpisodicMemory] Vectra insert failed, using cache only:', err.message);
            }
        }

        // Always add to in-memory cache
        this.episodeCache.push({ id, text: compressed, timestamp, metadata: itemMetadata });
        await this._enforceMaxEpisodes();

        console.log(`[EpisodicMemory] Stored episode ${id} (${this.episodeCache.length} total)`);
        return { id, text: compressed, timestamp, metadata: itemMetadata };
    }

    /**
     * Add a single notable event (death, discovery, achievement, etc.)
     */
    async addEvent(description, metadata = {}) {
        return this.addEpisode(
            [{ role: 'system', content: description }],
            { ...metadata, type: 'event' }
        );
    }

    /**
     * Retrieve the most relevant episodes for the current context.
     *
     * @param {string} query - Current context (goal + recent message)
     * @param {number} k - Number of episodes to retrieve (default: this.topK)
     * @returns {Array} Top-K episodes sorted by relevance
     */
    async retrieve(query, k = null) {
        k = k || this.topK;
        if (this.episodeCache.length === 0) return [];

        // Try Vectra semantic search first
        if (this.embeddingModel && this._indexReady && this.index) {
            try {
                const queryVector = await this.embeddingModel.embed(query);
                const results = await this.index.queryItems(queryVector, k);

                if (results && results.length > 0) {
                    return results.map(r => ({
                        id: r.item.id,
                        text: r.item.metadata.text,
                        timestamp: r.item.metadata.timestamp,
                        metadata: r.item.metadata,
                        score: r.score
                    }));
                }
            } catch (err) {
                console.warn('[EpisodicMemory] Vectra query failed, falling back to word overlap:', err.message);
            }
        }

        // Fallback: word-overlap scoring on cache
        return this._wordOverlapRetrieval(query, k);
    }

    /**
     * Format retrieved episodes into a string for the LLM prompt.
     *
     * @param {string} query - Current context for retrieval
     * @param {number} k - Number of episodes
     * @returns {string} Formatted memory string for prompt injection
     */
    async getFormattedMemories(query, k = null) {
        const episodes = await this.retrieve(query, k);
        if (episodes.length === 0) return '';

        const parts = episodes.map(ep => {
            const age = this._formatAge(ep.timestamp);
            let text = ep.text;
            if (text.length > this.maxTokensPerEpisode) {
                text = text.substring(0, this.maxTokensPerEpisode) + '...';
            }
            return `[${age}] ${text}`;
        });

        return 'Relevant memories:\n' + parts.join('\n');
    }

    /**
     * Re-embed all cached episodes that may lack vectors in Vectra.
     * Called after the embedding model becomes available.
     */
    async reembed() {
        if (!this.embeddingModel) return;
        await this._ensureIndex();
        if (!this.index) return;

        let count = 0;
        for (const ep of this.episodeCache) {
            // Check if item exists in Vectra
            const existing = await this.index.getItem(ep.id);
            if (!existing) {
                try {
                    const vector = await this.embeddingModel.embed(ep.text);
                    if (vector) {
                        await this.index.insertItem({
                            id: ep.id,
                            vector,
                            metadata: ep.metadata || {
                                text: ep.text,
                                timestamp: ep.timestamp,
                                type: 'conversation'
                            }
                        });
                        count++;
                    }
                } catch (err) {
                    // Skip failed embeddings
                }
            }
        }
        if (count > 0) {
            console.log(`[EpisodicMemory] Re-embedded ${count} episodes into Vectra`);
        }
    }

    /**
     * Word-overlap fallback retrieval when embeddings aren't available.
     */
    _wordOverlapRetrieval(query, k) {
        const queryWords = this._getWords(query);
        const scored = this.episodeCache.map(ep => {
            const epWords = this._getWords(ep.text);
            const intersection = queryWords.filter(w => epWords.includes(w));
            const union = queryWords.length + epWords.length - intersection.length;
            return {
                ...ep,
                score: union === 0 ? 0 : intersection.length / union
            };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k);
    }

    /**
     * Convert turns array to a compact text representation.
     */
    _turnsToText(turns) {
        return turns.map(t => {
            const prefix = t.role === 'assistant' ? 'Bot' :
                           t.role === 'system' ? 'System' : 'User';
            return `${prefix}: ${t.content}`;
        }).join('\n');
    }

    /**
     * Compress text for storage — remove redundancy, trim whitespace.
     */
    _compressText(text) {
        return text
            .replace(/\n{3,}/g, '\n\n')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .substring(0, 1000);
    }

    _getWords(text) {
        return text.replace(/[^a-zA-Z ]/g, '').toLowerCase().split(' ').filter(w => w.length > 0);
    }

    /**
     * Format how long ago an episode was stored.
     */
    _formatAge(timestamp) {
        const mins = Math.floor((Date.now() - timestamp) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    /**
     * Evict oldest, lowest-value episodes when over capacity.
     * Removes from both cache and Vectra index.
     */
    async _enforceMaxEpisodes() {
        if (this.episodeCache.length <= this.maxEpisodes) return;

        const now = Date.now();
        const scored = this.episodeCache.map((ep, idx) => {
            const ageHours = (now - ep.timestamp) / (1000 * 60 * 60);
            const recency = 1 / (1 + ageHours / 24);
            const isEvent = ep.metadata?.type === 'event' ? 0.3 : 0;
            return { idx, id: ep.id, score: recency + isEvent };
        });

        scored.sort((a, b) => a.score - b.score);
        const toRemove = scored.slice(0, this.episodeCache.length - this.maxEpisodes);

        // Remove from Vectra
        if (this.index && this._indexReady) {
            for (const { id } of toRemove) {
                try {
                    await this.index.deleteItem(id);
                } catch (err) {
                    // Item may not exist in index
                }
            }
        }

        // Remove from cache
        const removeIds = new Set(toRemove.map(r => r.id));
        this.episodeCache = this.episodeCache.filter(ep => !removeIds.has(ep.id));
    }

    async clear() {
        this.episodeCache = [];
        this.nextId = 0;
        if (this.index && this._indexReady) {
            try {
                await this.index.deleteIndex();
                await this.index.createIndex();
            } catch (err) {
                console.warn('[EpisodicMemory] Failed to clear Vectra index:', err.message);
            }
        }
    }

    getStats() {
        return {
            totalEpisodes: this.episodeCache.length,
            events: this.episodeCache.filter(e => e.metadata?.type === 'event').length,
            vectraReady: this._indexReady,
            hasEmbeddingModel: !!this.embeddingModel,
            oldestAge: this.episodeCache.length > 0
                ? this._formatAge(this.episodeCache[0].timestamp)
                : 'N/A'
        };
    }
}
