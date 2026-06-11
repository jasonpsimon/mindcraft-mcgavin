import { describe, it, expect } from 'vitest';
import * as skills from '../../src/agent/library/skills.js';

const PUBLIC_EXPORTS = [
  // Infrastructure
  'log', 'wait', 'createMovements', 'installSafePathfinderDefaults',
  // Crafting
  'craftRecipe', 'smeltItem', 'clearNearestFurnace',
  // Combat
  'attackNearest', 'attackEntity', 'defendSelf',
  // Blocks
  'collectBlock', 'pickupNearbyItems', 'breakBlockAt', 'placeBlock', 'autoBreakStuckPlant',
  // Inventory
  'equip', 'replaceBrokenArmor', 'safeToss', 'safeTossBatch',
  'discard', 'putInChest', 'takeFromChest', 'viewChest', 'giveToPlayer',
  // Movement
  'goToGoal', 'goToPosition', 'goToNearestBlock', 'goToNearestEntity',
  'goToPlayer', 'followPlayer', 'moveAway', 'moveAwayFromEntity',
  'avoidEnemies', 'stay', 'useDoor', 'goToBed',
  // Zones
  'loadPlayerStructures', 'detectNearbyVillages', 'startVillageScanner',
  'detectNearbyPlayerStructures', 'startPlayerStructureScanner',
  'startPlayerStructureWatcher', 'escapeSpawnZone', 'escapeProtectedZone',
  // Exploration
  'digDown', 'digUp', 'goToSurface', 'scanForCaverns',
  'placeTorchAt', 'placeBreadcrumbTorch',
  // Social
  'consume', 'tillAndSow', 'activateNearestBlock',
  'showVillagerTrades', 'tradeWithVillager', 'useToolOn',
];

describe('skills.js public API contract', () => {
  it('exports exactly 56 public symbols', () => {
    expect(PUBLIC_EXPORTS).toHaveLength(56);
  });

  it.each(PUBLIC_EXPORTS)('exports %s as a function', (name) => {
    expect(skills[name], `${name} missing from skills.js`).toBeDefined();
    expect(typeof skills[name]).toBe('function');
  });
});
