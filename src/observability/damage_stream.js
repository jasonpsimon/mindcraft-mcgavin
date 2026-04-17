/**
 * DamageStream — per-hit damage telemetry (BT-2).
 *
 * Problem
 * =======
 * Death is already logged (`agent.js` `messagestr` handler on `death.*`
 * translate keys; writes `last_death_position` to memory_bank + LTM +
 * episodic memory). Non-lethal damage is silent: the existing
 * `bot.on('health')` handler tracks `lastDamageTime` / `lastDamageTaken`
 * as state variables but emits nothing. A reader of the tmux buffer
 * sees the bot go from 20 HP to 6 HP between two command outputs with
 * no record of what happened in the interval.
 *
 * Solution
 * ========
 * Emit exactly one `[Damage]` structured record per `health`-decrease
 * event. Two sinks — console log line + append to JSONL — same pattern
 * as BT-1 StateTicker.
 *
 * Per-hit record:
 *   {t, amount, health_before, health_after, source, source_category,
 *    pos:{x,y,z}, dimension, food, lethal}
 *
 * Source inference (priority order, Rule 1 data-driven):
 *   1. Nearest hostile mob within HOSTILE_RANGE → source=<mob_name>,
 *      category="entity".
 *   2. Block at feet or at head that inflicts contact damage
 *      (lava, fire, cactus, magma_block, ...) → source=<block_name>,
 *      category="environment".
 *   3. Oxygen level below threshold → source="drowning",
 *      category="environment".
 *   4. Strong recent downward velocity → source="fall", category="fall".
 *   5. Otherwise → source="unknown", category="unknown".
 *
 * Death hand-off
 * ==============
 * `getLastDamage()` exposes the most recent damage record so the
 * existing death handler (bot.on('messagestr') on 'death.*') can write
 * `Died from <source> at (x,y,z) in <dimension>` into long-term memory
 * with the inferred source attached. The damage record outlives the
 * hit that produced it; the death handler consumes the residual signal.
 *
 * Philosophy alignment
 * ====================
 * - Principle 1 (reduce LLM reliance): pure classifier, no LLM.
 * - Principle 2 (memory is cognition): death record now carries
 *   inferred source into LTM; next-session bot starts knowing what
 *   killed it instead of re-deriving.
 * - Principle 4 (preserve work across sessions): LTM persistence
 *   is the pass-through mechanism.
 * - Principle 8 (fail loudly, informatively): no more silent HP
 *   drops. `unknown` is a first-class value, not a swallow.
 *
 * Rule alignment
 * ==============
 * - Rule 1 (flexible): HOSTILE_MOB_NAMES, ENV_DAMAGE_BLOCKS, and
 *   thresholds are module-level data. Adding a new hostile / damaging
 *   block is one data entry.
 * - Rule 5 (no adverse effects): additive only. Existing health /
 *   death handlers keep their behavior; DamageStream is called from
 *   within them. All methods try/catch the body; a classifier or
 *   write failure can never propagate to the caller.
 * - Rule 7 (invariant): DamageStream must not mutate bot state.
 *   `grep -E "bot\\.(dig|placeBlock|chat|toss|setControlState|attack|
 *   equip|unequip|activateItem)|pathfinder\\.goto"` on this file
 *   returns zero matches.
 */

import fs from 'node:fs';
import path from 'node:path';

// Hostile mob names — kept in sync with state_ticker.js's list. A shared
// module would be cleaner once a third consumer exists (BT-10 Entity
// delta stream is the likely trigger). Rule 9 (simplicity first):
// duplicate one constant rather than pre-factor abstractions.
const HOSTILE_MOB_NAMES = new Set([
    'zombie', 'zombie_villager', 'husk', 'drowned',
    'skeleton', 'stray', 'wither_skeleton',
    'creeper', 'spider', 'cave_spider',
    'witch', 'enderman', 'endermite',
    'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
    'phantom', 'slime', 'magma_cube',
    'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
    'guardian', 'elder_guardian',
    'warden', 'shulker',
]);

// Blocks that inflict contact damage. Check the block at feet (position)
// and at head (position.offset(0,1,0)). If either matches, we attribute
// the hit to that block family.
const ENV_DAMAGE_BLOCKS = new Set([
    'lava',
    'fire', 'soul_fire',
    'campfire', 'soul_campfire',
    'cactus',
    'sweet_berry_bush',
    'magma_block',
    'powder_snow',
    'wither_rose',
]);

// Thresholds.
const HOSTILE_RANGE = 4.0;          // blocks
const DROWNING_OXYGEN_THRESHOLD = 18; // <18 (out of 20) signals bot is losing air
const FALL_VELOCITY_THRESHOLD = -0.5; // velocity.y more-negative-than this just before hit implies fall

const ERROR_LOG_THROTTLE_MS = 10_000;

export class DamageStream {
    /**
     * @param {Agent} agent  mindcraft Agent (reads agent.bot only).
     * @param {object} [options]
     * @param {boolean} [options.log_to_console=true]
     * @param {boolean} [options.log_to_file=true]
     * @param {string}  [options.file_path='data/damage-stream.jsonl']
     */
    constructor(agent, options = {}) {
        this.agent = agent;
        this.logToConsole = options.log_to_console ?? true;
        this.logToFile = options.log_to_file ?? true;
        this.filePath = options.file_path ?? 'data/damage-stream.jsonl';

        this._lastDamage = null;
        this._prevVelocityY = 0;
        this._lastWriteErrorAt = 0;
        this._lastRecordErrorAt = 0;

        if (this.logToFile) {
            try {
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            } catch (err) {
                console.warn(`[Damage] could not create data dir for ${this.filePath}: ${err.message} — disabling file sink`);
                this.logToFile = false;
            }
        }
    }

