import { describe, it, expect } from 'vitest';
import { consume, tillAndSow, activateNearestBlock, showVillagerTrades, tradeWithVillager, useToolOn } from '../../src/agent/library/skills/social.js';

describe('social exports', () => {
  it.each(['consume', 'tillAndSow', 'activateNearestBlock', 'showVillagerTrades', 'tradeWithVillager', 'useToolOn'])(
    'exports %s as a function', (name) => {
      const mod = { consume, tillAndSow, activateNearestBlock, showVillagerTrades, tradeWithVillager, useToolOn };
      expect(typeof mod[name]).toBe('function');
    }
  );
});
