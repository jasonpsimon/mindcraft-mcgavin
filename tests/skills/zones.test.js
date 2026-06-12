import { describe, it, expect } from 'vitest';
import { _isInSpawnZone, _isInAnyProtectedZone } from '../../src/agent/library/skills/_shared.js';
import { loadPlayerStructures, escapeSpawnZone, escapeProtectedZone, detectNearbyVillages, startVillageScanner, detectNearbyPlayerStructures, startPlayerStructureScanner, startPlayerStructureWatcher } from '../../src/agent/library/skills/zones.js';
import { createMockBot } from '../helpers/mock-bot.js';

describe('_isInSpawnZone', () => {
  it('returns true when within spawn radius', () => {
    const bot = createMockBot({ spawnPoint: { x: 0, z: 0 } });
    bot.game = { serverBrand: 'vanilla' };
    expect(_isInSpawnZone(bot, 5, 5)).toBe(true);
  });

  it('returns false when far from spawn', () => {
    const bot = createMockBot({ spawnPoint: { x: 0, z: 0 } });
    bot.game = { serverBrand: 'vanilla' };
    expect(_isInSpawnZone(bot, 5000, 5000)).toBe(false);
  });
});

describe('_isInAnyProtectedZone', () => {
  it('returns falsy with empty zones and position far from spawn', () => {
    const bot = createMockBot({ protectedZones: [], spawnPoint: { x: 0, z: 0 } });
    expect(_isInAnyProtectedZone(bot, 5000, 64, 5000)).toBeFalsy();
  });

  it('returns truthy when inside a protected zone', () => {
    const bot = createMockBot({
      protectedZones: [{ x: 5000, y: 64, z: 5000, radius: 50, yMin: 0, yMax: 200, type: 'village', name: 'test' }],
      spawnPoint: { x: 0, z: 0 },
    });
    expect(_isInAnyProtectedZone(bot, 5010, 64, 5010)).toBeTruthy();
  });

  it('returns falsy when outside all zones', () => {
    const bot = createMockBot({
      protectedZones: [{ x: 5000, y: 64, z: 5000, radius: 50, yMin: 0, yMax: 200, type: 'village', name: 'test' }],
      spawnPoint: { x: 0, z: 0 },
    });
    expect(_isInAnyProtectedZone(bot, 10000, 64, 10000)).toBeFalsy();
  });
});

describe('zones exports', () => {
  it.each(['loadPlayerStructures', 'escapeSpawnZone', 'escapeProtectedZone', 'detectNearbyVillages', 'startVillageScanner', 'detectNearbyPlayerStructures', 'startPlayerStructureScanner', 'startPlayerStructureWatcher'])(
    'exports %s as a function', (name) => {
      const mod = { loadPlayerStructures, escapeSpawnZone, escapeProtectedZone, detectNearbyVillages, startVillageScanner, detectNearbyPlayerStructures, startPlayerStructureScanner, startPlayerStructureWatcher };
      expect(typeof mod[name]).toBe('function');
    }
  );
});
