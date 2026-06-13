# Skills.js Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/agent/library/skills.js` (5574 lines, 56 exports) into 8 domain modules + 1 shared infrastructure file, guarded by a Vitest test suite written before touching source code.

**Architecture:** A `skills/` subdirectory holds domain modules; `skills.js` becomes a pure re-export barrel. All external callers continue importing from `../library/skills.js` unchanged. Tests live in `tests/` (separate from `src/`). Contract tests verify all 56 exports survive every step; unit tests cover pure and mockable functions.

**Tech Stack:** Node.js ESM (`"type": "module"`), Vitest (dev-only), `vi.fn()` for mocks, `Vec3` for position stubs.

**Spec:** `docs/superpowers/specs/2026-06-10-skills-refactor-design.md`

---

## File Map

**New source files:**
- `src/agent/library/skills/_shared.js` — `log`, `wait`, `createMovements`, `installSafePathfinderDefaults`, and private helpers used by multiple domains: `expandBlockFamily`, `_isInSpawnZone`, `_isNearProtectedZone`, `_isInAnyProtectedZone`, `_configureTerrainSafeMovements`, `_equipBestToolFor`, `_isUnderground`, `_isDangerous`
- `src/agent/library/skills/crafting.js` — `craftRecipe`, `smeltItem`, `clearNearestFurnace`
- `src/agent/library/skills/combat.js` — `attackNearest`, `attackEntity`, `defendSelf`
- `src/agent/library/skills/social.js` — `consume`, `tillAndSow`, `activateNearestBlock`, `showVillagerTrades`, `tradeWithVillager`, `useToolOn`
- `src/agent/library/skills/blocks.js` — `collectBlock`, `pickupNearbyItems`, `breakBlockAt`, `placeBlock`, `autoBreakStuckPlant`, plus private `useToolOnBlock` (used by `collectBlock`, `placeBlock`, and imported by `social.js`), and private `autoLight` (called from `collectBlock`)
- `src/agent/library/skills/movement.js` — `goToGoal`, `goToPosition`, `goToNearestBlock`, `goToNearestEntity`, `goToPlayer`, `followPlayer`, `moveAway`, `moveAwayFromEntity`, `avoidEnemies`, `stay`, `useDoor`, `goToBed`
- `src/agent/library/skills/inventory.js` — `equip`, `replaceBrokenArmor`, `safeToss`, `safeTossBatch`, `discard`, `putInChest`, `takeFromChest`, `viewChest`, `giveToPlayer` (includes private `_armorTier`, `_sealHole`, `_findSealBlock` — these stay here by encapsulation: they only serve inventory operations and have no reason to be shared)
- `src/agent/library/skills/exploration.js` — `digDown`, `digUp`, `goToSurface`, `scanForCaverns`, `placeTorchAt`, `placeBreadcrumbTorch`
- `src/agent/library/skills/zones.js` — `loadPlayerStructures`, `detectNearbyVillages`, `startVillageScanner`, `detectNearbyPlayerStructures`, `startPlayerStructureScanner`, `startPlayerStructureWatcher`, `escapeSpawnZone`, `escapeProtectedZone`

**New test files:**
- `tests/helpers/mock-bot.js` — `createMockBot()` factory
- `tests/skills/contract.test.js` — all 56 exports present
- `tests/skills/crafting.test.js`
- `tests/skills/combat.test.js`
- `tests/skills/social.test.js`
- `tests/skills/blocks.test.js`
- `tests/skills/movement.test.js`
- `tests/skills/inventory.test.js`
- `tests/skills/exploration.test.js`
- `tests/skills/zones.test.js`

**Modified files:**
- `package.json` — add `vitest` devDependency, `test` and `test:watch` scripts
- `src/agent/library/skills.js` — gains one `export *` line per extracted module, loses the moved functions; becomes a 10-line barrel at Task 13

---

## Extraction pattern (repeated for Tasks 5–12)

