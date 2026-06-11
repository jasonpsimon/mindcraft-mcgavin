/**
 * Vitest global setup — runs before each test file in the same context.
 * Mocks the mcdata module so crafting/smelting functions work without a live
 * Minecraft connection.  The mock returns sensible defaults: unknown items
 * have no recipes (empty array) and known items have minimal stubs.
 */
import { vi } from 'vitest';
import minecraftData from 'minecraft-data';

// Initialize a real mcdata instance so the mocked module can delegate to it.
const MC_VERSION = '1.20.2';
const _real = minecraftData(MC_VERSION);

vi.mock('../../src/utils/mcdata.js', () => {
  return {
    getItemCraftingRecipes: (itemName) => {
      const item = _real.itemsByName[itemName];
      if (!item || !_real.recipes[item.id]) return [];
      return _real.recipes[item.id];
    },
    getItemId: (itemName) => {
      const item = _real.itemsByName[itemName];
      return item ? item.id : null;
    },
    getItemName: (itemId) => {
      const item = _real.items[itemId];
      return item ? item.name : null;
    },
    isSmeltable: (itemName) => {
      const smeltable = ['raw_iron', 'raw_gold', 'raw_copper', 'beef', 'chicken', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon'];
      return smeltable.includes(itemName);
    },
    getSmeltingFuel: () => null,
    getFuelSmeltOutput: () => 8,
    ingredientsFromPrismarineRecipe: () => ({}),
    calculateLimitingResource: () => ({ num: 0, limitingResource: 'unknown' }),
    makeItem: () => null,
    getNearestBlock: () => null,
    getInventoryCounts: () => ({}),
    getNearestFreeSpace: () => ({ x: 0, y: 64, z: 0 }),
    isHuntable: () => false,
    isHostile: () => false,
  };
});
