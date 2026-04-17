/**
 * RecallLog — memory-retrieval telemetry (BT-4).
 *
 * Problem
 * =======
 * All three memory subsystems (EpisodicMemory, LongTermMemory,
 * ProceduralMemory via ConfidenceEngine) log writes but are silent on
 * reads. A reader of the tmux buffer has no way to tell whether memory
 * contributed to the current response — no query, no top-K, no score,
 * no backend (Vectra vs word-overlap fallback). Principle 2 ("memory is
 * cognition") is currently unverifiable.
 *
 * Solution
 * ========
 * One `[MemoryRecall]` structured log line per retrieval exit, plus an
 * append to `data/recall-stream.jsonl`. Same pattern as BT-1 StateTicker
 * + BT-2 DamageStream — console sink + file sink, both error-throttled.
 *
 * Design choice: module-level function, not a class
 * -------------------------------------------------
 * RecallLog carries no per-agent state — it's pure log+append. Matches
 * the shape of `captureBootSnapshot` rather than DamageStream. Each
 * memory subsystem just imports and calls `logRecall({...})`. No
 * constructor injection, no lifecycle, no agent reference.
 *
 * Procedural collapse
 * ===================
 * `ProceduralMemory.lookup()` has a single caller — `confidence_engine.js:68`.
 * Instrumenting `evaluate()` captures 100% of procedural reads with the
 * richer decision context (tier, thresholds, record_count). A separate
 * procedural log line would duplicate once per LLM turn. Principle 5
 * (finish migrations, kill redundancy) + Rule 9 (simplicity first).
 *
 * Record shape
 * ============
 *   {
 *     t, subsystem,
 *     query?, k?, returned?, backend?, top_score?, top_text?,
 *     ...extras  // subsystem-specific: category_top (LTM),
 *                //                     goal/trigger/tier/thresholds/
 *                //                     context_hash/record_count (confidence)
 *   }
 *
 * Console format (one line per record, space-delimited key=value):
 *   [MemoryRecall] subsystem=episodic query="..." k=3 returned=2 backend=vectra top_score=0.82 top_text="..."
 *   [MemoryRecall] subsystem=long_term query="..." k=5 returned=4 backend=word-overlap top_score=0.41 top_text="..." category_top=place
 *   [MemoryRecall] subsystem=confidence goal="..." trigger="..." tier=LOW confidence=0.00 threshold_high=0.98 threshold_med=0.50 context_hash=abc123 record_count=147
 *
 * Philosophy alignment
 * ====================
 * - Principle 2: makes the cognition layer observable.
 * - Principle 8: every retrieval now emits a structured, greppable line.
 * - Rule 9: stateless module, no class, no injection.
 *
 * Rule 7 (perimeter) — no bot mutation
 * ====================================
 *   grep -E 'bot\.(dig|placeBlock|chat|toss|setControlState|attack|
 *   equip|unequip|activateItem)|pathfinder\.goto' on this file returns
 *   zero matches. Pure log + fs.appendFile.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILE_PATH = 'data/recall-stream.jsonl';
const QUERY_TRUNC = 80;
const TEXT_TRUNC = 80;
const ERROR_LOG_THROTTLE_MS = 10_000;

// Module-private mutable state. Set once on first call; settable via
// `configureRecallLog()` for tests or runtime overrides.
let _enabled = true;
let _logToConsole = true;
let _logToFile = true;
let _filePath = DEFAULT_FILE_PATH;
let _dirEnsured = false;
let _lastWriteErrorAt = 0;
let _lastEmitErrorAt = 0;

/**
 * Optional runtime configuration. Agent wires this from
 * `settings.recall_log` at init.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]          master switch (default true)
 * @param {boolean} [opts.log_to_console]   default true
 * @param {boolean} [opts.log_to_file]      default true
 * @param {string}  [opts.file_path]        default 'data/recall-stream.jsonl'
 */
export function configureRecallLog(opts = {}) {
    if (typeof opts.enabled === 'boolean') _enabled = opts.enabled;
    if (typeof opts.log_to_console === 'boolean') _logToConsole = opts.log_to_console;
    if (typeof opts.log_to_file === 'boolean') _logToFile = opts.log_to_file;
    if (typeof opts.file_path === 'string' && opts.file_path) _filePath = opts.file_path;
    _dirEnsured = false; // force re-check if path changed
}

