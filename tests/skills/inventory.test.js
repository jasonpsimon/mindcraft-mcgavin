import { describe, it, expect } from 'vitest';
import { equip, replaceBrokenArmor, safeToss, safeTossBatch, discard, putInChest, takeFromChest, viewChest, giveToPlayer } from '../../src/agent/library/skills/inventory.js';
import { _armorTier } from '../../src/agent/library/skills/inventory.js';

describe('_armorTier', () => {
  it('returns 0 for leather', () => expect(_armorTier('leather_helmet')).toBe(0));
  it('returns 1 for iron', () => expect(_armorTier('iron_chestplate')).toBe(1));
  it('returns 3 for diamond', () => expect(_armorTier('diamond_leggings')).toBe(3));
  it('returns 4 for netherite', () => expect(_armorTier('netherite_boots')).toBe(4));
  it('returns -1 for non-armor', () => expect(_armorTier('stone')).toBe(-1));
});

describe('inventory exports', () => {
  it.each(['equip', 'replaceBrokenArmor', 'safeToss', 'safeTossBatch', 'discard', 'putInChest', 'takeFromChest', 'viewChest', 'giveToPlayer'])(
    'exports %s as a function', (name) => {
      const mod = { equip, replaceBrokenArmor, safeToss, safeTossBatch, discard, putInChest, takeFromChest, viewChest, giveToPlayer };
      expect(typeof mod[name]).toBe('function');
    }
  );
});
