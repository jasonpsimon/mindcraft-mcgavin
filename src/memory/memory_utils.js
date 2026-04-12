/**
 * Memory Utilities — Shared helpers for episodic and long-term memory.
 *
 * Pure utility functions with no state. Both EpisodicMemory and LongTermMemory
 * import from here instead of duplicating implementations.
 */

import { LocalIndex } from 'vectra';
import { mkdirSync } from 'fs';

/**
 * Extract words from text for word-overlap scoring.
 * Strips non-alpha characters, lowercases, and splits on spaces.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function getWords(text) {
    return text.replace(/[^a-zA-Z ]/g, '').toLowerCase().split(' ').filter(w => w.length > 0);
}

/**
 * Format how long ago a timestamp was, in human-readable form.
 *
 * @param {number} timestamp - Unix timestamp in ms
 * @returns {string} e.g. "just now", "5m ago", "2h ago", "3d ago"
 */
export function formatAge(timestamp) {
    if (!timestamp) return '?';
    const mins = Math.floor((Date.now() - timestamp) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Compute Jaccard similarity between a query and a candidate text.
 * Used as a fallback when embedding model isn't available.
 *
 * @param {string} query
 * @param {string} candidate
 * @returns {number} Score between 0 and 1
 */
export function wordOverlapScore(query, candidate) {
    const queryWords = getWords(query);
    const candidateWords = getWords(candidate);
    const intersection = queryWords.filter(w => candidateWords.includes(w));
    const union = queryWords.length + candidateWords.length - intersection.length;
    return union === 0 ? 0 : intersection.length / union;
}

/**
 * Initialize a Vectra LocalIndex at the given path.
 * Creates the directory and index if they don't exist.
 *
 * @param {string} indexPath - Directory for the Vectra index
 * @param {string} label - Label for log messages (e.g. "EpisodicMemory")
 * @returns {Promise<{index: LocalIndex, items: Array}>} The index and any existing items
 * @throws {Error} If initialization fails
 */
export async function initVectraIndex(indexPath, label = 'Memory') {
    mkdirSync(indexPath, { recursive: true });
    const index = new LocalIndex(indexPath);

    let items = [];
    if (!await index.isIndexCreated()) {
        await index.createIndex();
        console.log(`[${label}] Created Vectra index at ${indexPath}`);
    } else {
        items = await index.listItems();
        console.log(`[${label}] Loaded ${items.length} items from Vectra`);
    }

    return { index, items };
}
