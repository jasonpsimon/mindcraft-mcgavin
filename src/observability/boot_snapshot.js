/**
 * BootSnapshot — one structured record of agent startup state (BT-8).
 *
 * Problem
 * =======
 * `init_agent.js` logs "Connecting to MindServer" and "Starting agent" and
 * errors. Nothing emits which profile is loaded, which chat/fast/embedding
 * models are active, which Node / mineflayer version runs, which target
 * server host+port, or which feature flags are enabled. Bug reports and
 * session logs infer all of this from filesystem state or tribal knowledge.
 *
 * Solution
 * ========
 * At agent init, emit exactly two artifacts:
 *
 *   1. One `[Boot] profile=... chat=... fast=... embed=... node=... ...`
 *      log line (tails with no new infra).
 *   2. `data/boot-snapshot.json` — full resolved settings + all of the
 *      structured fields. Overwritten per boot (not append-only): the
 *      point is "current boot's config", not a timeline.
 *
 * Both are produced by one call: `captureBootSnapshot(agent)`.
 *
 * Philosophy alignment
 * ====================
 * - Principle 1: 100% code, no LLM.
 * - Principle 8 (fail loudly, informatively): startup state is now
 *   visible without tribal knowledge. A bug report can include the
 *   log line or the JSON file and reproduce the exact config.
 *
 * Rule alignment
 * ==============
 * - Rule 1 (flexible): features set is a data table; adding a new flag
 *   means one entry.
 * - Rule 5 (no adverse effects): purely additive; wrapped so snapshot
 *   failure never blocks startup.
 * - Rule 7 (complete the perimeter): invariant — boot snapshot must
 *   not mutate bot or agent state. The function reads only; it has
 *   no reference to `bot` at call time (bot does not yet exist).
 *
 * Wiring
 * ======
 * Called once from `Agent.start()` after `this.prompter` is constructed
 * (so we can read model names) and before `_connectBot` (so the snapshot
 * lands even if connection fails). The call is wrapped in try/catch.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Feature flags to include in the structured `features={...}` tag.
// Each entry is `[short_name, settings_path]`. Adding a flag is one data
// entry — no branching (Rule 1).
const FEATURE_FLAGS = [
    ['state_ticker',     'state_ticker.enabled'],
    ['context_builder',  'use_context_builder'],
    ['delta_state',      'use_delta_state'],
    ['filtered_commands','use_filtered_commands'],
    ['fast_model',       'use_fast_model'],
    ['adaptive_polling', 'adaptive_polling'],
    ['load_memory',      'load_memory'],
    ['speak',            'speak'],
    ['chat_ingame',      'chat_ingame'],
    ['allow_vision',     'allow_vision'],
    ['allow_insecure_coding', 'allow_insecure_coding'],
];

const BOOT_SNAPSHOT_FILE = 'data/boot-snapshot.json';

/**
 * Read a dotted-path value out of a settings object. Returns undefined
 * if any segment is missing. Used by the feature-flag table so flag
 * lookups stay data-driven.
 */
function _readDotted(obj, dotPath) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
    }
    return cur;
}

/** Short human-readable "on"/"off" — unknown becomes "?". */
function _onOff(v) {
    if (v === true) return 'on';
    if (v === false) return 'off';
    return '?';
}

/**
 * Render a model reference for the structured log line. Profiles store
 * models in two shapes:
 *   - bare string: e.g. "lmstudio/gemma-4-e4b"
 *   - object: { api, model, url } (this shape is used when the profile
 *     has embedding config, e.g. for a separate LM Studio embedder)
 * Collapse both to a compact "api/model" (or just the string form) so
 * the log line stays single-line and human-scannable. JSON dump keeps
 * the raw object — no information loss there.
 */
function _modelLabel(m) {
    if (m == null) return null;
    if (typeof m === 'string') return m;
    if (typeof m === 'object') {
        if (m.api && m.model) return `${m.api}/${m.model}`;
        if (m.model) return m.model;
        if (m.api) return m.api;
    }
    return String(m);
}

/**
 * Best-effort lookup of the mineflayer package version from its
 * installed package.json. Returns `'?'` if the lookup fails (e.g.,
 * monorepo layouts where the dependency isn't a top-level module).
 */
