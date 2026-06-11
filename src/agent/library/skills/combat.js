import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements } from './_shared.js';
// cross-domain
import { goToPosition } from './movement.js';
import { pickupNearbyItems } from './blocks.js';

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    // BT-10i (2026-04-19): durability filter. Drop weapons at <5% remaining
    // durability before the attackDamage sort so we don't pick a sword that
    // shatters mid-swing and leaves the bot empty-handed. Fall back to the
    // unfiltered list if filtering removes every candidate — better to
    // swing a near-broken weapon than fists. mineflayer exposes item wear
    // via `item.durabilityUsed` (0 = pristine); max comes from
    // `item.maxDurability` when present, else infer from item stats.
    const _healthy = weapons.filter(w => {
        const max = w.maxDurability;
        if (!max || typeof w.durabilityUsed !== 'number') return true;  // unknown — assume fine
        return (max - w.durabilityUsed) / max >= 0.05;
    });
    if (_healthy.length > 0) weapons = _healthy;
    // Bug fix 2026-04-15: previous comparator returned a boolean (a < b), which
    // is treated as 0 by sort and produced random ordering. Use proper b-a for
    // descending sort by attackDamage. Also handle missing attackDamage values.
    weapons.sort((a, b) => (b.attackDamage || 0) - (a.attackDamage || 0));
    let weapon = weapons[0];
    if (weapon && bot.heldItem?.type !== weapon.type)
        await bot.equip(weapon, 'hand');
}


async function _impl_attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}
export const attackNearest = wrapSkill('attackNearest', _impl_attackNearest);

async function _impl_attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}
export const attackEntity = wrapSkill('attackEntity', _impl_attackEntity);

async function _impl_defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    // OPT-I (2026-04-19): pause modes so defendSelf doesn't re-enter via
    // self_defense while we're already fighting. The try/finally guarantees
    // unpause on every exit path (normal return, early `interrupt_code` return,
    // or a thrown error) — the modes controller only auto-unpauses when the
    // agent is idle, and during an active goal the agent is never idle, so
    // without this the mode stays paused for the rest of the goal's runtime
    // (bot hits mob once, then can't re-engage, dies silently).
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    try {
        // BT-10i (2026-04-19): shield to offhand once, before the fight loop.
        // Mineflayer's pvp blocks with shield when offhand-equipped; equipping
        // per-iteration would be wasteful and would re-trigger every 500ms.
        // Errors logged + swallowed (same policy as _equipBestToolFor) —
        // if equip fails for any reason, combat continues without shield.
        try {
            const _shield = bot.inventory.items().find(it => it.name === 'shield');
            const _offhand = bot.inventory.slots[45];  // offhand slot in mineflayer
            if (_shield && _offhand?.type !== _shield.type) {
                await bot.equip(_shield, 'off-hand');
            }
        } catch (_equipErr) {
            console.warn(`[defendSelf] shield equip skipped: ${_equipErr.message}`);
        }
        let attacked = false;
        let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        while (enemy) {
            await equipHighestAttack(bot);
            if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
                try {
                    bot.pathfinder.setMovements(createMovements(bot));
                    await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
                } catch (err) {/* might error if entity dies, ignore */}
            }
            if (bot.entity.position.distanceTo(enemy.position) <= 2) {
                try {
                    bot.pathfinder.setMovements(createMovements(bot));
                    let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                    await bot.pathfinder.goto(inverted_goal, true);
                } catch (err) {/* might error if entity dies, ignore */}
            }
            bot.pvp.attack(enemy);
            attacked = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        bot.pvp.stop();
        if (attacked)
            log(bot, `Successfully defended self.`);
        else
            log(bot, `No enemies nearby to defend self from.`);
        return attacked;
    } finally {
        bot.modes.unpause('self_defense');
        bot.modes.unpause('cowardice');
    }
}
export const defendSelf = wrapSkill('defendSelf', _impl_defendSelf);
