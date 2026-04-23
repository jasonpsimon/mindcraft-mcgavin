// src/agent/mode_profile.js
//
// BT-30a: Mode profile state machine (skeleton).
// BT-30b: Real onPlayerOnlineChange + assistant_user field + dual-writeback.
// BT-30c: auto idle-timeout drop-back (30-minute sliding window).
//
// Sits ABOVE the per-flag ModeController in modes.js. Tracks three fields:
//   configured     — one of: survivor / assistant-server / assistant-user / auto.
//                    Authoritative source on cold boot is the bot profile JSON's
//                    top-level `mode_profile` field. Operator can override at
//                    runtime via `!botMode <profile> [username]`, which persists
//                    by writing back to the same JSON file.
//   assistant_user — only meaningful when configured === 'assistant-user'.
//                    Names the single player whose presence pauses self_prompter.
//                    Authoritative source on cold boot is the bot profile JSON's
//                    `assistant_user` field. Settable atomically with `mode_profile`
//                    via `!botMode assistant-user <username>`.
//   runtime        — current actual behavior. For survivor / assistant-server /
//                    assistant-user, runtime == configured (collapsed onto
//                    'survivor' or 'assistant'). For auto, runtime alternates
//                    between 'survivor' and 'assistant' based on player presence
//                    (sticky-return on join) + the BT-30c 5-min idle timer
//                    (drop-back on inactivity — not yet shipped).
//
// THIS COMMIT (BT-30c): auto idle-timeout drop-back.
//   - 30-minute sliding window of "activity" (chat addressed to bot only —
//     mention or DM. Ambient in-range chatter does NOT count).
//   - Idle timer is armed only when configured === 'auto' && runtime ===
//     'assistant'. Disarmed in every other configuration.
//   - Check loop runs at 60s cadence (IDLE_CHECK_MS). When it sees
//     now - lastActivityAt >= IDLE_MS, it fires _dropToSurvivor: flips
//     runtime → 'survivor' and resumes self_prompter (mirror of
//     _resumeFromAssistant). Drop fires regardless of player presence —
//     that's the whole point of auto.
//   - Sticky-return from BT-30b is the inverse path: any qualifying chat
//     activity from any player flips runtime back to 'assistant' and
//     re-pauses self_prompter (handled here in noteActivity, not the
//     onPlayerOnlineChange path which only fires on join/leave).
//   - reconcileOnSpawn arms the timer when boot lands in auto+assistant.
//
// EARLIER (BT-30b): real Assistant variant handlers + sticky-return for auto.
//   - assistant-server pauses self_prompter on FIRST player join
//     (other-count goes 0→1) and resumes on LAST player leave (1→0).
//   - assistant-user pauses on the named player's join, resumes on their leave.
//     Other players' join/leave events are ignored.
//   - auto sticky-return: on ANY player join while runtime === 'survivor',
//     flip runtime → 'assistant' and pause self_prompter immediately. Leave
//     events in auto are NO-OP for runtime — BT-30c's 5-min idle timer owns
//     the assistant→survivor drop-back.
//
// Why no new stoppedReason: pause() puts the self_prompter into PAUSED, not
// STOPPED. The circuit-breaker watchdog at self_prompter.js:314 only fires
// when state === STOPPED && stoppedReason === 'circuitBreaker'. Pausing for
// assistant-mode bypasses the watchdog by construction, so the WB note about
// adding a new 'assistant_player_online' reason turned out unnecessary on
// closer reading of the self_prompter code. Kept simpler taxonomy.
//
// reconcileOnSpawn(): called from agent.js spawn handler after the bot has
// fully connected. Handles the boot-time case where assistant variants come
// up with players already online (mineflayer's playerJoined event does NOT
// fire for pre-existing players on bot spawn). Without this, an assistant-
// server bot that boots into a populated server would never pause until
// someone NEW joins.
//
// Observability: every state transition emits a single structured
// `[ModeProfile]` log line (init, setConfigured, runtime change, pause/
// resume of self_prompter, reconcile). Mirrors the BT-1..BT-12 convention.

import { readFileSync, writeFileSync } from 'fs';

export const VALID_PROFILES = Object.freeze([
    'survivor',
    'assistant-server',
    'assistant-user',
    'auto',
]);

export const DEFAULT_PROFILE = 'auto';

// BT-30c: auto idle-timeout window (30 minutes) and check cadence (60s).
// IDLE_MS is the sliding window — runtime drops to survivor when no
// qualifying activity has been recorded for at least this long while
// configured === 'auto' && runtime === 'assistant'.
export const IDLE_MS = 30 * 60 * 1000;
export const IDLE_CHECK_MS = 60 * 1000;