/**
 * Emit one retrieval record. Non-throwing: any internal failure is
 * caught and throttled so a broken log can never propagate to the
 * caller's hot path.
 *
 * @param {object} record
 * @param {string} record.subsystem   'episodic' | 'long_term' | 'confidence'
 * @param {string} [record.query]
 * @param {number} [record.k]
 * @param {number} [record.returned]
 * @param {string} [record.backend]   'vectra' | 'word-overlap' | 'none' (confidence)
 * @param {number} [record.top_score]
 * @param {string} [record.top_text]
 * @param {object} [record.extras]    subsystem-specific extra fields
 */
export function logRecall(record) {
    if (!_enabled) return;
    try {
        const normalized = _normalize(record);
        if (_logToConsole) _emitConsole(normalized);
        if (_logToFile) _emitFile(normalized);
    } catch (err) {
        const now = Date.now();
        if (now - _lastEmitErrorAt > ERROR_LOG_THROTTLE_MS) {
            _lastEmitErrorAt = now;
            console.warn(`[MemoryRecall] emit error: ${err?.message ?? err}`);
        }
    }
}

/**
 * Normalize + truncate the record for safe emission. Split out so the
 * console and file sinks see the same payload.
 */
function _normalize(record) {
    const r = { t: new Date().toISOString() };
    if (record?.subsystem) r.subsystem = String(record.subsystem);

    if (typeof record?.query === 'string') {
        r.query = _truncate(record.query, QUERY_TRUNC);
    }
    if (typeof record?.k === 'number' && Number.isFinite(record.k)) r.k = record.k;
    if (typeof record?.returned === 'number' && Number.isFinite(record.returned)) r.returned = record.returned;
    if (typeof record?.backend === 'string') r.backend = record.backend;
    if (typeof record?.top_score === 'number' && Number.isFinite(record.top_score)) {
        r.top_score = Number(record.top_score.toFixed(3));
    }
    if (typeof record?.top_text === 'string') {
        r.top_text = _truncate(record.top_text, TEXT_TRUNC);
    }

    // Subsystem-specific extras flow through verbatim (after trunc for
    // any string fields). Keep the caller's ordering by merging last.
    if (record?.extras && typeof record.extras === 'object') {
        for (const [k, v] of Object.entries(record.extras)) {
            if (typeof v === 'string') {
                r[k] = _truncate(v, TEXT_TRUNC);
            } else if (typeof v === 'number' && Number.isFinite(v)) {
                // Trim long floats; leave integers alone.
                r[k] = Number.isInteger(v) ? v : Number(v.toFixed(3));
            } else if (v === null || typeof v === 'boolean') {
                r[k] = v;
            }
            // Skip undefined / functions / objects — keep the log flat.
        }
    }

    return r;
}

function _truncate(s, max) {
    if (typeof s !== 'string') return s;
    // Collapse whitespace so multi-line queries render single-line.
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function _emitConsole(r) {
    // Field order: subsystem, query, k, returned, backend, top_score,
    // top_text, then any extras in the order they arrived.
    const ORDERED = ['subsystem', 'query', 'k', 'returned', 'backend', 'top_score', 'top_text'];
    const parts = [];
    for (const key of ORDERED) {
        if (key in r) parts.push(_fmt(key, r[key]));
    }
    for (const [key, val] of Object.entries(r)) {
        if (key === 't' || ORDERED.includes(key)) continue;
        parts.push(_fmt(key, val));
    }
    console.log(`[MemoryRecall] ${parts.join(' ')}`);
}

function _fmt(key, val) {
    if (typeof val === 'string') {
        // Quote strings so spaces inside don't confuse the eye.
        return `${key}="${val}"`;
    }
    return `${key}=${val}`;
}

function _emitFile(r) {
    if (!_dirEnsured) {
        try {
            fs.mkdirSync(path.dirname(_filePath), { recursive: true });
            _dirEnsured = true;
        } catch (err) {
            const now = Date.now();
            if (now - _lastWriteErrorAt > ERROR_LOG_THROTTLE_MS) {
                _lastWriteErrorAt = now;
                console.warn(`[MemoryRecall] could not create data dir for ${_filePath}: ${err.message} — disabling file sink`);
            }
            _logToFile = false;
            return;
        }
    }
    fs.appendFile(_filePath, JSON.stringify(r) + '\n', (err) => {
        if (!err) return;
        const now = Date.now();
        if (now - _lastWriteErrorAt > ERROR_LOG_THROTTLE_MS) {
            _lastWriteErrorAt = now;
            console.warn(`[MemoryRecall] file write error (${_filePath}): ${err.message}`);
        }
    });
}
