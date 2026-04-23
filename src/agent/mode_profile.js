// src/agent/mode_profile.js
//
// BT-30a: Mode profile state machine (skeleton).
//
// Sits ABOVE the per-flag ModeController in modes.js. Tracks two fields:
//   configured — one of: survivor / assistant-server / assistant-user / auto.
//                Authoritative source on cold boot is the bot profile JSON's
//                top-level `mode_profile` field. Operator can override at
//                runtime via the `!botMode` command, which persists by
//                writing the new value back to that same JSON file so the
//                next cold boot sees it.
//   runtime    — current actual behavior. For survivor / assistant-server /
//                assistant-user, runtime == configured (collapsed onto
//                'survivor' or 'assistant'). For auto, runtime alternates
//                between 'survivor' and 'assistant' based on player presence
//                + the (not-yet-shipped) 5-min idle timer. Sticky-return
//                lives only inside auto.
//
// THIS COMMIT (BT-30a): pure wiring. Class + getJson/loadJson +
// onPlayerOnlineChange stub (logs only, no behavior change) + transition
// log. No sticky-return, no 5-min timer, no Survivor goal queue. Those
// land in BT-30b / BT-30c / BT-30d.
//
// Observability: every state transition emits a single structured
// `[ModeProfile]` log line (init, setConfigured, runtime change). Mirrors
// the BT-1..BT-12 structured-log convention.

import { readFileSync, writeFileSync } from 'fs';

export const VALID_PROFILES = Object.freeze([
    'survivor',
    'assistant-server',
    'assistant-user',
    'auto',
]);

export const DEFAULT_PROFILE = 'auto';

/**
 * Collapse a configured profile name to the runtime behavior it implies on
 * cold boot. assistant-server and assistant-user both resolve to 'assistant'
 * at runtime; survivor resolves to itself; auto resolves to 'survivor' (its
 * idle baseline) until a player joins (handled in BT-30b).
 */
function initialRuntimeFor(configured) {
    switch (configured) {
        case 'survivor':         return 'survivor';
        case 'assistant-server':
        case 'assistant-user':   return 'assistant';
        case 'auto':             return 'survivor';
        default:                 return 'survivor';
    }
}

export class ModeProfile {
    /**
     * @param {object} agent - the Agent instance (used for chat, profile_fp).
     * @param {string} configured - validated profile string from profile JSON.
     */
    constructor(agent, configured) {
        this.agent = agent;
        this.configured = VALID_PROFILES.includes(configured) ? configured : DEFAULT_PROFILE;
        this.runtime = initialRuntimeFor(this.configured);

        // Path the !botMode writeback targets. Set by Agent during init from
        // settings.profile_fp. May be null if we couldn't determine the path,
        // in which case writeback is skipped (with a warn) but the in-memory
        // configured value still updates.
        this.profile_fp = agent?._profile_fp || null;

        console.log(`[ModeProfile] init configured=${this.configured} runtime=${this.runtime} profile_fp=${this.profile_fp || '(none)'}`);
    }

    /**
     * Operator command path. Validates, updates in-memory configured, syncs
     * runtime to match (collapse rule), persists to profile JSON, logs.
     * Returns a result object: { ok: true, msg } or { ok: false, msg }.
     */
    setConfigured(next) {
        if (!VALID_PROFILES.includes(next)) {
            return {
                ok: false,
                msg: `unknown profile ${next} — valid: ${VALID_PROFILES.join(', ')}`,
            };
        }
        const prev_configured = this.configured;
        const prev_runtime = this.runtime;
        this.configured = next;
        this.runtime = initialRuntimeFor(next);

        let writeback = 'skipped';
        if (this.profile_fp) {
            try {
                const raw = readFileSync(this.profile_fp, 'utf8');
                const obj = JSON.parse(raw);
                obj.mode_profile = next;
                writeFileSync(this.profile_fp, JSON.stringify(obj, null, 4));
                writeback = 'ok';
            } catch (e) {
                writeback = `failed:${e.message}`;
                console.warn(`[ModeProfile] writeback to ${this.profile_fp} failed:`, e.message);
            }
        }

        console.log(`[ModeProfile] setConfigured ${prev_configured}->${next} runtime ${prev_runtime}->${this.runtime} writeback=${writeback}`);
        return { ok: true, msg: `mode profile set to ${next} (runtime ${this.runtime})` };
    }

    /**
     * Stub for BT-30b. Called from agent.js playerJoined / playerLeft
     * listeners. Today: log only. BT-30b will branch on configured to
     * implement the assistant-server / assistant-user / auto rules.
     */
    onPlayerOnlineChange(event, username) {
        console.log(`[ModeProfile] player ${event} username=${username} configured=${this.configured} runtime=${this.runtime} (no-op until BT-30b)`);
    }

    // Mirrors ModeController.getJson / loadJson so history.save() can
    // round-trip ModeProfile state alongside the per-flag modes block.
    getJson() {
        return { configured: this.configured, runtime: this.runtime };
    }

    loadJson(json) {
        if (!json || typeof json !== 'object') return;
        if (VALID_PROFILES.includes(json.configured)) {
            this.configured = json.configured;
        }
        if (json.runtime === 'survivor' || json.runtime === 'assistant') {
            this.runtime = json.runtime;
        }
        console.log(`[ModeProfile] loadJson configured=${this.configured} runtime=${this.runtime}`);
    }
}

/**
 * Resolve the configured profile string from a parsed bot-profile JSON.
 * Returns { value, defaulted: bool, invalid: bool } so the caller can warn
 * appropriately.
 */
export function resolveConfiguredFromProfileJson(profile) {
    const raw = profile?.mode_profile;
    if (raw === undefined || raw === null) {
        return { value: DEFAULT_PROFILE, defaulted: true, invalid: false };
    }
    if (!VALID_PROFILES.includes(raw)) {
        return { value: DEFAULT_PROFILE, defaulted: false, invalid: true, raw };
    }
    return { value: raw, defaulted: false, invalid: false };
}