/**
 * Collapse a configured profile name to the runtime behavior it implies on
 * cold boot. assistant-server and assistant-user both resolve to 'assistant'
 * at runtime; survivor resolves to itself; auto resolves to 'survivor' (its
 * idle baseline) until a player joins (sticky-return flips it to assistant).
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
     * @param {object} agent - the Agent instance (used for chat, profile_fp, bot.players).
     * @param {string} configured - validated profile string from profile JSON.
     * @param {string|null} assistant_user - target username for assistant-user variant
     *                                       (null/undefined for the other three profiles).
     */
    constructor(agent, configured, assistant_user = null) {
        this.agent = agent;
        this.configured = VALID_PROFILES.includes(configured) ? configured : DEFAULT_PROFILE;
        this.assistant_user = (typeof assistant_user === 'string' && assistant_user.length > 0)
            ? assistant_user : null;
        this.runtime = initialRuntimeFor(this.configured);

        // Path the !botMode writeback targets. Set by Agent during init from
        // settings.profile_fp. May be null if we couldn't determine the path,
        // in which case writeback is skipped (with a warn) but the in-memory
        // configured value still updates.
        this.profile_fp = agent?._profile_fp || null;

        // BT-30c: auto idle-timeout state. lastActivityAt is the sliding
        // window anchor — any qualifying chat-to-bot resets it. idleTimer
        // holds the setInterval handle while armed. Both meaningful only
        // when configured === 'auto' && runtime === 'assistant'.
        this.lastActivityAt = Date.now();
        this.idleTimer = null;

        console.log(`[ModeProfile] init configured=${this.configured} runtime=${this.runtime} assistant_user=${this.assistant_user || '(none)'} profile_fp=${this.profile_fp || '(none)'}`);
    }

    /**
     * Operator command path. Validates, updates in-memory state, persists
     * both `mode_profile` and (when relevant) `assistant_user` to profile
     * JSON in a single atomic write, logs.
     *
     * Username arg semantics:
     *   - profile === 'assistant-user': username REQUIRED. Falls back to the
     *     existing this.assistant_user if a prior call set it; errors if both
     *     the arg and the existing field are empty.
     *   - other profiles: username arg is ignored (we don't clear the existing
     *     assistant_user — it stays in the profile JSON for next time the user
     *     flips back to assistant-user).
     *
     * Returns: { ok: true, msg } on success, { ok: false, msg } on validation error.
     */
    setConfigured(next, username = null) {
        if (!VALID_PROFILES.includes(next)) {
            return {
                ok: false,
                msg: `unknown profile ${next} — valid: ${VALID_PROFILES.join(', ')}`,
            };
        }

        // assistant-user requires a username (either passed in now or already
        // configured from profile JSON). Without one, nothing to gate on.
        let next_assistant_user = this.assistant_user;
        if (next === 'assistant-user') {
            const trimmed = (typeof username === 'string') ? username.trim() : '';
            if (trimmed.length > 0) {
                next_assistant_user = trimmed;
            }
            if (!next_assistant_user) {
                return {
                    ok: false,
                    msg: `assistant-user requires a username — usage: !botMode assistant-user <username>`,
                };
            }
        }

        const prev_configured = this.configured;
        const prev_runtime = this.runtime;
        const prev_assistant_user = this.assistant_user;

        this.configured = next;
        this.assistant_user = next_assistant_user;
        this.runtime = initialRuntimeFor(next);

        // BT-30c: any operator-driven profile change disarms the idle timer.
        // initialRuntimeFor('auto') is 'survivor', so even when entering auto
        // we don't arm here — sticky-return on the next player join (or
        // reconcileOnSpawn) will arm it.
        this._stopIdleTimer();

        let writeback = 'skipped';
        if (this.profile_fp) {
            try {
                const raw = readFileSync(this.profile_fp, 'utf8');
                const obj = JSON.parse(raw);
                obj.mode_profile = next;
                // Only write assistant_user if it changed or we have a value.
                // Keeps the profile JSON tidy for the survivor/auto cases where
                // the field was never set in the first place.
                if (next_assistant_user) {
                    obj.assistant_user = next_assistant_user;
                }
                writeFileSync(this.profile_fp, JSON.stringify(obj, null, 4));
                writeback = 'ok';
            } catch (e) {
                writeback = `failed:${e.message}`;
                console.warn(`[ModeProfile] writeback to ${this.profile_fp} failed:`, e.message);
            }
        }

        console.log(`[ModeProfile] setConfigured ${prev_configured}->${next} runtime ${prev_runtime}->${this.runtime} assistant_user ${prev_assistant_user || '(none)'}->${this.assistant_user || '(none)'} writeback=${writeback}`);

        const userPart = (next === 'assistant-user') ? ` user=${this.assistant_user}` : '';
        return { ok: true, msg: `mode profile set to ${next}${userPart} (runtime ${this.runtime})` };
    }

    /**
     * Player join/leave event handler. Wired from agent.js bot.on('playerJoined'/'playerLeft')
     * listeners. The agent.js layer already filters out the bot's own join/leave
     * events, so `username` is always another player.
     *
     * Branches on `configured`. Survivor never reacts. Assistant variants
     * pause/resume self_prompter on their respective trigger. Auto sticky-
     * returns on join (survivor → assistant + pause); leave is no-op (deferred
     * to BT-30c's idle timer).
     */
    onPlayerOnlineChange(event, username) {
        const otherCount = this._countOtherPlayers();
        console.log(`[ModeProfile] player ${event} username=${username} configured=${this.configured} runtime=${this.runtime} others_online=${otherCount}`);

        switch (this.configured) {
            case 'survivor':
                // Survivor never gates on player presence.
                return;

            case 'assistant-server':
                // Pause on first player join (count went 0→1), resume on last leave (1→0).
                // bot.players is post-event by mineflayer convention, so otherCount
                // already reflects the join/leave that just fired.
                if (event === 'joined' && otherCount === 1) {
                    this._pauseForAssistant(`assistant-server first-player-join (${username})`);
                } else if (event === 'left' && otherCount === 0) {
                    this._resumeFromAssistant(`assistant-server last-player-leave (${username})`);
                }
                return;

            case 'assistant-user':
                // Only the named user's events drive state changes.
                if (!this.assistant_user || username !== this.assistant_user) {
                    return;
                }
                if (event === 'joined') {
                    this._pauseForAssistant(`assistant-user join (${username})`);
                } else if (event === 'left') {
                    this._resumeFromAssistant(`assistant-user leave (${username})`);
                }
                return;

            case 'auto':
                // Sticky-return: any player join flips runtime → assistant.
                // Leave is intentionally NO-OP — BT-30c's 30-min idle timer
                // owns the assistant → survivor drop-back when the player
                // stays connected but stops addressing the bot.
                if (event === 'joined' && this.runtime === 'survivor') {
                    const prev = this.runtime;
                    this.runtime = 'assistant';
                    console.log(`[ModeProfile] runtime ${prev}->${this.runtime} reason=auto_sticky_return user=${username}`);
                    this._pauseForAssistant(`auto sticky-return (${username} joined)`);
                    // BT-30c: arm idle timer. Reset window so the user has a
                    // full 30 minutes from the moment they joined before drop.
                    this.lastActivityAt = Date.now();
                    this._startIdleTimer();
                }
                return;

            default:
                return;
        }
    }

    /**
     * Boot-time reconciliation. Called from agent.js spawn handler after
     * self_prompter has had a chance to load any saved goal. Handles the
     * gap left by mineflayer's playerJoined event NOT firing for players
     * who were already online when the bot connected.
     *
     * Idempotent: safe to call multiple times. The pause/resume helpers
     * short-circuit when self_prompter is already in the desired state.
     */
    reconcileOnSpawn() {
        const otherCount = this._countOtherPlayers();
        console.log(`[ModeProfile] reconcileOnSpawn configured=${this.configured} runtime=${this.runtime} others_online=${otherCount}`);

        switch (this.configured) {
            case 'survivor':
                return;

            case 'assistant-server':
                if (otherCount > 0) {
                    this._pauseForAssistant(`assistant-server boot-reconcile (${otherCount} player(s) already online)`);
                }
                return;

            case 'assistant-user':
                if (this.assistant_user && this._isAssistantUserPresent()) {
                    this._pauseForAssistant(`assistant-user boot-reconcile (${this.assistant_user} already online)`);
                }
                return;

            case 'auto':
                if (otherCount > 0 && this.runtime === 'survivor') {
                    const prev = this.runtime;
                    this.runtime = 'assistant';
                    console.log(`[ModeProfile] runtime ${prev}->${this.runtime} reason=auto_boot_reconcile players_online=${otherCount}`);
                    this._pauseForAssistant(`auto boot-reconcile (${otherCount} player(s) already online)`);
                    // BT-30c: arm idle timer; reset window. If the players who
                    // were already on don't address the bot in 30 minutes, we
                    // drop back to survivor.
                    this.lastActivityAt = Date.now();
                    this._startIdleTimer();
                }
                return;

            default:
                return;
        }
    }

    // --- Internal helpers ------------------------------------------------

    _countOtherPlayers() {
        const players = this.agent?.bot?.players || {};
        const selfName = this.agent?.name;
        let count = 0;
        for (const name in players) {
            if (name !== selfName) count++;
        }
        return count;
    }

    _isAssistantUserPresent() {
        const players = this.agent?.bot?.players || {};
        return !!(this.assistant_user && players[this.assistant_user]);
    }

    /**
     * Pause self_prompter for assistant-mode handoff. Idempotent: skips if
     * already paused or stopped (avoids needless [Goal] event=pause noise).
     */
    async _pauseForAssistant(reason) {
        const sp = this.agent?.self_prompter;
        if (!sp) {
            console.warn(`[ModeProfile] pause requested but no self_prompter reason=${reason}`);
            return;
        }
        if (sp.isPaused() || sp.isStopped()) {
            console.log(`[ModeProfile] pause skipped — self_prompter already non-active reason=${reason}`);
            return;
        }
        console.log(`[ModeProfile] pausing self_prompter reason=${reason}`);
        try {
            await sp.pause();
        } catch (e) {
            console.warn(`[ModeProfile] pause threw: ${e.message}`);
        }
    }

    /**
     * Resume self_prompter from an assistant-mode pause. Idempotent: skips
     * if not currently paused, or if no prompt exists to resume (e.g., bot
     * was never given a goal).
     */
    _resumeFromAssistant(reason) {
        const sp = this.agent?.self_prompter;
        if (!sp) {
            console.warn(`[ModeProfile] resume requested but no self_prompter reason=${reason}`);
            return;
        }
        if (!sp.isPaused()) {
            console.log(`[ModeProfile] resume skipped — self_prompter not paused (state=${sp.state}) reason=${reason}`);
            return;
        }
        if (!sp.prompt) {
            console.log(`[ModeProfile] resume skipped — no prompt to resume reason=${reason}`);
            return;
        }
        console.log(`[ModeProfile] resuming self_prompter reason=${reason}`);
        try {
            sp.start();
        } catch (e) {
            console.warn(`[ModeProfile] resume threw: ${e.message}`);
        }
    }

    // --- BT-30c: auto idle-timeout drop-back -----------------------------

    /**
     * Record a qualifying activity event from the agent. Called from
     * agent.js's whisper handler (always) and chat handler (when the
     * message contains the bot's name — i.e., a mention). In-range chatter
     * between other players does NOT call this.
     *
     * Two effects:
     *   1. Resets the sliding window (lastActivityAt = now).
     *   2. If configured === 'auto' && runtime === 'survivor', flips runtime
     *      back to assistant and pauses self_prompter — the inverse of the
     *      idle-timeout drop, so a user who comes back after the bot has
     *      already returned to survivor is immediately re-grabbed.
     *
     * For configured = assistant-server / assistant-user, noteActivity is a
     * no-op beyond resetting lastActivityAt (which is unused for those
     * profiles since the timer never arms). Survivor: pure no-op.
     */
    noteActivity(source) {
        const now = Date.now();
        const prevActivity = this.lastActivityAt;
        this.lastActivityAt = now;

        if (this.configured !== 'auto') return;

        if (this.runtime === 'survivor') {
            // Sticky-return via chat: user spoke after a previous idle drop.
            const prev = this.runtime;
            this.runtime = 'assistant';
            const sinceMs = now - prevActivity;
            console.log(`[ModeProfile] runtime ${prev}->${this.runtime} reason=auto_chat_return source=${source} since_last_activity_ms=${sinceMs}`);
            this._pauseForAssistant(`auto chat-return (${source})`);
            this._startIdleTimer();
        }
        // runtime === 'assistant': just resetting the window; timer is
        // already armed and will see the new lastActivityAt on its next tick.
    }

    /**
     * Arm the idle-check interval. Idempotent: clears any existing timer
     * before scheduling a new one. Only meaningful when configured === 'auto'
     * && runtime === 'assistant'; callers are responsible for that gate.
     */
    _startIdleTimer() {
        if (this.idleTimer) {
            clearInterval(this.idleTimer);
            this.idleTimer = null;
        }
        console.log(`[ModeProfile] idle-timer armed window_ms=${IDLE_MS} check_ms=${IDLE_CHECK_MS}`);
        this.idleTimer = setInterval(() => {
            try {
                this._checkIdle();
            } catch (e) {
                console.warn(`[ModeProfile] idle-check threw: ${e.message}`);
            }
        }, IDLE_CHECK_MS);
        // Don't keep the Node event loop alive purely for this timer.
        if (this.idleTimer && typeof this.idleTimer.unref === 'function') {
            this.idleTimer.unref();
        }
    }

    /**
     * Disarm the idle-check interval. Idempotent. Called from setConfigured
     * (any profile change), from _dropToSurvivor (after the drop, no longer
     * needed), and would also be called from any future shutdown path.
     */
    _stopIdleTimer() {
        if (!this.idleTimer) return;
        clearInterval(this.idleTimer);
        this.idleTimer = null;
        console.log(`[ModeProfile] idle-timer disarmed`);
    }

    /**
     * One tick of the idle check. If we've been quiet for >= IDLE_MS while
     * configured=auto && runtime=assistant, fire _dropToSurvivor. Otherwise
     * no-op (next tick will re-check). Defensive guard: if state has drifted
     * away from auto+assistant somehow, disarm rather than firing.
     */
    _checkIdle() {
        if (this.configured !== 'auto' || this.runtime !== 'assistant') {
            // State drifted out of the only configuration where this timer
            // makes sense. Disarm — whoever moved us out should already have
            // called _stopIdleTimer, but this is the belt-and-suspenders.
            this._stopIdleTimer();
            return;
        }
        const idleMs = Date.now() - this.lastActivityAt;
        if (idleMs >= IDLE_MS) {
            this._dropToSurvivor(`auto_idle_timeout idle_ms=${idleMs}`);
        }
    }

    /**
     * Auto idle drop-back: flip runtime assistant → survivor and resume
     * self_prompter. Mirrors _resumeFromAssistant's pause-skip semantics.
     * Disarms the idle timer (we're no longer in assistant). Drop fires
     * regardless of player presence — that's the whole point of auto.
     */
    _dropToSurvivor(reason) {
        const prev = this.runtime;
        this.runtime = 'survivor';
        console.log(`[ModeProfile] runtime ${prev}->${this.runtime} reason=${reason}`);
        this._stopIdleTimer();
        // Mirror of _resumeFromAssistant body: resume self_prompter so the
        // bot picks survivor work back up. Idempotent — skips if not paused
        // or no prompt exists.
        const sp = this.agent?.self_prompter;
        if (!sp) {
            console.warn(`[ModeProfile] drop requested but no self_prompter reason=${reason}`);
            return;
        }
        if (!sp.isPaused()) {
            console.log(`[ModeProfile] drop: resume skipped — self_prompter not paused (state=${sp.state}) reason=${reason}`);
            return;
        }
        if (!sp.prompt) {
            console.log(`[ModeProfile] drop: resume skipped — no prompt to resume reason=${reason}`);
            return;
        }
        console.log(`[ModeProfile] drop: resuming self_prompter reason=${reason}`);
        try {
            sp.start();
        } catch (e) {
            console.warn(`[ModeProfile] drop: resume threw: ${e.message}`);
        }
    }

    // --- Persistence (mirrors ModeController) ----------------------------

    getJson() {
        return {
            configured: this.configured,
            runtime: this.runtime,
            assistant_user: this.assistant_user,
        };
    }

    loadJson(json) {
        if (!json || typeof json !== 'object') return;
        if (VALID_PROFILES.includes(json.configured)) {
            this.configured = json.configured;
        }
        if (json.runtime === 'survivor' || json.runtime === 'assistant') {
            this.runtime = json.runtime;
        }
        if (typeof json.assistant_user === 'string' && json.assistant_user.length > 0) {
            this.assistant_user = json.assistant_user;
        }
        console.log(`[ModeProfile] loadJson configured=${this.configured} runtime=${this.runtime} assistant_user=${this.assistant_user || '(none)'}`);
    }
}

/**
 * Resolve the configured profile string from a parsed bot-profile JSON.
 * Returns { value, defaulted: bool, invalid: bool, raw? } so the caller can
 * warn appropriately.
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

/**
 * Resolve the assistant_user string from a parsed bot-profile JSON. Returns
 * the username string or null if absent/empty/wrong-type. Caller decides
 * whether this matters (only matters when configured === 'assistant-user').
 */
export function resolveAssistantUserFromProfileJson(profile) {
    const raw = profile?.assistant_user;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
