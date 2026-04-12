/**
 * Episodic Memory — Semantic event storage replacing the lossy 500-char summary.
 *
 * Stores conversation chunks and events as embedded vectors, retrieves by
 * semantic relevance at prompt time. Uses the same embedding model as the
 * example selector (from prompter), so no new dependencies.
 *
 * Architecture:
 *   - Each "episode" is a chunk of conversation turns + metadata
 *   - Episodes are embedded using the model's embed() function
 *   - Retrieval: embed the current context, find top-K most similar episodes
 *   - File-backed persistence to ./bots/{name}/episodic_memory.json
 *
 * Replaces the summarizeMemories() flow in history.js:
 *   OLD: chunk 5 turns → LLM summarize → truncate to 500 chars → single string
 *   NEW: chunk turns → embed → store → retrieve top-K relevant at prompt time
 *
 * Falls back to word-overlap similarity if embedding model is unavailable.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

export class EpisodicMemory {
    constructor(agentName, embeddingModel = null, options = {}) {
        this.agentName = agentName;
        this.embeddingModel = embeddingModel;
        this.memoryDir = `./bots/${agentName}`;
        this.memoryFile = `${this.memoryDir}/episodic_memory.json`;

        // Config
        this.maxEpisodes = options.maxEpisodes || 200;
        this.topK = options.topK || 3; // number of episodes to retrieve
        this.maxTokensPerEpisode = options.maxTokensPerEpisode || 300; // rough char limit per episode in prompt

        // Episodes: array of { id, text, embedding, timestamp, metadata }
        this.episodes = [];
        this.nextId = 0;

        this.load();
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

        let embedding = null;
        try {
            if (this.embeddingModel) {
                embedding = await this.embeddingModel.embed(text);
            }
        } catch (err) {
            console.warn('[EpisodicMemory] Embedding failed, storing without vector:', err.message);
        }

        const episode = {
            id: this.nextId++,
            text: this._compressText(text),
            embedding,
            timestamp: Date.now(),
            metadata
        };

        this.episodes.push(episode);
        this._enforceMaxEpisodes();
        this.save();

        console.log(`[EpisodicMemory] Stored episode ${episode.id} (${this.episodes.length} total)`);
        return episode;
    }

    /**
     * Add a single notable event (death, discovery, achievement, etc.)
     */
    async addEvent(description, metadata = {}) {
        let embedding = null;
        try {
            if (this.embeddingModel) {
                embedding = await this.embeddingModel.embed(description);
            }
        } catch (err) {
            console.warn('[EpisodicMemory] Event embedding failed:', err.message);
        }

        const episode = {
            id: this.nextId++,
            text: description,
            embedding,
            timestamp: Date.now(),
            metadata: { ...metadata, type: 'event' }
        };

        this.episodes.push(episode);
        this._enforceMaxEpisodes();
        this.save();

        return episode;
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
        if (this.episodes.length === 0) return [];

        let scored;

        if (this.embeddingModel && this.episodes.some(e => e.embedding)) {
            // Semantic retrieval via embeddings
            try {
                const queryEmbedding = await this.embeddingModel.embed(query);
                scored = this.episodes
                    .filter(e => e.embedding)
                    .map(e => ({
                        episode: e,
                        score: this._cosineSimilarity(queryEmbedding, e.embedding)
                    }));
            } catch (err) {
                console.warn('[EpisodicMemory] Query embedding failed, using word overlap:', err.message);
                scored = this._wordOverlapScoring(query);
            }
        } else {
            // Fallback: word overlap
            scored = this._wordOverlapScoring(query);
        }

        // Sort by relevance, take top-K
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k).map(s => s.episode);
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

        const parts = episodes.map((ep, i) => {
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
            .replace(/\n{3,}/g, '\n\n')     // collapse multiple newlines
            .replace(/\s{2,}/g, ' ')          // collapse multiple spaces
            .trim()
            .substring(0, 1000);              // hard cap per episode
    }

    /**
     * Cosine similarity between two vectors.
     */
    _cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dotProduct / denom;
    }

    /**
     * Fallback scoring using word overlap (same approach as upstream examples.js).
     */
    _wordOverlapScoring(query) {
        const queryWords = this._getWords(query);
        return this.episodes.map(e => {
            const epWords = this._getWords(e.text);
            const intersection = queryWords.filter(w => epWords.includes(w));
            const union = queryWords.length + epWords.length - intersection.length;
            return {
                episode: e,
                score: union === 0 ? 0 : intersection.length / union
            };
        });
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
     * Evict oldest, lowest-relevance episodes when over capacity.
     * Keeps recent episodes and high-metadata episodes (events, achievements).
     */
    _enforceMaxEpisodes() {
        if (this.episodes.length <= this.maxEpisodes) return;

        const now = Date.now();
        const scored = this.episodes.map((ep, idx) => {
            const ageHours = (now - ep.timestamp) / (1000 * 60 * 60);
            const recency = 1 / (1 + ageHours / 24);
            const isEvent = ep.metadata?.type === 'event' ? 0.3 : 0;
            return { idx, score: recency + isEvent };
        });

        scored.sort((a, b) => a.score - b.score);
        const toRemove = new Set(scored.slice(0, this.episodes.length - this.maxEpisodes).map(s => s.idx));
        this.episodes = this.episodes.filter((_, idx) => !toRemove.has(idx));
    }

    save() {
        try {
            mkdirSync(this.memoryDir, { recursive: true });
            // Save without embeddings to keep file size reasonable
            // Re-embed on load if model is available
            const data = {
                nextId: this.nextId,
                episodes: this.episodes.map(e => ({
                    ...e,
                    embedding: null // don't persist embeddings — re-embed on load if needed
                }))
            };
            writeFileSync(this.memoryFile, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('[EpisodicMemory] Failed to save:', error);
        }
    }

    load() {
        try {
            if (!existsSync(this.memoryFile)) return;
            const data = JSON.parse(readFileSync(this.memoryFile, 'utf8'));
            this.episodes = data.episodes || [];
            this.nextId = data.nextId || this.episodes.length;
            console.log(`[EpisodicMemory] Loaded ${this.episodes.length} episodes for ${this.agentName}`);
        } catch (error) {
            console.error('[EpisodicMemory] Failed to load:', error);
            this.episodes = [];
        }
    }

    /**
     * Re-embed all episodes that lack embeddings (e.g., after loading from disk).
     * Call this after the embedding model is ready.
     */
    async reembed() {
        if (!this.embeddingModel) return;

        let count = 0;
        for (const ep of this.episodes) {
            if (!ep.embedding) {
                try {
                    ep.embedding = await this.embeddingModel.embed(ep.text);
                    count++;
                } catch (err) {
                    // Skip failed embeddings
                }
            }
        }
        if (count > 0) {
            console.log(`[EpisodicMemory] Re-embedded ${count} episodes`);
            this.save();
        }
    }

    clear() {
        this.episodes = [];
        this.nextId = 0;
        this.save();
    }

    getStats() {
        return {
            totalEpisodes: this.episodes.length,
            withEmbeddings: this.episodes.filter(e => e.embedding).length,
            events: this.episodes.filter(e => e.metadata?.type === 'event').length,
            oldestAge: this.episodes.length > 0
                ? this._formatAge(this.episodes[0].timestamp)
                : 'N/A'
        };
    }
}
