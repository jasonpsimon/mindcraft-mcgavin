import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/mcdata.js', () => ({
  getItemCraftingRecipes: (itemName) => {
    const knownItems = { stick: [{}], crafting_table: [{}], oak_planks: [{}] };
    return knownItems[itemName] ?? null;
  },
  getItemId: (itemName) => null,
  getItemName: (itemId) => null,
  isSmeltable: () => false,
  getSmeltingFuel: () => null,
  getFuelSmeltOutput: () => 8,
  ingredientsFromPrismarineRecipe: () => ({}),
  calculateLimitingResource: () => ({ num: 0, limitingResource: 'unknown' }),
}));

import { craftRecipe, smeltItem, clearNearestFurnace } from '../../src/agent/library/skills/crafting.js';
import { createMockBot } from '../helpers/mock-bot.js';

describe('craftRecipe', () => {
  it('is a function', () => {
    expect(typeof craftRecipe).toBe('function');
  });

  it('logs error when item unknown', async () => {
    const bot = createMockBot();
    bot.recipesFor = vi.fn().mockReturnValue([]);
    await craftRecipe(bot, 'nonexistent_item_xyz');
    expect(bot.output).toContain('nonexistent_item_xyz');
  });
});

describe('smeltItem', () => {
  it('is a function', () => {
    expect(typeof smeltItem).toBe('function');
  });
});

describe('clearNearestFurnace', () => {
  it('is a function', () => {
    expect(typeof clearNearestFurnace).toBe('function');
  });
});
