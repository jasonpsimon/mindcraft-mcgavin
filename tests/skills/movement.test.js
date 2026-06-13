import { describe, it, expect } from 'vitest';
import { goToPosition, goToPlayer, followPlayer, moveAway, moveAwayFromEntity, avoidEnemies, stay, useDoor, goToBed, goToGoal, goToNearestBlock, goToNearestEntity } from '../../src/agent/library/skills/movement.js';

describe('movement exports', () => {
  it.each([
    'goToPosition', 'goToPlayer', 'followPlayer', 'moveAway', 'moveAwayFromEntity',
    'avoidEnemies', 'stay', 'useDoor', 'goToBed', 'goToGoal', 'goToNearestBlock', 'goToNearestEntity',
  ])('exports %s as a function', (name) => {
    const mod = { goToPosition, goToPlayer, followPlayer, moveAway, moveAwayFromEntity, avoidEnemies, stay, useDoor, goToBed, goToGoal, goToNearestBlock, goToNearestEntity };
    expect(typeof mod[name]).toBe('function');
  });
});
