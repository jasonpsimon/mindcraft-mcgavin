import { describe, it, expect, vi } from 'vitest';
import { expandBlockFamily } from '../../src/agent/library/skills/_shared.js';
import { collectBlock, breakBlockAt, placeBlock, pickupNearbyItems, autoBreakStuckPlant } from '../../src/agent/library/skills/blocks.js';
import { createMockBot } from '../helpers/mock-bot.js';

describe('expandBlockFamily', () => {
  it('returns array with requested type first', () => {
    const result = expandBlockFamily('oak_log');
    expect(result[0]).toBe('oak_log');
    expect(result.length).toBeGreaterThan(1);
  });

  it('includes all log variants for any log type', () => {
    const result = expandBlockFamily('spruce_log');
    expect(result).toContain('oak_log');
    expect(result).toContain('birch_log');
  });

  it('returns single-element array for unknown type', () => {
    const result = expandBlockFamily('stone');
    expect(result).toEqual(['stone']);
  });
});

describe('blocks exports', () => {
  it.each(['collectBlock', 'breakBlockAt', 'placeBlock', 'pickupNearbyItems', 'autoBreakStuckPlant'])(
    'exports %s as a function', (name) => {
      const mod = { collectBlock, breakBlockAt, placeBlock, pickupNearbyItems, autoBreakStuckPlant };
      expect(typeof mod[name]).toBe('function');
    }
  );
});