    /**
     * Track Y-velocity between health ticks so the fall heuristic can read
     * the velocity just before impact. Call from the velocityUpdate/tick
     * path OR from the health handler itself (cheaper — one read per hit).
     * We take option two and sample velocity at the moment of damage.
     *
     * @param {number} prevHealth  Health before the event.
     * @param {number} newHealth   Health after the event.
     */
    recordDamage(prevHealth, newHealth) {
        try {
            const amount = prevHealth - newHealth;
            if (!(amount > 0)) return;
            const record = this._buildRecord(prevHealth, newHealth, amount);
            this._lastDamage = record;
            this._emit(record);
        } catch (err) {
            const now = Date.now();
            if (now - this._lastRecordErrorAt > ERROR_LOG_THROTTLE_MS) {
                this._lastRecordErrorAt = now;
                console.warn(`[Damage] recordDamage error: ${err.message}`);
            }
        }
    }

    /**
     * Return the most recent damage record, or null if none seen yet.
     * Used by the death handler to attach source to LTM.
     */
    getLastDamage() {
        return this._lastDamage;
    }

    _buildRecord(before, after, amount) {
        const bot = this.agent?.bot;
        const pos = bot?.entity?.position ?? null;
        const velY = bot?.entity?.velocity?.y;

        // Infer source BEFORE we update _prevVelocityY so the fall
        // heuristic compares against the velocity that was in effect
        // when this hit happened.
        const { source, source_category } = this._inferSource(bot);
        if (typeof velY === 'number') this._prevVelocityY = velY;

        return {
            t: new Date().toISOString(),
            amount: Number(amount.toFixed(2)),
            health_before: typeof before === 'number' ? Number(before.toFixed(2)) : null,
            health_after: typeof after === 'number' ? Number(after.toFixed(2)) : null,
            source,
            source_category,
            pos: pos && Number.isFinite(pos.x) ? {
                x: Number(pos.x.toFixed(2)),
                y: Number(pos.y.toFixed(2)),
                z: Number(pos.z.toFixed(2)),
            } : null,
            dimension: bot?.game?.dimension ?? null,
            food: bot?.food ?? null,
            lethal: typeof after === 'number' ? after <= 0 : null,
        };
    }

    /**
     * Source classifier. Priority order documented in the module header.
     * Returns `{source, source_category}`. Non-throwing; returns
     * `{source:'unknown', source_category:'unknown'}` on any failure.
     */
    _inferSource(bot) {
        try {
            const pos = bot?.entity?.position;
            if (!pos || !Number.isFinite(pos.x)) {
                return { source: 'unknown', source_category: 'unknown' };
            }

            // 1. Nearest hostile mob within HOSTILE_RANGE.
            const entitiesMap = bot.entities;
            if (entitiesMap) {
                let best = null;
                let bestDist = Infinity;
                for (const key in entitiesMap) {
                    const e = entitiesMap[key];
                    if (!e || e === bot.entity || !e.position) continue;
                    if (e.type !== 'mob' && e.type !== 'hostile') continue;
                    const dx = e.position.x - pos.x;
                    const dy = e.position.y - pos.y;
                    const dz = e.position.z - pos.z;
                    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (d <= HOSTILE_RANGE && d < bestDist && HOSTILE_MOB_NAMES.has(e.name)) {
                        best = e;
                        bestDist = d;
                    }
                }
                if (best) {
                    return { source: best.name, source_category: 'entity' };
                }
            }

            // 2. Contact-damage block at feet or head.
            if (typeof bot.blockAt === 'function') {
                const feet = bot.blockAt(pos);
                const head = bot.blockAt(pos.offset(0, 1, 0));
                for (const b of [feet, head]) {
                    if (b && b.name && ENV_DAMAGE_BLOCKS.has(b.name)) {
                        return { source: b.name, source_category: 'environment' };
                    }
                }
            }

            // 3. Drowning — oxygen below threshold.
            //    mineflayer exposes `bot.oxygenLevel` (0-20). During normal
            //    breathing it's 20 or undefined. Drowning drops it tick by tick.
            if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < DROWNING_OXYGEN_THRESHOLD) {
                return { source: 'drowning', source_category: 'environment' };
            }

            // 4. Fall — strongly negative Y-velocity just before this hit.
            if (this._prevVelocityY < FALL_VELOCITY_THRESHOLD) {
                return { source: 'fall', source_category: 'fall' };
            }

            return { source: 'unknown', source_category: 'unknown' };
        } catch (_) {
            return { source: 'unknown', source_category: 'unknown' };
        }
    }

    _emit(record) {
        const line = JSON.stringify(record);
        if (this.logToConsole) {
            const posStr = record.pos
                ? `(${record.pos.x},${record.pos.y},${record.pos.z})`
                : '?';
            console.log(
                `[Damage] amount=${record.amount} ` +
                `source=${record.source}(${record.source_category}) ` +
                `health=${record.health_before ?? '?'}->${record.health_after ?? '?'} ` +
                `pos=${posStr} food=${record.food ?? '?'} lethal=${record.lethal}`
            );
        }
        if (this.logToFile) {
            fs.appendFile(this.filePath, line + '\n', (err) => {
                if (!err) return;
                const now = Date.now();
                if (now - this._lastWriteErrorAt > ERROR_LOG_THROTTLE_MS) {
                    this._lastWriteErrorAt = now;
                    console.warn(`[Damage] file write error (${this.filePath}): ${err.message}`);
                }
            });
        }
    }
}
