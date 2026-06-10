# Skills.js Refactor — Design Spec

**Date:** 2026-06-10  
**Scope:** Split `src/agent/library/skills.js` (5574 lines, ~50 exports) into focused modules, with a Vitest test suite written first to verify correctness at every step without launching a Minecraft server.

---

## Goals

1. Break `skills.js` into 8 domain modules + 1 shared infrastructure file
2. Keep the public API identical — all callers (`actions.js`, `modes.js`, `auto_recovery.js`) continue importing from `../library/skills.js` without changes
3. Write tests before touching source code, so each extraction step is independently verifiable
4. Produce atomic commits readable by a third-party contributor (Jason)

---

## Architecture

### Source structure

```
src/agent/library/
  skills.js              ← barrel: export * from './skills/...' (~10 lines, no logic)
  skills/
    _shared.js           ← createMovements, installSafePathfinderDefaults,
                            _isInAnyProtectedZone, expandBlockFamily, private helpers
    crafting.js          ← craftRecipe, smeltItem, clearNearestFurnace
    combat.js            ← attackNearest, attackEntity, defendSelf
    blocks.js            ← collectBlock, breakBlockAt, placeBlock, pickupNearbyItems, autoBreakStuckPlant
    inventory.js         ← equip, replaceBrokenArmor, safeToss, safeTossBatch,
                            discard, putInChest, takeFromChest, viewChest, giveToPlayer
    movement.js          ← goToPosition, goToNearestBlock, goToNearestEntity, goToPlayer,
                            followPlayer, moveAway, moveAwayFromEntity, avoidEnemies,
                            stay, useDoor, goToBed, goToGoal
    zones.js             ← village detection, player structure watcher/scanner,
                            escapeSpawnZone, escapeProtectedZone, loadPlayerStructures,
                            detectNearbyVillages, startVillageScanner,
                            detectNearbyPlayerStructures, startPlayerStructureScanner,
                            startPlayerStructureWatcher
    exploration.js       ← digDown, digUp, goToSurface, scanForCaverns,
                            placeTorchAt, placeBreadcrumbTorch
    social.js            ← consume, tillAndSow, activateNearestBlock,
                            showVillagerTrades, tradeWithVillager, useToolOn
```

### Test structure

```
tests/
  helpers/
    mock-bot.js          ← createMockBot() factory
  skills/
    contract.test.js     ← all ~42 public exports present + correct type
    crafting.test.js
    combat.test.js
    blocks.test.js
    inventory.test.js
    movement.test.js
    zones.test.js
    exploration.test.js
    social.test.js
```

---

## Test Strategy

### Contract tests (`contract.test.js`)

Written before any source change. Imports `skills.js` and asserts every public export is a function. Acts as the safety net: if an export disappears during extraction, this test fails immediately.

### Unit tests per module

Cover functions testable without a Minecraft server (~60% of exports):

| File | What is tested |
|---|---|
| `zones.test.js` | Zone radius math, `_isInSpawnZone`, `_isInAnyProtectedZone` |
| `blocks.test.js` | `expandBlockFamily` variants, zone check in collectBlock |
| `inventory.test.js` | `_armorTier`, item selection logic |
| `exploration.test.js` | `_rank8DirectionsByDrift`, `_yawToCardinal` |
| `crafting.test.js` | Empty inventory behavior, crafting window mock |

Skills requiring real pathfinding (`goToPosition`, `digDown`, etc.) are covered only by the contract test — navigation is not simulated.

### `createMockBot()` factory (`tests/helpers/mock-bot.js`)

Shared across all unit test files. Configurable via options:

```js
createMockBot({
  position: { x: 0, y: 64, z: 0 },  // default spawn
  health: 20,
  food: 20,
  inventory: [],                      // array of { name, count, type, ... }
  protectedZones: [],                 // Jason's custom zone array
  spawnPoint: { x: 0, z: 0 },
})
```

**Stub values** derived from options: `bot.entity.position`, `bot.inventory.items()`, `bot.heldItem`.

**`vi.fn()` mocks**: `bot.equip`, `bot.dig`, `bot.placeBlock`, `bot.chat`, `bot.pathfinder.goto`, `bot.pathfinder.setMovements`, `bot.collectBlock.collect`, `bot.blockAt`, `bot.findBlock`, `bot.nearestEntity`, `bot.on`, `bot.removeListener`, `bot.emit`.

---

## Tooling

- **Vitest** added as a dev dependency (ESM-native, zero config for `"type": "module"` projects)
- `"test": "vitest run"` script added to `package.json`
- `"test:watch": "vitest"` for live feedback during extraction

---

## Refactor Order

Each step ends with `vitest run` passing, then a commit.

| Step | Action | Commit message |
|---|---|---|
| 0 | Add Vitest, `contract.test.js`, `createMockBot()` | `test: add contract tests and mock-bot factory` |
| 1 | Extract `_shared.js` (createMovements, zone checks, expandBlockFamily) | `refactor: extract shared skill infrastructure` |
| 2 | Extract `crafting.js` + tests | `refactor: extract crafting skills` |
| 3 | Extract `combat.js` + tests | `refactor: extract combat skills` |
| 4 | Extract `social.js` + tests | `refactor: extract social skills` |
| 5 | Extract `inventory.js` + tests | `refactor: extract inventory skills` |
| 6 | Extract `movement.js` + tests | `refactor: extract movement skills` |
| 7 | Extract `blocks.js` + tests | `refactor: extract block skills` |
| 8 | Extract `exploration.js` + tests | `refactor: extract exploration skills` |
| 9 | Extract `zones.js` + tests | `refactor: extract zone/escape skills` |
| 10 | Convert `skills.js` to barrel | `refactor: skills.js is now a pure re-export barrel` |

---

## Constraints

- **Zero breaking changes**: public exports of `skills.js` are identical before and after
- **Atomic commits**: each commit is self-contained and reviewable independently
- **No new runtime dependencies**: Vitest is dev-only
- **Jason-readable**: commit messages are imperative, scope is clear, no noise
