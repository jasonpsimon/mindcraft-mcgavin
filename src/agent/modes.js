import { isDiscardCooldownActive } from '../utils/inventory_utils.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import { withBotLock } from './bot_mutex.js';
// BT-7b: cleanup_blocks mode records each cleanup into the placement stream.
import { recordCleanup } from '../observability/placement_tracker.js';
// BT-7f: door/fence-gate close-on-exit.
import { recordDoorClose, doorHelpers } from '../observability/door_tracker.js';
import { Vec3 } from 'vec3';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// BT-10h (2026-04-19): dimension-aware tuning for survival reflexes. The
// bot is allowed to travel to the Nether and End (no retreat-on-entry);
// this helper lets individual reflexes adapt their thresholds instead of
// hardcoding overworld assumptions. Mineflayer reports `bot.game.dimension`
// as a namespaced string (`minecraft:the_nether`) on modern servers; older
// paths return the bare form (`the_nether`). Handle both.
//
// Profile fields:
//   dim                    — short label for logging
//   lowHpThreshold         — BT-10b retreat trigger (hp < threshold)
//   lavaAdjacentBackoff    — BT-10a preemptive ring-scan backoff enabled
//   voidCheckY             — null, or a Y below which void-awareness fires
function _dimensionProfile(bot) {
    const raw = (bot && bot.game && bot.game.dimension) || 'overworld';
    const dim = raw.replace(/^minecraft:/, '');
    if (dim === 'the_nether' || dim === 'nether') {
        return { dim: 'nether', lowHpThreshold: 10, lavaAdjacentBackoff: false, voidCheckY: null };
    }
    if (dim === 'the_end' || dim === 'end') {
        return { dim: 'end', lowHpThreshold: 10, lavaAdjacentBackoff: true, voidCheckY: 10 };
    }
    return { dim: 'overworld', lowHpThreshold: 6, lavaAdjacentBackoff: true, voidCheckY: null };
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            // #21 L1.1: treating missing blocks as 'air' is the correct defensive
            // fallback. blockAt() returns null when the chunk at that position
            // isn't loaded yet (common during spawn / teleport). 'air' short-circuits
            // the sand/gravel fall-block detector to 'no hazard' — safe default.
            if (!block) block = {name: 'air'};
            if (!blockAbove) blockAbove = {name: 'air'};

            // BT-10b (2026-04-19): low-HP-retreat latch clear. Runs at the top
            // of every tick so we exit retreat promptly once HP recovers or
            // hostiles disperse. Hysteresis: set at HP<6, clear at HP>=14 OR
            // no hostile within 12. This keeps the bot from oscillating.
            if (bot._lowHpRetreatActive) {
                let hostileNearby = false;
                try {
                    const h = world.getNearestEntityWhere(bot, e => mc.isHostile(e), 12);
                    hostileNearby = !!h;
                } catch (_) { /* ignore */ }
                if (bot.health >= 14 || !hostileNearby) {
                    console.log(`[Survival] low-hp-retreat cleared hp=${bot.health.toFixed(1)}`);
                    bot._lowHpRetreatActive = false;
                }
            }

            // BT-10c (2026-04-19 fix): reset the suffocation debounce counter
            // whenever head is NOT solid. This is the "not suffocating" check
            // that the trigger's `else` would do, hoisted to top-of-update so
            // we don't break the else-if chain. blockAbove was already computed
            // at the start of update().
            if (blockAbove) {
                const passableTop = ['air', 'cave_air', 'void_air', 'water', 'lava'];
                const headSolid = (
                    blockAbove.boundingBox === 'block' &&
                    !passableTop.includes(blockAbove.name)
                );
                if (!headSolid && bot._suffocationSolidTicks) {
                    bot._suffocationSolidTicks = 0;
                }
            }

            // BT-10h (2026-04-19): void awareness (End). The End islands sit
            // above a void; falling off is instant-death with no HP-based
            // reflex to catch it. When dimension has a voidCheckY, bot is
            // below it, and pathfinder is active — abort pathfinder and
            // back up. Latched so we don't re-fire every tick; cleared when
            // bot climbs back above the threshold with a 2-block buffer.
            const _dimProf = _dimensionProfile(bot);
            if (_dimProf.voidCheckY !== null && bot.entity && bot.entity.position) {
                const _y = bot.entity.position.y;
                const _pfMoving = (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving());
                if (_y < _dimProf.voidCheckY && _pfMoving && !bot._voidRetreatActive) {
                    bot._voidRetreatActive = true;
                    console.log(`[Survival] void-retreat dim=${_dimProf.dim} y=${_y.toFixed(2)}`);
                    say(agent, 'Near the void — backing up!');
                    execute(this, agent, async () => {
                        try {
                            if (bot.pathfinder && bot.pathfinder.stop) bot.pathfinder.stop();
                            await skills.moveAway(bot, 3);
                        } catch (_) { /* ignore — latch clears when bot regains altitude */ }
                    });
                } else if (bot._voidRetreatActive && _y >= _dimProf.voidCheckY + 2) {
                    bot._voidRetreatActive = false;
                }
            } else if (bot._voidRetreatActive) {
                // Dimension change out of the End: clear stale latch.
                bot._voidRetreatActive = false;
            }

                        // BT-10c (2026-04-19): suffocation latch clear. Cleared when the
            // head block is no longer a solid bounding-box block. Runs every
            // tick at the top so we exit the latch immediately after the dig
            // (or any external rescue) lands.
            if (bot._suffocationEscapeActive) {
                const passable = ['air', 'cave_air', 'void_air', 'water', 'lava'];
                const headClear = (
                    !blockAbove ||
                    passable.includes(blockAbove.name) ||
                    blockAbove.boundingBox !== 'block'
                );
                if (headClear) {
                    console.log('[Survival] suffocation-escape cleared');
                    bot._suffocationEscapeActive = false;
                }
            }

            // BT-10d (2026-04-19): ranged-evade latch clear. Clears when no
            // ranged hostile remains within 20 blocks OR nearest ranged is
            // already within 5 (we closed the gap, melee combat takes over)
            // OR HP has dropped below 6 (hand-off to BT-10b retreat).
            if (bot._rangedEvadeActive) {
                let nearestRangedDist = Infinity;
                try {
                    const rangedNames = ['skeleton', 'stray', 'pillager'];
                    const h = world.getNearestEntityWhere(
                        bot,
                        e => mc.isHostile(e) && rangedNames.includes(e.name),
                        20
                    );
                    if (h) nearestRangedDist = bot.entity.position.distanceTo(h.position);
                } catch (_) { /* ignore */ }
                if (nearestRangedDist === Infinity || nearestRangedDist <= 5 || bot.health < 6) {
                    console.log(`[Survival] ranged-close cleared dist=${nearestRangedDist === Infinity ? 'none' : nearestRangedDist.toFixed(1)} hp=${bot.health.toFixed(1)}`);
                    bot._rangedEvadeActive = false;
                }
            }

            // BT-10f (2026-04-19): creeper-evade latch clear. Clears when no
            // creeper within 10 blocks, OR distance to nearest creeper > 8
            // (we got outside blast radius), OR HP<6 (BT-10b takes priority).
            if (bot._creeperEvadeActive) {
                let nearestCreeperDist = Infinity;
                try {
                    const c = world.getNearestEntityWhere(
                        bot,
                        e => e && e.name === 'creeper',
                        10
                    );
                    if (c) nearestCreeperDist = bot.entity.position.distanceTo(c.position);
                } catch (_) { /* ignore */ }
                if (nearestCreeperDist === Infinity || nearestCreeperDist > 8 || bot.health < 6) {
                    console.log(`[Survival] creeper-evade cleared dist=${nearestCreeperDist === Infinity ? 'none' : nearestCreeperDist.toFixed(1)} hp=${bot.health.toFixed(1)}`);
                    bot._creeperEvadeActive = false;
                }
            }

            // BT-10g (2026-04-19): drowning escape state maintenance.
            // Runs at top of update() independently of the else-if chain.
            // Control-state based (not execute): vanilla Minecraft jump
            // while in water = swim up. Symmetric set/clear around the
            // latch keeps controls from sticking.
            if (bot._drowningEscapeActive) {
                const inWater = !!bot.entity.isInWater;
                const oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20;
                if (!inWater || oxygen >= 18) {
                    try { bot.setControlState('jump', false); } catch (_) {}
                    try { bot.setControlState('forward', false); } catch (_) {}
                    console.log(`[Survival] drowning-escape cleared oxygen=${oxygen} in_water=${inWater}`);
                    bot._drowningEscapeActive = false;
                }
            } else {
                const inWater = !!bot.entity.isInWater;
                const oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20;
                if (inWater && oxygen <= 10) {
                    bot._drowningEscapeActive = true;
                    console.log(`[Survival] drowning-escape oxygen=${oxygen}`);
                    say(agent, 'Drowning — surfacing!');
                    try { bot.setControlState('jump', true); } catch (_) {}
                    try { bot.setControlState('forward', true); } catch (_) {}
                }
            }

            // BT-10e (2026-04-19): shield auto-raise state maintenance.
            // Runs at the top of update() independently of the else-if chain
            // below — this is state maintenance, not an alternative action.
            // Pair of clear + trigger. Zero cost when no shield is in offhand
            // (pre-gate short-circuits). When shield IS in offhand, we keep
            // it raised exactly when a hostile is within 16 blocks.
            if (bot._shieldRaiseActive) {
                const offhand = bot.inventory.slots[45];
                const hasShieldOff = !!(offhand && offhand.name && offhand.name.includes('shield'));
                let threatNearby = false;
                try {
                    const h = world.getNearestEntityWhere(bot, e => mc.isHostile(e), 16);
                    threatNearby = !!h;
                } catch (_) { /* ignore */ }
                if (!threatNearby || !hasShieldOff) {
                    try { bot.deactivateItem(); } catch (_) { /* ignore */ }
                    console.log(`[Survival] shield-raise cleared threat=${threatNearby} shield=${hasShieldOff}`);
                    bot._shieldRaiseActive = false;
                }
            } else {
                const offhand = bot.inventory.slots[45];
                const hasShieldOff = !!(offhand && offhand.name && offhand.name.includes('shield'));
                if (hasShieldOff) {
                    let threat = null;
                    try {
                        threat = world.getNearestEntityWhere(bot, e => mc.isHostile(e), 16);
                    } catch (_) { /* ignore */ }
                    if (threat) {
                        const tdist = bot.entity.position.distanceTo(threat.position);
                        try {
                            bot.activateItem(true); // offhand = true → raise shield
                            bot._shieldRaiseActive = true;
                            console.log(`[Survival] shield-raise threat=${threat.name} dist=${tdist.toFixed(1)}`);
                        } catch (_) { /* no latch set; retry next tick */ }
                    }
                }
            }
            // Drowning check: head in water OR oxygen dropping while submerged.
            // Always hold jump when drowning, even during an active pathfind —
            // mineflayer tolerates setControlState('jump', true) while pathfinder
            // is running, and the lift helps the bot surface in shallow water.
            // Prior bug: gating on !bot.pathfinder.goal suppressed the anti-drown
            // reflex exactly when the bot was walking into water during an escape,
            // causing it to drown mid-path.
            const headInWater = blockAbove.name === 'water';
            const lowOxygen = typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 18;
            if (headInWater || (lowOxygen && bot.entity.isInWater)) {
                bot.setControlState('jump', true);
            }
            // BT-10c (2026-04-19): suffocation escape. Triggers when the head
            // block is a solid bounding-box block (full-block collision) that is
            // NOT in the passable allowlist. Catches: completed sand/gravel
            // collapses, world-edit drops, cave-ins, mob shoves into walls,
            // griefer towers. Lava-as-head-block is excluded — the lava
            // branch handles that case with its own escape primitives.
            //
            // 2026-04-19 fix: false-positive debounce. We observed a trigger
            // in a cave with head=air per the game's own NEARBY_BLOCKS snapshot.
            // `bot.blockAt(position.offset(0,1,0))` can return stale/wrong
            // results during fractional-y transitions (jumps, slabs, post-dig
            // ticks). Real suffocation persists many seconds; a glitch clears
            // in 1-2 ticks. Require 5 consecutive solid-head ticks (~0.25s)
            // before firing. Counter reset is at top-of-update() (preserves
            // else-if chain below). Diagnostic log now includes pos + legs.
            else if (
                blockAbove &&
                blockAbove.boundingBox === 'block' &&
                !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(blockAbove.name) &&
                !bot._suffocationEscapeActive
            ) {
                bot._suffocationSolidTicks = (bot._suffocationSolidTicks || 0) + 1;
                if (bot._suffocationSolidTicks >= 5) {
                    bot._suffocationEscapeActive = true;
                    bot._suffocationSolidTicks = 0;
                    const headType = blockAbove.name;
                    const pos = bot.entity.position;
                    let legsType = 'unknown';
                    try {
                        const legsBlock = bot.blockAt(pos);
                        if (legsBlock) legsType = legsBlock.name;
                    } catch (_) { /* ignore */ }
                    console.log(`[Survival] suffocation-escape head=${headType} legs=${legsType} pos=${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`);
                    say(agent, 'Suffocating — digging up!');
                    execute(this, agent, async () => {
                        try {
                            await skills.breakBlockAt(bot,
                                Math.floor(pos.x),
                                Math.floor(pos.y) + 1,
                                Math.floor(pos.z));
                        } catch (_) {
                            // Latch stays set; top-of-update clear handles
                            // the case where head clears via any other means.
                        }
                    });
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            // BT-10a (2026-04-19): primary lava reflex — `bot.entity.isInLava`
            // is the authoritative signal from mineflayer. Catches flowing-lava
            // columns where the feet-block resolves to `air` due to bounding-box
            // geometry. Hold jump, step toward the first non-lava cardinal
            // neighbor, and parallel-attempt water-bucket placement. Dedup the
            // log via `bot._lavaEscapeActive` so the line fires once per episode.
            else if (bot.entity.isInLava) {
                if (!bot._lavaEscapeActive) {
                    bot._lavaEscapeActive = true;
                    const hasWater = !!bot.inventory.findInventoryItem('water_bucket');
                    // Scan 4 cardinals at feet level for an escape tile.
                    const dirs = [
                        { dx: 1,  dz: 0,  name: 'E' },
                        { dx: -1, dz: 0,  name: 'W' },
                        { dx: 0,  dz: 1,  name: 'S' },
                        { dx: 0,  dz: -1, name: 'N' },
                    ];
                    let chosen = null;
                    for (const d of dirs) {
                        try {
                            const feet = bot.blockAt(bot.entity.position.offset(d.dx, 0, d.dz));
                            const head = bot.blockAt(bot.entity.position.offset(d.dx, 1, d.dz));
                            if (!feet || !head) continue;
                            if (feet.name === 'lava' || feet.name === 'fire' || feet.name === 'void_air') continue;
                            // Need an air (or walkable) head and a non-passable feet-block to stand on,
                            // OR a non-lava feet tile we can scramble into.
                            if (head.name === 'air' || head.name === 'cave_air') {
                                chosen = d;
                                break;
                            }
                        } catch (_) { /* ignore */ }
                    }
                    console.log(`[Survival] lava-escape dir=${chosen ? chosen.name : 'none'} has_water=${hasWater}`);
                    say(agent, 'Lava! Getting out!');
                    if (chosen) {
                        try {
                            const tgt = bot.entity.position.offset(chosen.dx, 0, chosen.dz);
                            bot.lookAt(tgt, true).catch(() => {});
                        } catch (_) { /* ignore */ }
                    }
                }
                // Every tick while submerged: continuous jump + forward toward chosen dir.
                bot.setControlState('jump', true);
                bot.setControlState('forward', true);
                // Parallel: try water bucket once (execute() wrapper handles re-entry guard).
                const waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        const wb = bot.inventory.findInventoryItem('water_bucket');
                        if (!wb) return;
                        try {
                            const success = await skills.placeBlock(bot, 'water_bucket',
                                block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Water placed, cooling off!');
                        } catch (_) { /* ignore — we'll still be stepping out */ }
                    });
                }
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            // BT-10a (2026-04-19): preemptive lava-adjacency step-back. Fires
            // only when idle — don't preempt user-requested work. One-shot
            // moveAway so we don't oscillate against pathfinder goals.
            else if (agent.isIdle() && !bot._lavaEdgeBackoffActive && _dimensionProfile(bot).lavaAdjacentBackoff) {
                let lavaAdj = false;
                try {
                    const adj = [[1,0],[-1,0],[0,1],[0,-1]];
                    for (const [dx, dz] of adj) {
                        const nb = bot.blockAt(bot.entity.position.offset(dx, 0, dz));
                        if (nb && (nb.name === 'lava' || nb.name === 'fire')) {
                            lavaAdj = true;
                            break;
                        }
                    }
                } catch (_) { /* ignore */ }
                if (lavaAdj) {
                    bot._lavaEdgeBackoffActive = true;
                    console.log('[Survival] lava-adjacent moving away');
                    say(agent, 'Too close to lava — backing up.');
                    execute(this, agent, async () => {
                        try { await skills.moveAway(bot, 2); } catch (_) { /* ignore */ }
                        bot._lavaEdgeBackoffActive = false;
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            // BT-10b (2026-04-19): proactive low-HP mob retreat. Fires when HP
            // is critical AND a hostile is in range, even if no damage event in
            // the last 3s (catches chase-but-not-hit scenarios). Latched so we
            // don't retrigger every tick; cleared at top of update() via
            // _lowHpRetreatActive. Retreats directly away from the nearest
            // hostile (via moveAwayFromEntity) instead of a random moveAway
            // direction.
            else if (bot.health < _dimensionProfile(bot).lowHpThreshold && !bot._lowHpRetreatActive) {
                let hostile = null;
                try {
                    hostile = world.getNearestEntityWhere(bot, e => mc.isHostile(e), 12);
                } catch (_) { /* ignore */ }
                if (hostile) {
                    bot._lowHpRetreatActive = true;
                    const dist = bot.entity.position.distanceTo(hostile.position);
                    console.log(`[Survival] low-hp-retreat hp=${bot.health.toFixed(1)} hostile=${hostile.name} dist=${dist.toFixed(1)}`);
                    say(agent, `Low HP — retreating from ${hostile.name}!`);
                    // Capture hostile at this tick; moveAwayFromEntity handles
                    // the vector math + pathfinder goal internally.
                    const target = hostile;
                    execute(this, agent, async () => {
                        try {
                            await skills.moveAwayFromEntity(bot, target, 16);
                        } catch (_) { /* ignore — latch stays set until HP recovers */ }
                    });
                }
            }
            // BT-10d (2026-04-19): ranged-attacker close-distance reflex.
            // Fires when a skeleton/stray/pillager is within [6, 20] blocks
            // and the bot is healthy (HP>=6). Closes to 4 blocks so the
            // existing melee combat takes over and the kite is broken. Melee
            // hostiles are not handled here — self_defense already does the
            // right thing at close range. Lower bound of 6 avoids fighting
            // combat's own target-tracking. Latch-gated via _rangedEvadeActive.
            else if (bot.health >= 6 && !bot._rangedEvadeActive) {
                let ranged = null;
                try {
                    const rangedNames = ['skeleton', 'stray', 'pillager'];
                    ranged = world.getNearestEntityWhere(
                        bot,
                        e => mc.isHostile(e) && rangedNames.includes(e.name),
                        20
                    );
                } catch (_) { /* ignore */ }
                if (ranged) {
                    const dist = bot.entity.position.distanceTo(ranged.position);
                    if (dist >= 6) {
                        bot._rangedEvadeActive = true;
                        console.log(`[Survival] ranged-close type=${ranged.name} dist=${dist.toFixed(1)}`);
                        say(agent, `Closing on ${ranged.name}!`);
                        const target = ranged;
                        execute(this, agent, async () => {
                            try {
                                const pos = target.position;
                                await skills.goToPosition(
                                    bot,
                                    Math.floor(pos.x),
                                    Math.floor(pos.y),
                                    Math.floor(pos.z),
                                    4
                                );
                            } catch (_) { /* latch stays set; top-of-update clear handles exit */ }
                        });
                    }
                }
            }
            // BT-10f (2026-04-19): creeper proximity evade. Fires when a
            // creeper enters 5 blocks and HP>=6. Backs off to 8 blocks
            // (outside blast radius) so combat can then engage safely. Does
            // NOT handle charged creepers specially — 8 blocks is still
            // outside their ~6-block blast radius.
            else if (bot.health >= 6 && !bot._creeperEvadeActive) {
                let creeper = null;
                try {
                    creeper = world.getNearestEntityWhere(
                        bot,
                        e => e && e.name === 'creeper',
                        5
                    );
                } catch (_) { /* ignore */ }
                if (creeper) {
                    bot._creeperEvadeActive = true;
                    const dist = bot.entity.position.distanceTo(creeper.position);
                    console.log(`[Survival] creeper-evade dist=${dist.toFixed(1)}`);
                    say(agent, 'Creeper! Backing off!');
                    const target = creeper;
                    execute(this, agent, async () => {
                        try {
                            await skills.moveAwayFromEntity(bot, target, 8);
                        } catch (_) { /* latch stays set; top-of-update clear handles exit */ }
                    });
                }
            }
            else if (agent.isIdle()) {
                // BT-10a: clear the lava-escape latch when we're out of lava.
                if (bot._lavaEscapeActive && !bot.entity.isInLava) {
                    bot._lavaEscapeActive = false;
                }
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    const crashTimeout = setTimeout(() => { agent.cleanKill("Got stuck and couldn't get unstuck") }, 10000);
                    await skills.moveAway(bot, 5);
                    clearTimeout(crashTimeout);
                    say(agent, 'I\'m free.');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            // Detection range must match defendSelf's attack range (8) — otherwise
            // enemies in the 8–16 ring trigger the say() + execute() but defendSelf
            // scans at 8 and aborts, producing phantom "Fighting X!" announcements
            // with no actual combat. Principle 1 alignment: don't ask the mode to
            // trigger on a distance the skill can't handle.
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            if (isDiscardCooldownActive()) return; // skip pickup right after discarding
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when it is dark (night / underground / low sky-light) and no torch is nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    // placeTorchAt records the torch in bot.placedTorches for
                    // breadcrumb navigation via goToSurface.
                    await skills.placeTorchAt(agent.bot, pos.x, pos.y, pos.z, 'bottom');
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        // BT-7f (2026-04-19): close doors/fence gates the bot opened during
        // pathfinding or LLM-driven activation. Reads bot._openedDoors
        // (populated by door_tracker via a bot.activateBlock wrapper) and
        // re-activates each entry once the bot has moved on.
        //
        // Skip reasons:
        //   - player-nearby      (don't close in someone's face)
        //   - too-close           (bot still within min_distance)
        //   - not-trackable       (block no longer a door/gate)
        //   - already-closed      (state changed externally)
        //
        // Note: no protected-zone skip — closing doors inside player bases
        // is *exactly* what we want (keeps mobs out at night). Bot shouldn't
        // have been opening protected-zone doors gratuitously in the first
        // place, but if it did, closing is strictly beneficial.
        //
        // interrupts:[] means this never preempts running work.
        name: 'close_doors',
        description: 'When idle, close doors/fence gates the bot opened and then walked away from.',
        interrupts: [],
        on: true,
        active: false,
        min_distance: 3,
        player_guard: 3,
        update: async function (agent) {
            const bot = agent.bot;
            if (!Array.isArray(bot._openedDoors) || bot._openedDoors.length === 0) return;
            const bpos = bot.entity && bot.entity.position;
            if (!bpos) return;
            const now = Date.now();

            // Find the oldest door eligible for closing.
            let idx = -1;
            let target = null;
            let skipReason = null;
            for (let i = 0; i < bot._openedDoors.length; i++) {
                const e = bot._openedDoors[i];
                if (!e) continue;
                const cx = e.x + 0.5, cy = e.y + 0.5, cz = e.z + 0.5;
                const dx = bpos.x - cx, dy = bpos.y - cy, dz = bpos.z - cz;
                if ((dx*dx + dy*dy + dz*dz) <= (this.min_distance * this.min_distance)) continue;

                // Player-occupancy check (any non-bot player entity within player_guard).
                let playerNearby = false;
                try {
                    for (const id in bot.entities) {
                        const ent = bot.entities[id];
                        if (!ent || ent === bot.entity) continue;
                        if (ent.type !== 'player') continue;
                        const pd = ent.position;
                        if (!pd) continue;
                        const pdx = pd.x - cx, pdy = pd.y - cy, pdz = pd.z - cz;
                        if ((pdx*pdx + pdy*pdy + pdz*pdz) <= (this.player_guard * this.player_guard)) {
                            playerNearby = true;
                            break;
                        }
                    }
                } catch (_) { /* ignore */ }
                if (playerNearby) {
                    skipReason = 'player-nearby';
                    idx = i; target = e; break;
                }

                idx = i; target = e; break;
            }
            if (idx === -1) return;

            // Re-read the block; verify it's still a door/gate AND still open.
            let blk;
            try {
                blk = bot.blockAt(new Vec3(target.x, target.y, target.z));
            } catch (_) {
                return; // chunk unloaded or lookup failed; try again next tick
            }
            if (!blk || !doorHelpers.isTrackable(blk.name)) {
                const age_s = Math.floor((now - target.t) / 1000);
                bot._openedDoors.splice(idx, 1);
                recordDoorClose({ x: target.x, y: target.y, z: target.z,
                    type: target.type, age_s, ok: false, reason: 'not-trackable' });
                return;
            }
            if (!doorHelpers.isOpen(blk)) {
                const age_s = Math.floor((now - target.t) / 1000);
                bot._openedDoors.splice(idx, 1);
                recordDoorClose({ x: target.x, y: target.y, z: target.z,
                    type: target.type, age_s, ok: false, reason: 'already-closed' });
                return;
            }

            if (skipReason) {
                // Don't splice on player-nearby — try again next tick when they move.
                const age_s = Math.floor((now - target.t) / 1000);
                recordDoorClose({ x: target.x, y: target.y, z: target.z,
                    type: target.type, age_s, ok: false, reason: skipReason });
                return;
            }

            execute(this, agent, async () => {
                const age_s = Math.floor((now - target.t) / 1000);
                let ok = false;
                try {
                    await bot.activateBlock(blk);
                    ok = true;
                } catch (_) {
                    ok = false;
                }
                const j = bot._openedDoors.indexOf(target);
                if (j !== -1) bot._openedDoors.splice(j, 1);
                recordDoorClose({ x: target.x, y: target.y, z: target.z,
                    type: target.type, age_s, ok, reason: ok ? null : 'activate-threw' });
            });
        }
    },
    {
        // BT-7b (2026-04-19): self-cleanup of incidental block placements.
        // Reads bot._placedBlocks (populated by placement_tracker module),
        // breaks eligible entries one at a time when the bot is idle.
        //
        // Eligibility (all must hold):
        //   - entry.purpose !== 'intentional'  (LLM !placeBlock never cleaned)
        //   - age >= 30s                        (give the bot time to finish using it)
        //   - distance(bot, block) > 5          (don't break what we might still be standing on)
        //   - block at coord still matches entry.type (world may have already changed)
        //
        // interrupts:[] + no active-goal check in execute means this will NEVER
        // preempt running work; the controller only invokes update() on idle modes.
        name: 'cleanup_blocks',
        description: 'When idle, break blocks the bot placed incidentally (scaffolding, LLM confusion).',
        interrupts: [],
        on: true,
        active: false,
        min_age_ms: 30 * 1000,
        min_distance: 5,
        update: async function (agent) {
            const bot = agent.bot;
            if (!Array.isArray(bot._placedBlocks) || bot._placedBlocks.length === 0) return;

            const now = Date.now();
            const bpos = bot.entity && bot.entity.position;
            if (!bpos) return;

            let target_idx = -1;
            let target = null;
            for (let i = 0; i < bot._placedBlocks.length; i++) {
                const e = bot._placedBlocks[i];
                if (!e || e.purpose === 'intentional') continue;
                if (now - e.t < this.min_age_ms) continue;
                const dx = bpos.x - (e.x + 0.5);
                const dy = bpos.y - (e.y + 0.5);
                const dz = bpos.z - (e.z + 0.5);
                if ((dx*dx + dy*dy + dz*dz) <= (this.min_distance * this.min_distance)) continue;
                target_idx = i;
                target = e;
                break;
            }
            if (target_idx === -1) return;

            // Verify the block is still what we placed — the world may have changed.
            try {
                const blk = bot.blockAt(new Vec3(target.x, target.y, target.z));
                if (!blk || blk.name !== target.type) {
                    // Block no longer matches — forget about it silently.
                    bot._placedBlocks.splice(target_idx, 1);
                    recordCleanup({
                        x: target.x, y: target.y, z: target.z,
                        type: target.type, purpose: target.purpose,
                        age_s: Math.floor((now - target.t) / 1000),
                        ok: false,
                    });
                    return;
                }
            } catch (_) {
                return; // chunk unloaded or lookup failed; try again next tick
            }

            execute(this, agent, async () => {
                const age_s = Math.floor((now - target.t) / 1000);
                const ok = await skills.breakBlockAt(bot, target.x, target.y, target.z);
                // Always splice — either we broke it (ok) or the zone/perm blocked us
                // (ok=false) and we don't want to retry the same block every tick.
                const idx = bot._placedBlocks.indexOf(target);
                if (idx !== -1) bot._placedBlocks.splice(idx, 1);
                recordCleanup({
                    x: target.x, y: target.y, z: target.z,
                    type: target.type, purpose: target.purpose,
                    age_s, ok: !!ok,
                });
            });
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    // Safety-critical modes (declared interrupts: ['all']) bypass the bot
    // mutex entirely. They are reflexive, short-lived responses to damage,
    // drowning, suffocation, or nearby hostiles; blocking them behind a long
    // skill (SafeToss, digDown, escapeSpawnZone) caused the bot to die while
    // waiting for its turn to defend itself. The small pathfinder-race risk
    // we re-introduce here is strictly better than suffocation / zombie death.
    const interruptsAll = Array.isArray(mode.interrupts) && mode.interrupts.includes('all');
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        if (interruptsAll) {
            // Reflex mode — run immediately without acquiring the mutex.
            await func();
        } else {
            // Routine mode (item_collecting, torch_placing, etc.) — serialize
            // with LLM commands, AutoRecovery, SafeToss, digDown.
            await withBotLock(`mode:${mode.name}`, () => func());
        }
    }, { timeout });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}. Try the action again or use a different approach.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
