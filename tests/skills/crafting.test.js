import { describe, it, expect, vi } from 'vitest';
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