Each extraction task follows this exact sequence:
1. Write unit tests importing from the new module path → run → **FAIL** (file doesn't exist yet)
2. Create the module file with functions moved from `skills.js`
3. Run `node --check src/agent/library/skills/<module>.js` → syntax OK
4. Add `export * from './skills/<module>.js'` at the top of `skills.js` and delete the now-duplicated code below
5. Run `npx vitest run` → contract + unit tests **PASS**
6. Commit

---

## Task 1: Vitest setup

**Files:**
- Modify: `package.json`

- [ ] **Add vitest to devDependencies**

```bash
cd mindcraft_mcgavin
npm install --save-dev vitest
```

- [ ] **Add test scripts to package.json**

In the `"scripts"` section, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Verify vitest runs with no test files**

```bash
npx vitest run
```
Expected: `No test files found` or similar — no error, exit 0.

- [ ] **Commit**

```bash
git add package.json package-lock.json
git commit -m "test: add vitest"
```

---

## Task 2: createMockBot factory

**Files:**
- Create: `tests/helpers/mock-bot.js`

- [ ] **Create `tests/helpers/` directory and write the factory**

```bash
mkdir -p tests/helpers
```

Create `tests/helpers/mock-bot.js`:

```js
import { vi } from 'vitest';

export function createMockBot(options = {}) {
  const {
    position = { x: 0, y: 64, z: 0 },
    health = 20,
    food = 20,
    inventory = [],
    protectedZones = [],
    spawnPoint = { x: 0, z: 0 },
  } = options;

  return {
    output: '',
    health,
    food,
    entity: {
      position: { x: position.x, y: position.y, z: position.z },
      yaw: 0,
    },
    game: {
      gameMode: 'survival',
      serverBrand: 'vanilla',
    },
    time: { timeOfDay: 6000 },
    weather: { isRaining: false },
    protectedZones,
    spawnPoint: { x: spawnPoint.x, y: 64, z: spawnPoint.z },
    inventory: {
      items: vi.fn().mockReturnValue(inventory),
      slots: new Array(46).fill(null),
      emptySlotCount: vi.fn().mockReturnValue(36 - inventory.length),
      findInventoryItem: vi.fn().mockReturnValue(null),
    },
    heldItem: inventory[0] || null,
    pathfinder: {
      goto: vi.fn().mockResolvedValue(undefined),
      setMovements: vi.fn(),
      bestHarvestTool: vi.fn().mockReturnValue(null),
      isMoving: vi.fn().mockReturnValue(false),
    },
    collectBlock: {
      collect: vi.fn().mockResolvedValue(undefined),
      movements: null,
    },
    pvp: { attack: vi.fn(), stop: vi.fn() },
    blockAt: vi.fn().mockReturnValue(null),
    findBlock: vi.fn().mockReturnValue(null),
    nearestEntity: vi.fn().mockReturnValue(null),
    equip: vi.fn().mockResolvedValue(undefined),
    unequip: vi.fn().mockResolvedValue(undefined),
    dig: vi.fn().mockResolvedValue(undefined),
    placeBlock: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
    setControlState: vi.fn(),
    clearControlStates: vi.fn(),
    openChest: vi.fn().mockResolvedValue({ window: { slots: [] }, close: vi.fn() }),
    activateBlock: vi.fn().mockResolvedValue(undefined),
    openVillager: vi.fn().mockResolvedValue({ trades: [], close: vi.fn() }),
    look: vi.fn().mockResolvedValue(undefined),
    waitForChunksToLoad: vi.fn().mockResolvedValue(undefined),
    world: { getBlock: vi.fn().mockReturnValue(null) },
  };
}
```

- [ ] **Commit**

```bash
git add tests/helpers/mock-bot.js
git commit -m "test: add createMockBot factory"
```

---

## Task 3: Contract tests

**Files:**
- Create: `tests/skills/contract.test.js`

These tests must pass immediately on the unmodified `skills.js`. They are the safety net for all subsequent steps.

- [ ] **Create `tests/skills/` directory**

```bash
mkdir -p tests/skills
```

- [ ] **Write `tests/skills/contract.test.js`**

```js
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
```

- [ ] **Run the contract tests — must pass on unmodified skills.js**

```bash
npx vitest run tests/skills/contract.test.js
```

Expected: `57 tests passed` (1 length check + 56 function checks).

If any test fails due to import errors from `settings.js` loading config files, add a `tests/helpers/vitest-setup.js`:
```js
// mock settings to avoid file-system reads at import time
import { vi } from 'vitest';
vi.mock('../../src/agent/settings.js', () => ({ default: { max_messages: 30 } }));
```
Then add a top-level `"vitest"` key to `package.json` (sibling of `"scripts"`, not nested inside it):
```json
"vitest": { "setupFiles": ["tests/helpers/vitest-setup.js"] }
```

- [ ] **Commit**

```bash
git add tests/skills/contract.test.js
git commit -m "test: add contract tests for all 56 public exports"
```

---

## Task 4: Extract `_shared.js`

**Files:**
- Create: `src/agent/library/skills/_shared.js`
- Modify: `src/agent/library/skills.js`

This is the only task without unit tests first — `_shared.js` contains infrastructure, not behavior. The contract tests serve as the verification.

- [ ] **Create `src/agent/library/skills/` directory**

```bash
mkdir -p src/agent/library/skills
```

- [ ] **Create `src/agent/library/skills/_shared.js`**

Move these functions from `skills.js` into `_shared.js` with their imports:

Top-of-file imports needed:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
```

Functions to export (public — re-exported by barrel):
- `log` (line 46)
- `wait` (line 204)
- `createMovements` (line 2362, includes `_configureTerrainSafeMovements` at 2318 as private helper)
- `installSafePathfinderDefaults` (line 1747)

Functions to export (used by domain modules, NOT re-exported by barrel):
- `expandBlockFamily` + `BLOCK_FAMILIES` constant (lines 18–44)
- `_isInSpawnZone` (line 1580)
- `_isNearProtectedZone` (line 1619)
- `_isInAnyProtectedZone` (line 1645)
- `_equipBestToolFor` (line 98)
- `_isUnderground` (line 3399)
- `_isDangerous` (line 3433)

All functions must be `export`ed from `_shared.js` so domain modules can import them. They will NOT be re-exported from `skills.js` barrel (named re-exports only for the 4 public ones).

- [ ] **Check syntax**

```bash
node --check src/agent/library/skills/_shared.js
```

Expected: no output (success).

- [ ] **Add import to `skills.js` for the moved helpers**

At the top of `skills.js`, replace the inline definitions of the moved functions with:
```js
import {
  log, wait, createMovements, installSafePathfinderDefaults,
  expandBlockFamily, BLOCK_FAMILIES,
  _isInSpawnZone, _isNearProtectedZone, _isInAnyProtectedZone,
  _equipBestToolFor, _isUnderground, _isDangerous,
} from './skills/_shared.js';
```

Then delete the original function bodies from `skills.js`.

- [ ] **Run contract tests**

```bash
npx vitest run tests/skills/contract.test.js
```

Expected: 57 tests passed.

- [ ] **Commit**

```bash
git add src/agent/library/skills/_shared.js src/agent/library/skills.js
git commit -m "refactor: extract shared skill infrastructure"
```

---

## Task 5: Extract `crafting.js` + tests

**Files:**
- Create: `src/agent/library/skills/crafting.js`
- Create: `tests/skills/crafting.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `craftRecipe` (line 202, impl at 111), `smeltItem` (line 362, impl at 229), `clearNearestFurnace` (line 400, impl at 364).

Imports needed in `crafting.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { withBotLock } from '../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log } from './_shared.js';
// cross-domain: crafting calls these during complex recipes
import { placeBlock, collectBlock } from './blocks.js';
import { goToNearestBlock } from './movement.js';
```

- [ ] **Write `tests/skills/crafting.test.js`** — run → FAIL

```js
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
```

- [ ] **Run tests → FAIL**

```bash
npx vitest run tests/skills/crafting.test.js
```

Expected: `Cannot find module '../../src/agent/library/skills/crafting.js'`

- [ ] **Create `src/agent/library/skills/crafting.js`** — move the three functions from `skills.js`

- [ ] **Check syntax**

```bash
node --check src/agent/library/skills/crafting.js
```

- [ ] **Add re-export to `skills.js`, remove original code**

Add near top of `skills.js`:
```js
export * from './skills/crafting.js';
```
Delete `_impl_craftRecipe`, `craftRecipe`, `_impl_smeltItem`, `smeltItem`, `_impl_clearNearestFurnace`, `clearNearestFurnace` from `skills.js`.

- [ ] **Run all tests**

```bash
npx vitest run
```

Expected: all tests pass (contract + crafting).

- [ ] **Commit**

```bash
git add src/agent/library/skills/crafting.js src/agent/library/skills.js tests/skills/crafting.test.js
git commit -m "refactor: extract crafting skills"
```

---

## Task 6: Extract `combat.js` + tests

**Files:**
- Create: `src/agent/library/skills/combat.js`
- Create: `tests/skills/combat.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `attackNearest` (line 423, impl 403), `attackEntity` (line 460, impl 425), `defendSelf` (line 532, impl 462).
Private helper to move with them: `equipHighestAttack` (line 60, only called from combat functions).

Imports needed in `combat.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import Vec3 from 'vec3';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { withBotLock } from '../bot_mutex.js';
import { log } from './_shared.js';
// cross-domain
import { goToPosition } from './movement.js';
import { pickupNearbyItems } from './blocks.js';
```

- [ ] **Write `tests/skills/combat.test.js`** — run → FAIL

```js
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
```

- [ ] **Run tests → FAIL**, create `combat.js`, check syntax, add `export * from './skills/combat.js'` to `skills.js`, delete moved code.

- [ ] **Run all tests** → pass.

- [ ] **Commit**

```bash
git add src/agent/library/skills/combat.js src/agent/library/skills.js tests/skills/combat.test.js
git commit -m "refactor: extract combat skills"
```

---

## Task 7: Extract `social.js` + tests

**Files:**
- Create: `src/agent/library/skills/social.js`
- Create: `tests/skills/social.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `consume` (3665), `tillAndSow` (4431), `activateNearestBlock` (4456), `showVillagerTrades` (4560), `tradeWithVillager` (4640), `useToolOn` (5511).
Private helpers to move with them: `findAndGoToVillager` (4464), `hasResources` (4642), `stringifyTrades` (4658), `stringifyItem` (4668).

Imports needed in `social.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import Vec3 from 'vec3';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { withBotLock } from '../bot_mutex.js';
import { log, createMovements } from './_shared.js';
// cross-domain
import { useToolOnBlock } from './blocks.js';
import { equip } from './inventory.js';
import { goToGoal } from './movement.js';
```

- [ ] **Write `tests/skills/social.test.js`** — run → FAIL

```js
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
```

- [ ] **Run tests → FAIL**, create `social.js`, check syntax, add `export * from './skills/social.js'` to `skills.js`, delete moved code.

- [ ] **Run all tests** → pass.

- [ ] **Commit**

```bash
git add src/agent/library/skills/social.js src/agent/library/skills.js tests/skills/social.test.js
git commit -m "refactor: extract social skills"
```

---

## Task 8: Extract `blocks.js` + tests

**Files:**
- Create: `src/agent/library/skills/blocks.js`
- Create: `tests/skills/blocks.test.js`
- Modify: `src/agent/library/skills.js`

This is the integration check for `_shared.js` completeness — `blocks.js` is the heaviest consumer of shared helpers.

Functions to move: `collectBlock` (758), `pickupNearbyItems` (791), `breakBlockAt` (866), `placeBlock` (1085), `autoBreakStuckPlant` (2563).

Imports needed in `blocks.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../../utils/inventory_utils.js';
import { withBotLock } from '../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import {
  log, createMovements, expandBlockFamily,
  _isInAnyProtectedZone, _equipBestToolFor,
  _isUnderground, _isDangerous,
} from './_shared.js';
```

- [ ] **Write `tests/skills/blocks.test.js`** — run → FAIL

```js
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
```

- [ ] **Run tests → FAIL**, create `blocks.js`, check syntax, add `export * from './skills/blocks.js'` to `skills.js`, delete moved code.

- [ ] **Run all tests** → pass. If anything from `_shared.js` is missing, this step will fail first — fix `_shared.js` before continuing.

- [ ] **Commit**

```bash
git add src/agent/library/skills/blocks.js src/agent/library/skills.js tests/skills/blocks.test.js
git commit -m "refactor: extract block skills"
```

---

## Task 9: Extract `movement.js` + tests

**Files:**
- Create: `src/agent/library/skills/movement.js`
- Create: `tests/skills/movement.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `goToGoal` (3741), `goToPosition` (3944), `goToNearestBlock` (3999), `goToNearestEntity` (4020), `goToPlayer` (4057), `followPlayer` (4124), `moveAway` (4162), `moveAwayFromEntity` (4178), `avoidEnemies` (4209), `stay` (4234), `useDoor` (4287), `goToBed` (4328).
Private helper: `startDoorInterval` (3824).

Imports needed in `movement.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { withBotLock } from '../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements, _isInAnyProtectedZone } from './_shared.js';
```

- [ ] **Write `tests/skills/movement.test.js`** — run → FAIL

```js
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
```

- [ ] **Run tests → FAIL**, create `movement.js`, check syntax, add re-export, delete moved code, run all tests → pass.

- [ ] **Commit**

```bash
git add src/agent/library/skills/movement.js src/agent/library/skills.js tests/skills/movement.test.js
git commit -m "refactor: extract movement skills"
```

---

## Task 10: Extract `inventory.js` + tests

**Files:**
- Create: `src/agent/library/skills/inventory.js`
- Create: `tests/skills/inventory.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `equip` (1134), `replaceBrokenArmor` (1241), `safeToss` (1403), `safeTossBatch` (1571), `discard` (3533), `putInChest` (3563), `takeFromChest` (3610), `viewChest` (3640), `giveToPlayer` (3739).
Private helpers that stay here (not in `_shared.js` — see File Map note): `_armorTier` (1151), `_sealHole` (3442), `_findSealBlock` (3487).

Imports needed in `inventory.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { getDiscardSuggestions, autoDiscard, markDiscarded } from '../../../utils/inventory_utils.js';
import { withBotLock } from '../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements, _isInAnyProtectedZone, _equipBestToolFor, _isUnderground, _isDangerous } from './_shared.js';
// cross-domain: safeToss/putInChest/takeFromChest/giveToPlayer navigate to locations
import { goToGoal, goToPosition, goToPlayer, moveAwayFromEntity } from './movement.js';
```

- [ ] **Write `tests/skills/inventory.test.js`** — run → FAIL

```js
import { describe, it, expect } from 'vitest';
import { equip, replaceBrokenArmor, safeToss, safeTossBatch, discard, putInChest, takeFromChest, viewChest, giveToPlayer } from '../../src/agent/library/skills/inventory.js';
import { _armorTier } from '../../src/agent/library/skills/inventory.js';

describe('_armorTier', () => {
  it('returns 0 for leather', () => expect(_armorTier('leather_helmet')).toBe(0));
  it('returns 1 for iron', () => expect(_armorTier('iron_chestplate')).toBe(1));
  it('returns 3 for diamond', () => expect(_armorTier('diamond_leggings')).toBe(3));
  it('returns 4 for netherite', () => expect(_armorTier('netherite_boots')).toBe(4));
  it('returns -1 for non-armor', () => expect(_armorTier('stone')).toBe(-1));
});

describe('inventory exports', () => {
  it.each(['equip', 'replaceBrokenArmor', 'safeToss', 'safeTossBatch', 'discard', 'putInChest', 'takeFromChest', 'viewChest', 'giveToPlayer'])(
    'exports %s as a function', (name) => {
      const mod = { equip, replaceBrokenArmor, safeToss, safeTossBatch, discard, putInChest, takeFromChest, viewChest, giveToPlayer };
      expect(typeof mod[name]).toBe('function');
    }
  );
});
```

Note: `_armorTier` must be exported from `inventory.js` for the test to import it (add `export` keyword). It is NOT re-exported from the barrel (not in the PUBLIC_EXPORTS list).

- [ ] **Run tests → FAIL**, create `inventory.js`, check syntax, add re-export, delete moved code, run all tests → pass.

- [ ] **Commit**

```bash
git add src/agent/library/skills/inventory.js src/agent/library/skills.js tests/skills/inventory.test.js
git commit -m "refactor: extract inventory skills"
```

---

## Task 11: Extract `exploration.js` + tests

**Files:**
- Create: `src/agent/library/skills/exploration.js`
- Create: `tests/skills/exploration.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `digDown` (5021), `digUp` (5223), `goToSurface` (5448), `scanForCaverns` (4711), `placeTorchAt` (5267), `placeBreadcrumbTorch` (5377).
Private helpers to move with them: `_yawToCardinal` (4800), `_impl_digDown` (4808), `_impl_digUp` (5024), `_impl_placeTorchAt` (5237), `_impl_placeBreadcrumbTorch` (5292), `_impl_goToSurface` (5379).

**Note:** `autoLight` (line 50) stays in `blocks.js` — it is called from `_impl_collectBlock`, not from exploration. Do not move it here.

**Note:** `_rank8DirectionsByDrift`, `_unitize`, `_findCachedExit`, `_recordEscapeExit`, `_installSpawnEscapeInstrumentation`, `_isTargetPassable`, `_findPassableY`, `_escapeTryPath` all belong to `zones.js` — their only callers are `_impl_escapeSpawnZone` and `_impl_escapeProtectedZone`. They will be moved in Task 12.

Imports needed in `exploration.js`:
```js
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { withBotLock } from '../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements, _isInAnyProtectedZone } from './_shared.js';
```

- [ ] **Write `tests/skills/exploration.test.js`** — run → FAIL

```js
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
```

Note: export `_yawToCardinal` from `exploration.js` for testing. Not re-exported from barrel.

- [ ] **Run tests → FAIL**, create `exploration.js`, check syntax, add re-export, delete moved code, run all tests → pass.

- [ ] **Commit**

```bash
git add src/agent/library/skills/exploration.js src/agent/library/skills.js tests/skills/exploration.test.js
git commit -m "refactor: extract exploration skills"
```

---

## Task 12: Extract `zones.js` + tests

**Files:**
- Create: `src/agent/library/skills/zones.js`
- Create: `tests/skills/zones.test.js`
- Modify: `src/agent/library/skills.js`

Functions to move: `loadPlayerStructures` (1670), `detectNearbyVillages` (1889), `startVillageScanner` (1976), `detectNearbyPlayerStructures` (2162), `startPlayerStructureScanner` (2202), `startPlayerStructureWatcher` (2250), `escapeSpawnZone` (3103), `escapeProtectedZone` (3244).
Private helpers: `_clusterPositions` (1816), `_villageAlreadyRegistered` (1849), `_villageZoneFromCenter` (1863), `_playerBaseAlreadyRegistered` (2130), `_playerBaseZoneFromCenter` (2140), `_commitToDirection` (3252), `_executeStuckManeuver` (3343), `PLAYER_CHARACTERISTIC_BLOCKS` constant.
Also: `_impl_escapeSpawnZone` (3018), `_impl_escapeProtectedZone` (3123).
Escape-path helpers that belong here (all callers are in the two escape impl functions): `_rank8DirectionsByDrift` (2610), `_unitize` (2637), `_findCachedExit` (2644), `_recordEscapeExit` (2663), `_installSpawnEscapeInstrumentation` (2686), `_isTargetPassable` (2947), `_findPassableY` (2968), `_escapeTryPath` (2987).

Imports needed in `zones.js`:
```js
import { readFileSync, existsSync } from 'fs';
import * as mc from "../../../utils/mcdata.js";
import * as world from "../world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../../settings.js";
import { withBotLock } from '../bot_mutex.js';
import { wrapSkill } from '../../../observability/skill_lifecycle.js';
import { log, createMovements, _isInSpawnZone, _isNearProtectedZone, _isInAnyProtectedZone } from './_shared.js';
```

- [ ] **Write `tests/skills/zones.test.js`** — run → FAIL

```js
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
  it('returns false with empty zones', () => {
    const bot = createMockBot({ protectedZones: [] });
    expect(_isInAnyProtectedZone(bot, 0, 64, 0)).toBe(false);
  });

  it('returns true when inside a zone', () => {
    const bot = createMockBot({
      protectedZones: [{ x: 0, y: 64, z: 0, radius: 50, yMin: 0, yMax: 200, type: 'village', name: 'test' }],
    });
    expect(_isInAnyProtectedZone(bot, 10, 64, 10)).toBe(true);
  });

  it('returns false when outside all zones', () => {
    const bot = createMockBot({
      protectedZones: [{ x: 0, y: 64, z: 0, radius: 50, yMin: 0, yMax: 200, type: 'village', name: 'test' }],
    });
    expect(_isInAnyProtectedZone(bot, 1000, 64, 1000)).toBe(false);
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
```

- [ ] **Run tests → FAIL**, create `zones.js`, check syntax, add re-export, delete moved code, run all tests → pass.

- [ ] **Commit**

```bash
git add src/agent/library/skills/zones.js src/agent/library/skills.js tests/skills/zones.test.js
git commit -m "refactor: extract zone/escape skills"
```

---

## Task 13: Convert `skills.js` to barrel

**Files:**
- Modify: `src/agent/library/skills.js`

At this point `skills.js` should contain only `export * from` lines and the import block for `_shared.js` functions. This task converts it to the final clean barrel.

- [ ] **Verify `skills.js` has no remaining function bodies**

On Git Bash / WSL:
```bash
grep -c "^async function\|^function\|^export async function\|^export function\|^const _impl" src/agent/library/skills.js
```

On PowerShell:
```powershell
(Select-String "^async function|^function|^export async function|^export function|^const _impl" src/agent/library/skills.js).Count
```

Expected: `0`

- [ ] **Replace `skills.js` content with the final barrel**

```js
// Public re-exports from shared infrastructure (named — prevents leaking private helpers)
export { log, wait, createMovements, installSafePathfinderDefaults } from './skills/_shared.js';

// Domain modules (export * is safe — these files export only public symbols)
export * from './skills/crafting.js';
export * from './skills/combat.js';
export * from './skills/social.js';
export * from './skills/blocks.js';
export * from './skills/movement.js';
export * from './skills/inventory.js';
export * from './skills/exploration.js';
export * from './skills/zones.js';
```

- [ ] **Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Verify callers still resolve**

```bash
node --check src/agent/agent.js
node --check src/agent/commands/actions.js
node --check src/agent/modes.js
node --check src/agent/auto_recovery.js
```

Expected: no output (all clean).

- [ ] **Commit**

```bash
git add src/agent/library/skills.js
git commit -m "refactor: skills.js is now a pure re-export barrel"
```

---

## Final verification

- [ ] **Run full test suite one last time**

```bash
npx vitest run --reporter=verbose
```

Expected: all 57+ tests pass, zero failures.

- [ ] **Check skills.js line count**

On Git Bash / WSL:
```bash
wc -l src/agent/library/skills.js
```

On PowerShell:
```powershell
(Get-Content src/agent/library/skills.js).Count
```

Expected: ~10 lines.
