import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import settings from "../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../utils/inventory_utils.js';
// Re-export public API from _shared so skills.js remains the single entry point.
export { log, wait, createMovements, installSafePathfinderDefaults } from './skills/_shared.js';
// Import domain-internal helpers (not re-exported).
import {
  expandBlockFamily, BLOCK_FAMILIES,
  _equipBestToolFor, _isUnderground, _isDangerous,
} from './skills/_shared.js';
export * from './skills/crafting.js';
import { craftRecipe } from './skills/crafting.js';
export * from './skills/combat.js';
export * from './skills/social.js';
export * from './skills/blocks.js';
export * from './skills/movement.js';
export * from './skills/inventory.js';
export * from './skills/exploration.js';
export * from './skills/zones.js';
// Import inventory functions for internal use by remaining skills.js functions
import { equip, replaceBrokenArmor, safeToss, safeTossBatch, discard, putInChest, takeFromChest, viewChest, giveToPlayer } from './skills/inventory.js';
// Import for internal use by remaining skills.js functions
import { placeBlock, breakBlockAt, pickupNearbyItems, autoBreakStuckPlant } from './skills/blocks.js';
import { goToGoal, goToPosition, goToPlayer, moveAwayFromEntity } from './skills/movement.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;
