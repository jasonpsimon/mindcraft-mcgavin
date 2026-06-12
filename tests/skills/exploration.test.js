import { describe, it, expect } from 'vitest';
import { digDown, digUp, goToSurface, scanForCaverns, placeTorchAt, placeBreadcrumbTorch } from '../../src/agent/library/skills/exploration.js';
import { _yawToCardinal } from '../../src/agent/library/skills/exploration.js';

describe('_yawToCardinal', () => {
  it('maps 0 to south', () => expect(_yawToCardinal(0)).toBe('south'));
  it('maps Math.PI to north', () => expect(_yawToCardinal(Math.PI)).toBe('north'));
  it('maps -Math.PI/2 to east', () => expect(_yawToCardinal(-Math.PI / 2)).toBe('east'));
  it('maps Math.PI/2 to west', () => expect(_yawToCardinal(Math.PI / 2)).toBe('west'));
});

describe('exploration exports', () => {
  it.each(['digDown', 'digUp', 'goToSurface', 'scanForCaverns', 'placeTorchAt', 'placeBreadcrumbTorch'])(
    'exports %s as a function', (name) => {
      const mod = { digDown, digUp, goToSurface, scanForCaverns, placeTorchAt, placeBreadcrumbTorch };
      expect(typeof mod[name]).toBe('function');
    }
  );
});