function _mineflayerVersion() {
    try {
        return require('mineflayer/package.json').version ?? '?';
    } catch (_) {
        return '?';
    }
}

/** 8-char SHA-256 prefix of the stringified settings — a compact identity tag. */
function _settingsHash(settings) {
    try {
        const h = crypto.createHash('sha256');
        h.update(JSON.stringify(settings));
        return h.digest('hex').slice(0, 8);
    } catch (_) {
        return '?';
    }
}

/**
 * Capture a boot snapshot and emit both sinks. Safe to call before
 * `agent.bot` exists — the function intentionally does not reach into
 * mineflayer state. If anything fails internally, the outer try/catch
 * in `Agent.start()` prevents the failure from propagating.
 *
 * @param {Agent} agent  Must have `agent.name` and `agent.prompter`.
 * @param {object} settings  The full resolved settings object.
 * @returns {object}  The snapshot record (useful for tests / callers).
 */
/**
 * Recursively strip any key matching /seed/i from an object before it gets
 * serialized to disk or to a log line. BT-7f (Structure Oracle) introduces
 * a path where the world seed could transitively appear inside settings —
 * this redaction ensures the seed value never lands in boot-snapshot.json.
 */
function _redactSensitive(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(_redactSensitive);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (/seed/i.test(k)) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = _redactSensitive(v);
        }
    }
    return out;
}

export function captureBootSnapshot(agent, settings) {
    const prompter = agent?.prompter;
    const profile = prompter?.profile ?? {};

    const record = {
        t: new Date().toISOString(),
        agent_name: agent?.name ?? null,
        profile: profile.name ?? null,
        models: {
            chat:  profile.model     ?? null,
            fast:  profile.fast_model ?? null,
            code:  profile.code_model ?? null,
            vision: profile.vision_model ?? null,
            embed: profile.embedding ?? null,
        },
        runtime: {
            node: process.version,
            mineflayer: _mineflayerVersion(),
            platform: process.platform,
            arch: process.arch,
        },
        mc: {
            version: settings?.minecraft_version ?? null,
            host: settings?.host ?? null,
            port: settings?.port ?? null,
            auth: settings?.auth ?? null,
        },
        features: Object.fromEntries(
            FEATURE_FLAGS.map(([name, dotPath]) => [name, _readDotted(settings, dotPath) ?? null])
        ),
        settings_hash: _settingsHash(settings),
        // Full resolved settings are dumped to the JSON file for bug-report
        // reproducibility. Omitted from the log line (too large).
        settings: _redactSensitive(settings),
    };

    // --- Structured log line --------------------------------------------
    try {
        const featuresStr = FEATURE_FLAGS
            .map(([name, dotPath]) => `${name}:${_onOff(_readDotted(settings, dotPath))}`)
            .join(',');
        console.log(
            `[Boot] profile=${record.profile ?? '?'} ` +
            `chat=${_modelLabel(record.models.chat) ?? '?'} ` +
            `fast=${_modelLabel(record.models.fast) ?? '(chat)'} ` +
            `embed=${_modelLabel(record.models.embed) ?? '(inherit)'} ` +
            `node=${record.runtime.node} ` +
            `mineflayer=${record.runtime.mineflayer} ` +
            `mc_version=${record.mc.version ?? '?'} ` +
            `host=${record.mc.host ?? '?'} ` +
            `port=${record.mc.port ?? '?'} ` +
            `settings_hash=${record.settings_hash} ` +
            `features={${featuresStr}}`
        );
    } catch (err) {
        console.warn(`[Boot] log emit error: ${err.message}`);
    }

    // --- JSON file dump (overwritten per boot) --------------------------
    try {
        fs.mkdirSync(path.dirname(BOOT_SNAPSHOT_FILE), { recursive: true });
        fs.writeFileSync(
            BOOT_SNAPSHOT_FILE,
            JSON.stringify(record, null, 2),
            'utf-8'
        );
    } catch (err) {
        console.warn(`[Boot] snapshot file write error (${BOOT_SNAPSHOT_FILE}): ${err.message}`);
    }

    return record;
}
