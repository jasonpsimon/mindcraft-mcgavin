import { describe, it, expect, vi } from 'vitest';
import { attackNearest, attackEntity, defendSelf } from '../../src/agent/library/skills/combat.js';
import { createMockBot } from '../helpers/mock-bot.js';

describe('combat exports', () => {
  it.each(['attackNearest', 'attackEntity', 'defendSelf'])('exports %s', (name) => {
    const mod = { attackNearest, attackEntity, defendSelf };
    expect(typeof mod[name]).toBe('function');
  });
});

describe('defendSelf', () => {
  it('returns without crashing when no nearby mobs', async () => {
    const bot = createMockBot();
    bot.entities = {};
    await defendSelf(bot, 9);
    // no throw = pass
  });
});
