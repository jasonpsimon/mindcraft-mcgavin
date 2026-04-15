# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-15 (Bug B fully resolved via #10 survival hardening — bot escapes spawn zone in 1 hop, 0 deaths)_

---

## Current state (live on develop)

- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b-it` via LM Studio.
- Branch: `develop` — HEAD `4def1fa`. All fixes merged + pushed to GitHub.
- Bot settings: `minecraft_version: "1.21.4"` (translates through ViaBackwards 5.0.4 installed on server) and default host/port.
- Stability: ViaBackwards holding (0 disconnects across multi-hour windows). Mutex balanced. Survival hardening shipped (maxDropDown=3, autoEat startAt=19).
- Bug B resolved 2026-04-15: bot escaped spawn zone in 1 hop (226 → 265 blocks) with 0 deaths after combined fix landed.
- Next priority: **#4 Wrong tool for the block** — biggest remaining performance gain. Bot mines stone with bare hands which is ~7× slower than with a pickaxe and drops nothing in many cases.

---

## In-progress

_Nothing active — last cycle resolved Bug B via #10 survival hardening. Pick next item from the to-do queue._

---

## Newly found bugs (overnight audit 2026-04-15)

### Bug A: `AutoBreakPlant` breaks `grass_block` terrain — ✅ fixed 2026-04-15 (`ec75860`)

**Severity:** critical — actively destroying player's spawn-area terrain.

`PLANT_LIKE_PATTERN` regex matched "grass" which also matched `grass_block` (the solid dirt-with-grass-top cube, NOT the plant `short_grass`). Bot destroyed at least 3 grass_block tiles inside the spawn zone during escape attempts. Would also match `moss_block`, `rooted_dirt` in the wild.

**Fix deployed:**
1. Tightened regex: `grass` → `(^|_)grass$` (matches `short_grass`, `tall_grass`, but not `grass_block`). Also removed bare `moss` and `fungus` from the pattern.
2. Hard exclusion list `SOLID_GROUND_BLOCKS` covering `grass_block`, `moss_block`, `mycelium`, `podzol`, `rooted_dirt`, `dirt_path`, `farmland`. Checked before any pattern matching.

**Verified:** post-deploy, bot now only breaks `vine` and `short_grass` inside spawn. No `grass_block` events.

### Bug B: Escape loop plateau at ~130 blocks from spawn — ✅ resolved 2026-04-15 (`ad3874d` + `4def1fa`)

**Severity:** medium — bot gameplay stalls when respawn lands it back inside the zone after first escape.

Over 7h 47m initial observation: **39 escape attempts, 0 successful.** Bot oscillated at positions (40-52, -135 to -139). Instrumentation 2026-04-15 (`a4981b0`) revealed the root cause: bot was reaching the boundary, **dying to fall damage**, respawning at world spawn, and starting over — not actually plateauing in the escape logic itself.

**Fix shipped (combined):**

1. **Escape rewrite** (`ad3874d`): commit-to-direction with 8 cardinals + diagonals, 40-block hops, sidestep maneuver (back 3 + alternate left/right). Plus persistent `bot.escapeMemory` — successful exits cached per spawn coord, tried first on next escape.
2. **Survival hardening** (`4def1fa`, see #10): `pf.Movements.maxDropDown = 3` (vanilla no-damage limit) + `autoEat.startAt: 19` (continuous health regen). Pathfinder no longer chooses lethal cliff drops.
3. **Bug A fix** (`ec75860`): `grass_block` no longer destroyed by autoBreakStuckPlant.
4. **Bug C fix** (`ec75860`): per-block 30s blacklist after dig failures.

**Verified 2026-04-15:** post-deploy, bot escaped spawn zone in **1 hop**: 226.6 → 265.2 blocks from spawn via +X-Z direction. 0 deaths, 0 fall damage events. The escape exit was recorded to `bot.escapeMemory` for future use.

### Bug C: `autoBreakStuckPlant` retries same block that threw `Digging aborted` — ✅ fixed 2026-04-15 (`ec75860`)

**Severity:** medium — wastes escape attempts, clutters log, slight concurrency-race signature.

Three consecutive log entries: `Failed to break large_fern: Digging aborted` — all on the same block. `Digging aborted` is the classic pathfinder/dig interrupt-race signature, which can still happen when an `interrupts:['all']` mode (self_defense / cowardice / hurt) fires during the break and preempts the mutex.

**Fix deployed:** per-bot in-memory blacklist (`bot._autoBreakBlacklist` — `Map<"x,y,z", expiryTime>`). When a dig throws, the block's position is blacklisted for 30 seconds. On the next invocation, blacklisted positions are skipped — the helper tries a different adjacent plant instead. Entries self-prune on subsequent calls.

**Verified:** deployed and running; blacklist has not fired yet because no new `Digging aborted` events occurred in the post-deploy window. Logic will exercise naturally when the next race happens.

---



---

## 0. Spawn-zone auto-escape (bot self-rescue)

**Status:** ✅ **first successful end-to-end escapes observed 2026-04-14.** Bot reached 253 and 300 blocks from spawn across separate runs, crossing the 250-block boundary. Code on `fix/spawn-zone-escape` (HEAD `d051ab1`). Further tuning may still help (e.g., shorter per-direction timeout) but core functionality works. • **Priority:** mostly resolved; remaining quality polish deferred.

**Observed 2026-04-14:** Bot is at `(-26, 85, -44)` — ~51 blocks from spawn, deep inside its own spawn protection zone. Every `!digDown` is blocked by `_isInSpawnZone` and returns `Cannot break blocks near spawn`. The LLM responds to the failure by chat-updating its own memory ("Must move out from spawn limit") — but it's not mechanically smart enough to actually path out. It just issues `!digDown(20)` again. Result: infinite loop of blocked-dig + `mode:unstuck` shuffling the bot 3-5 blocks laterally. **The bot cannot progress until it is rescued or rescues itself.**

**Radius decisions:** protection zone shrunk to **250 blocks** (was 350). Bot's escape target is **350 blocks from spawn** — 100-block buffer past the boundary so tiny movements don't push it back inside.

This is a perfect case study for item #6 (reduce LLM reliance): a 4B model can't derive "I need to walk 350 blocks north before digging" from "digging is blocked." That reasoning must be programmatic.

**Expected behavior:**
**Proactive, on every spawn.** Before the self-prompter loop starts (before the LLM gets a chance to issue any command), the bot checks if it's inside the spawn protection zone. If yes, it pathfinds out to a point just beyond the boundary. Only after the bot is clear of the zone does normal gameplay begin. The LLM should never encounter spawn-zone blocks under normal conditions.

**Fix sketch:**
1. New skill `escapeSpawnZone(bot, buffer=10)` in `src/agent/library/skills.js`:
   - Compute vector from `bot.spawnPoint` → `bot.entity.position`.
   - Scale to `SPAWN_PROTECTION_RADIUS + buffer` (360 blocks) from spawn in the same direction.
   - If bot is AT spawn (dist ≈ 0), pick a cardinal direction (default +X).
   - Wrap in `withBotLock('escapeSpawnZone', ...)` + save/restore movements.
   - Call `goToGoal(bot, new pf.goals.GoalNear(target_x, current_y, target_z, 2))`.
   - Chat: `I'm inside the spawn protection zone. Walking to (X, Z) to escape.`
2. Hook into the bot's spawn event in `src/agent/agent.js` (or wherever spawn is handled) — **before** the self-prompter loop starts:
   - `await skills.escapeSpawnZone(bot)` if `_isInSpawnZone(bot, pos.x, pos.z)`.
   - Block self-prompter startup until the escape completes or fails.
3. Safety net (secondary): keep a lightweight AutoRecovery pattern for the rare case where the bot somehow ends up back inside the zone mid-session (e.g., respawn after death, teleport). Match on `/near spawn|inside .* spawn zone|spawn protection/i` → call `escapeSpawnZone`.

**Why proactive > reactive:**
- No failed-command → retry-with-escape dance; the LLM never sees spawn-zone blocks under normal conditions.
- Clear separation: "escape phase" then "normal gameplay phase."
- Works from a cold start and from every respawn — the bot always leaves the zone before doing anything else.

**Signals to watch after fix:**
- `[SpawnEscape] Auto-escaping from (…) to (…)` appears on every spawn.
- Bot position delta >> 300 blocks within seconds of spawn.
- `!digDown` completes successfully — no more `Blocked break` spam.
- `SpawnProtect` Blocked messages drop to zero during normal play.

---

## 1. `PartialReadError` reconnect storms — ✅ resolved 2026-04-14

**Status:** resolved via ViaBackwards 5.0.4 on server + `minecraft_version=1.21.4` on bot • **Priority:** was high, now done

**Resolution summary:**
- Root cause: mineflayer 4.37 (latest) does not support MC 1.21.0 base — it supports 1.21.1, 1.21.3-6, 1.21.8-9, 1.21.11. Server runs Fabric 1.21.0. Mineflayer was decoding 1.21.1 SlotComponent packets against a 1.21.0 server → repeated `PartialReadError` → reconnects.
- Fix: installed `ViaBackwards-5.0.4.jar` in the server's `mods/` folder (companion to existing ViaFabric 0.4.14+73 which bundles ViaVersion 5.0.0). Bot pinned to `minecraft_version: "1.21.4"` (protocol 769). ViaBackwards translates 769 → 767 on the server.
- Verification (post-deploy 2026-04-14 ~21:38): 7+ min uptime, **0 reconnects** (was ~4/hr), **2 total PartialReadErrors** both during initial inventory sync.
- Commit: `70d1446` on `fix/spawn-zone-escape`.

**Operational note:** if the server gets a MC version upgrade in the future (e.g., to 1.21.1+), this workaround becomes unnecessary — set `minecraft_version` back to `"auto"` and the raw protocol should work. ViaBackwards can be removed or kept (harmless).

Over a 3-hour stability window on 2026-04-14, the bot **reconnected 13 times** due to `PartialReadError` on `SlotComponent` parsing. Every reconnect interrupts whatever the bot was doing (usually `!digDown`), wipes in-memory state, and restarts. Only 1 in 4 commands survives to completion. Gameplay throughput is tiny.

Demoted from blocker to high-priority after the spawn-zone trap was identified as the primary gameplay blocker. Still critical because it prevents validation of fixes for items 0 and 2–6 — a bot that disconnects every 15 minutes never stays up long enough to exercise disposal, item pickup, tool selection, or anything else.

**Root cause:** Protocol drift between mineflayer (`^4.33.0`) and the Minecraft server (`1.21` base). Slot-component packet format changed in 1.20.5+. Supported mineflayer versions per startup log: up through `1.21.11`. Server is below that.

**Fix paths (pick one):**
- **Bump mineflayer / prismarine-protocol** to the latest that supports `1.21` base cleanly. Check `package.json` and `npm outdated`; mineflayer 4.34.0+ may cover it. Lowest-risk.
- **Pin the MC server to a patch version mineflayer supports** (e.g. 1.21.1, 1.21.3, 1.21.4). Requires server-side change; may affect world compat.
- **Patch protodef locally** to tolerate undefined `readBool` on unknown slot components (works but masks the drift).

Try option 1 first. If it doesn't hold, option 2.

**Signals to watch after fix:**
- `grep -c PartialReadError` on tmux buffer → target 0
- `ThatCoolGuyDude spawned` events per hour → target 1 (initial only)
- No mid-task disconnects during `!digDown` or `!collectBlocks`

---

## 2. Bot swim capabilities

**Status:** not started • **Priority:** high (navigation blocker in aquatic biomes)

The bot currently doesn't know how to swim. When its path takes it into water deeper than its head, it either gets stuck or drowns. This blocks travel across rivers, oceans, swamps (see #3), and anything with surface water.

**Expected behavior:**
- Detect when bot is in water (`bot.entity.isInWater`, block-at-head = water).
- While in water: jump to stay at the surface (`setControlState('jump', true)` with periodic release), face the direction of travel, swim forward.
- Detect deeper water and switch to **swim-down** mode if destination requires it (control state `sneak` submerges; otherwise head stays at surface).
- Auto-equip underwater-breathing gear (turtle shell helmet, potion of water breathing) if in inventory.
- Exit water cleanly when destination reached — path to nearest shore block.

**Fix sketch:**
New skill `swim(bot, targetPos)` in `src/agent/library/skills.js` that wraps `setControlState` sequences for aquatic movement. Integrate with `goToGoal` so pathfinder paths-through-water trigger swim mode automatically:
- On each `goToGoal` step, check if the bot's head is in water.
- If yes, activate swim: hold `jump`, forward toward the next path node, release `jump` periodically to let the bot breathe.
- On exit, release all control states.

Configure `pf.Movements` to include `water` as traversable (it likely already does; may need `canSwim = true`).

**Signals to watch after fix:**
- Bot successfully crosses rivers without drowning.
- `bot.health` / `bot.food` not dropping from in-water suffocation.
- No "stuck" mode firing while swimming.

---

## 3. Swamp biome traversal

**Status:** 🟡 **partially shipped 2026-04-14** — extended hazard routing + `autoBreakStuckPlant` helper with plant-vs-tree split and leaves allowance. Remaining: water-traversal (blocked by #2), lily_pad-as-walkable-surface, in-swamp biome detection for smart movement configs. • **Priority:** high (partially done)

**Observed:** during spawn-zone escape, bot got stuck trying to walk through a swamp bush. Swamp biomes combine terrain hazards that the default pathfinder handles poorly: shallow water pockets, lily pads, mangrove roots, tall grass, bushes, vines. Pathfinder treats bushes as solid (stops), water as unswimmable without #2, lily pads as walkable floor (then bot falls through).

**Expected behavior:**
Programmatic adjustments to pathfinder movement rules when the bot is in a swamp biome:
- Treat `dead_bush`, `fern`, `tall_grass`, `large_fern`, `sugar_cane`, `cobweb` as walk-through (break if necessary — costs ~0 time).
- Treat `lily_pad` as walkable surface (path on top without falling through).
- Treat shallow water (≤1 block deep) as walkable if floor is solid.
- Treat deep water as swimmable (depends on #2).
- Treat `mangrove_roots` and `mangrove_propagule` as breakable-for-passage.

**Shipped 2026-04-14 (commits `bbf4ea1`, `ee0168e`, `f001d80`, `d051ab1`):**
1. ✅ `_configureTerrainSafeMovements` now adds `pointed_dripstone`, `cactus`, `wither_rose`, `magma_block`, `soul_fire`, `powder_snow` to `blocksToAvoid` (on top of existing `sweet_berry_bush`). Applied to both non-destructive and destructive `Movements` in `goToGoal`.
2. ✅ `autoBreakStuckPlant(bot)` helper: scans 16 adjacent positions (cardinal + diagonal, feet + head) for plant-matching block names, breaks the first match.
3. ✅ Wired into `goToGoal` as a one-shot retry when pathfinder throws a stuck error.
4. ✅ Wired into `escapeSpawnZone` as a fallback when a direction attempt makes <5 blocks progress.
5. ✅ Plant-vs-tree split for spawn-zone nuance: `PLANT_LIKE_PATTERN` (breakable in spawn) vs `TREE_PART_PATTERN` (protected in spawn). Leaves classified as plant per JP 2026-04-14.

**Still pending:**
- Water-traversal in shallow swamp pockets (depends on #2).
- `lily_pad` treated as walkable surface (mineflayer-pathfinder doesn't natively support "stand on this partial collision block" — may need custom handling).
- In-swamp biome detection to activate more aggressive movement configs dynamically. Current implementation is biome-agnostic (applies everywhere), which is fine but less targeted.

This item and #2 share terrain-awareness logic — consider a single "terrain profiles" abstraction once #2 lands.

**Signals to watch after full fix:**
- ✅ Bot escape from spawn zone completes even when path crosses swamp. (Validated 2026-04-14: bot reached 253 and 300 blocks from spawn.)
- No "stuck" mode firing on dead_bush, lily_pad, or tall_grass.
- `SpawnEscape Arrived` log line appears consistently within ~2 minutes of spawn.

---

## 4. Wrong tool for the block

**Status:** not started • **Priority:** high

The bot frequently digs without equipping the right tool. Mineflayer dig times are ~7× slower with the wrong tool, and many blocks drop nothing when hand-dug. This is almost certainly contributing to the `collectBlocks` pathfind timeouts we see in the log.

**Expected behavior:**
- Stone, ore, deepslate → pickaxe (best tier available)
- Wood, planks, logs → axe
- Dirt, sand, gravel, clay → shovel
- Cobwebs, mobs → sword

**Fix sketch:**
Every `bot.dig(block)` and `bot.attack(entity)` callsite in `src/agent/library/skills.js` should be preceded by a tool-equip helper. Mineflayer has `block.harvestTools` and we can use `bot.pathfinder.bestHarvestTool(block)` or write our own selector that checks `bot.inventory.items()` for matching material + prefers higher tier (netherite > diamond > iron > stone > wood).

Add a single helper `_equipBestTool(bot, block_or_entity)` and call it before every dig/attack. Wrap in the same `withBotLock` reentrant context so it doesn't race.

---

## 5. No torches when dark

**Status:** not started • **Priority:** medium

The `torch_placing` mode exists in `src/agent/modes.js` (~line 222) but either isn't firing or has the wrong trigger. Bot routinely operates in pitch black.

**Expected behavior:**
Mimic real human gameplay — if `bot.time.timeOfDay` indicates night OR the bot is in a dark area (light level < ~7), place or hold a torch.

**Fix sketch:**
1. Inspect current `torch_placing` mode trigger conditions; they probably only fire when "no torches nearby" without checking actual darkness.
2. Extend trigger to: `(light_level < 7 OR is_night) AND has_torch_in_inventory AND not_in_spawn_zone`.
3. Optionally equip torch in off-hand (`bot.equip(torch, 'off-hand')`) while active so monsters are deterred during movement.

---

## 6. Strategic torch placement underground (left-wall convention)

**Status:** not started • **Priority:** medium

When `digDown` is running, place torches on the bot's LEFT wall every N blocks. Convention: RIGHT side going back up = way to surface. Matches standard Minecraft speedrunner / player practice.

**Expected behavior:**
- Every 6-8 blocks of descent, place a torch on the bot's left wall.
- Record facing direction at start of dig so "left" stays consistent.
- On ascent, follow right-side torches back to surface.

**Fix sketch:**
Inside `digDown()` in `skills.js`, after each N-th step:
```js
if (descended % 8 === 0 && has_torch) {
    const leftFace = rotateYaw90CCW(dirName);  // left of current facing
    const leftWallPos = currentPos.offset(leftFace.dx, 1, leftFace.dz);  // head height
    await placeBlock(bot, 'torch', leftWallPos.x, leftWallPos.y, leftWallPos.z, 'side');
}
```
Also extend `goToSurface()` to prefer paths that pass known torch positions (could store placement log in bot memory).

---

## 7. Respect player-built structures (50-block no-disturb radius)

**Status:** not started • **Priority:** medium (protective feature, no active blocker)

The bot must not disturb player-built structures. No breaking, placing, digging, tossing items, or otherwise modifying blocks within **50 blocks of any player-built structure**. Treat player structures as sacrosanct — including buildings, walls, farms, redstone contraptions, and decorative builds.

**Expected behavior:**
- Maintain a registry of known structure centroids (configured manually or detected automatically via heuristics — dense clusters of placed blocks near a player's activity).
- Before every `breakBlockAt`, `placeBlock`, and SafeToss dig, check if the target position is within 50 blocks (XZ + Y) of any registered structure. If yes, block the action with a clear error message (pattern-matchable by AutoRecovery, similar to spawn-zone check).
- Natural block-gathering is still allowed outside the 50-block radius.
- Chat message when the bot respects the boundary so the player sees it happening.

**Fix sketch:**
1. New config file or in-world registry `player_structures.json` — list of `{name, x, y, z, radius}` entries. Start manually curated, add auto-detection later.
2. New helper `_isNearPlayerStructure(bot, x, y, z)` in `skills.js` — checks distance to every registered structure (similar shape to `_isInSpawnZone`).
3. Add check inline in `breakBlockAt`, `placeBlock`, and SafeToss underground dig branch. On violation, `return false` with a `"near player structure"` error — matchable by AutoRecovery if needed.
4. **Reuses spawn-zone infrastructure:** this is conceptually the same feature as #0 but for multiple zones. Worth factoring out a `ProtectedZone` abstraction once #0 is fully stable — one `_isInAnyProtectedZone(x, y, z)` gate handles spawn + all player structures.

**Auto-detection (later):** watch for sequences of `placeBlock` events from the player, cluster by proximity + time, promote to a protected structure automatically after N placements. Defer to a follow-up item.

**Signals to watch after fix:**
- Bot attempting to dig/place near a player structure sees `[StructureProtect] Blocked` log + chat message.
- No player-built blocks damaged or altered.
- Natural resources outside the 50-block radius remain accessible.

---

## 7a. Replant tree saplings after chopping

**Status:** not started • **Priority:** medium (world-stewardship behavior)

When the bot chops down a tree, it should plant a matching sapling at the base block to keep the world ecosystem renewable. Right now the bot just takes wood and moves on, leaving bare dirt where forests used to be.

**Expected behavior:**
- After successfully breaking the lowest log of a tree (the "stump" position), check inventory for a matching sapling.
- If a sapling is available, plant it on top of the dirt/grass block where the stump was.
- If no matching sapling, opportunistically replant whichever sapling type the bot currently has the most of.
- Skip in spawn zone (existing protection rules apply) and inside player-structure radius (#7).

**Fix sketch:**
1. In `skills.js collectBlock` (or wherever `bot.dig` of a `*_log` block happens), detect when the broken block is a tree log AND it's the lowest log in its column (block below = dirt/grass/podzol).
2. Map the log type → sapling type:
   ```
   oak_log → oak_sapling, birch_log → birch_sapling, etc.
   mangrove_log → mangrove_propagule (special case)
   bamboo_block → bamboo (special case)
   ```
3. After break completes, briefly defer (200ms) so the log drops settle, then check inventory for the matching sapling. If present, call `placeBlock(bot, sapling_name, x, y, z, 'top')` on the now-bare ground.
4. Wrap in try/catch — sapling placement failures are non-fatal, just log.

**Signals after fix:**
- Trees the bot chops have saplings at their stump positions within seconds.
- `[Replant] Planted oak_sapling at (...)` log entries.
- Forests don't degrade as the bot harvests them.

---

## 7b. Self-cleanup of incidental block placements

**Status:** not started • **Priority:** medium (world-stewardship behavior)

JP observed the bot placing vertical/horizontal columns of resource blocks (cobblestone, dirt, etc.) for unclear reasons — possibly pathfinder scaffolding / tower-up moves, possibly LLM confusion. These leave clutter. Bot should track its own placements and clean them up when the original purpose is gone.

**Expected behavior:**
- Track every block the bot places via `bot.placedBlocks = [{x, y, z, type, placedAt, purpose}]` (similar to existing `bot.placedTorches`).
- Categorize by purpose:
  - `'pathfinder-scaffold'` (pillar to climb up) — remove after bot has moved >5 blocks past
  - `'spawn-block'` (interim shelter / cover) — remove after the danger passes
  - `'unknown-llm'` (LLM placed without obvious intent) — remove after a configurable cooldown (e.g., 5 min idle)
- **Exclusions** (never auto-remove):
  - Torches (placed deliberately, navigation aid)
  - Crafting table, furnace, chest (functional placements)
  - Anything the LLM explicitly placed via `!placeBlock` with intent (track via context)
  - Anything inside spawn zone (protection rules)
  - Anything inside player-structure radius (#7)

**Fix sketch:**
1. Hook into `placeBlock` in `skills.js` — after a successful placement, push to `bot.placedBlocks` with inferred purpose:
   - Called from pathfinder internals (mineflayer-pathfinder's place-and-climb): `'pathfinder-scaffold'`
   - Called from `safeToss._sealHole` / surface-hole sealing: `'spawn-block'`
   - Called from explicit LLM `!placeBlock` command: `'intentional'` (skip cleanup)
2. New mode `cleanup_blocks` in `modes.js` (low priority, fires when idle):
   - Walk through `bot.placedBlocks`; for each `'pathfinder-scaffold'` or `'spawn-block'` entry where the bot is now >5 blocks away AND the block still exists at the recorded position, attempt to break it.
   - Remove from list after break (success or block-already-gone).
3. Cap list size (e.g., 200 entries, FIFO).
4. Clear list on bot death/respawn (positions become stale).

**Signals after fix:**
- `[Cleanup] Removed pathfinder-scaffold cobblestone at (...)` log entries.
- Bot's wake doesn't accumulate unexplained pillars.

---

## 8. Humanized action delays

**Status:** not started • **Priority:** low-medium

Bot currently acts as fast as LLM + mineflayer allows, which looks robotic and could trigger anti-cheat on some servers. Add variable delay between commands to mimic human thinking.

**Expected behavior:**
- Base delay: 3 seconds between commands
- Scale by complexity:
  - Trivial (chat, help, lookup): 1-2s
  - Movement (goToPlayer, moveAway): 2-3s
  - Resource gathering (collectBlocks, searchForBlock): 3-5s
  - Crafting (craftRecipe, smeltItem): 3-5s
  - Complex (digDown, tillAndSow, tradeWithVillager): 4-6s
- Add ±1000ms jitter so delays don't look scripted.

**Fix sketch:**
In `Agent.handleMessage` in `src/agent/agent.js` — after a command completes and before the next LLM prompt, insert:
```js
const delay = getHumanDelay(command_name);  // returns ms based on command category
await new Promise(r => setTimeout(r, delay));
```
New file `src/agent/human_delays.js` with a command→delay-range map. Keep it config-driven (in `settings.js` so it's easy to tune or disable).

Don't apply delays to mode-triggered actions (self_preservation, self_defense) — those should still react instantly.

---

## 9. Reduce LLM reliance through programmatic enhancements

**Status:** not started • **Priority:** ongoing architectural theme

The small LLM (gemma-4-e4b-it, ~4B params) struggles with routine decisions, consistent multi-step planning, and mechanical choices like tool selection, pathing preferences, and inventory management. Rather than upgrading to a larger model, invest in robust programming around the LLM.

**Principle:** Let the LLM do what it's good at — open-ended goal-setting, natural-language chat, high-level strategy, ambiguity resolution. Program everything else — mechanical rules, state transitions, routine sub-goals, pattern-matched responses.

**Goal:** reduce, not eliminate, LLM reliance. Every LLM call saved is speed + reliability + lower API / inference cost.

**Candidate areas (non-exhaustive — grow this list as we work):**

- **Goal state machine.** Formalize common goals (gather_wood → craft_basic_tools → mine_stone → upgrade_tools → mine_iron → …) as a deterministic state graph. LLM only picks the starting goal or pivots on exceptions; the state machine drives sub-steps without asking.
- **Routine sub-tasks as scripted behaviors.** "Mine N of X ore" → find nearest, equip correct tool, path, dig, collect drops, repeat. Currently the LLM has to choose each action; this should be a single high-level command.
- **Tool selection (see #1).** Never ask LLM what tool to use — always programmatically select.
- **Inventory management.** Already partially done via AutoRecovery + goal-aware discard. Extend: auto-sort (stackable first, tools last slot), auto-empty into chest when near one, auto-pick-up when inventory has room.
- **Pathing preferences.** Prefer destructive movements only when non-destructive fails (already done in `goToGoal`). Extend: prefer paths through known-safe terrain, avoid known-lava areas (memory of prior deaths).
- **Food/sleep loop.** Auto-eat when hunger < threshold, auto-sleep when night and safe. No LLM involvement.
- **Combat reflexes.** `self_defense` mode exists but relies on LLM for weapon choice. Program it: equip highest-DPS weapon, strafe, block with shield if available.
- **Crafting plans.** Already have `getCraftingPlan`. Extend: auto-execute the plan when prerequisites are met, without LLM re-confirmation.
- **Auto-craft basic-need items when supplies run low.** Specifically:
  - **Torches:** when `bot.inventory` has `coal` (or `charcoal`) + `stick` and zero/low torches, auto-craft a stack. Unblocks items #5/#6 (torch placement in darkness / on digDown) which currently silent-skip whenever the bot hasn't naturally gathered torches yet.
  - **Sticks:** when bot has `oak_planks` + low stick count.
  - **Tools:** pickaxe/axe/shovel/sword of the best tier the bot's inventory can support (ties into #4 wrong-tool selection).
  - Trigger on a cadence (every N seconds if idle) and gate on inventory-space availability. No LLM involvement — these are pure mechanical decisions.
  - _(Surfaced 2026-04-14: bot had no torches to place despite #5/#6 trigger conditions firing correctly; root cause was bot hadn't crafted any. Auto-craft would have closed the loop.)_
- **Pattern-matched chat responses.** Common greetings, acknowledgments, status queries → canned responses. Only escalate to LLM for unusual input.

**Fix sketch:**
Not a single fix — a design principle that should be applied incrementally. Every time we catch the LLM being asked to make a routine/mechanical decision, convert it to code. Track wins here as we make them.

Starting points: items #1 (tool selection), #3 (torch placement) are already in this spirit. Continue from there.

---

## 10. Bot survival hardening (don't die avoidably)

**Status:** 🟡 partially shipped 2026-04-15 (fall prevention + auto-eat threshold). First two pieces validated: bot escaped spawn zone in 1 hop with 0 fall deaths post-deploy. Lava/mob/dimension safety still pending. • **Priority:** high (every avoidable death is a respawn-loop)

The bot keeps dying to easily-preventable causes — fall damage from pathfinder choosing risky drops, hunger-related health decay, mob ambushes — which respawns it at world spawn and resets its progress (this was the "mysterious teleport-back" we tracked in Bug B). Need a pattern of programmatic safety habits rather than relying on the LLM to remember.

**Shipped 2026-04-15:**

1. ✅ **Fall prevention.** `pf.Movements.maxDropDown` set to **3** (vanilla Minecraft no-damage limit, was default 4) on both non-destructive and destructive movements in `goToGoal`. Pathfinder will no longer choose paths with >3-block drops.
2. ✅ **Proactive eating for health regen.** `bot.autoEat.options.startAt` bumped from **14 → 19**. Bot now eats whenever hunger < 19 (i.e., almost always), keeping hunger at 18+ so health regenerates continuously between hits. Was firing too late (after the bot was already injured AND hungry — too late to prevent fall-damage death).

**Still pending (future work):**

- **Lava avoidance.** Add `lava` and `magma_block` (already added) to a strict avoid list with high cost penalty. Detect `bot.entity.isInLava` and immediately swim/jump up.
- **Mob retreat.** When bot health < 6 (3 hearts) AND a hostile mob is nearby, override current goal with `moveAway` from the mob until health regenerates.
- **Pre-fight equip.** When `self_defense` mode fires, ensure best weapon is equipped before attacking (ties into #4 wrong tool).
- **Suffocation escape.** Already handled by `self_preservation` mode (head-in-water jump). Could extend to detect head-in-block (sand/gravel collapse) and dig up.
- **Dimension safety.** If bot accidentally enters Nether or End (via portal), retreat immediately — current code has no dimension awareness.

**Signals to watch after shipped pieces:**
- Death rate from fall damage drops to ~0.
- Bot's `food` value stays at 18+ during normal play.
- `[autoEat]` events visible in log when bot eats.
- Escape attempts no longer get reset by fall-respawn cycles.

**Why this matters:** as confirmed via Bug B instrumentation 2026-04-15, the bot's "escape plateau" was actually death-and-respawn-back-to-spawn caused by fall damage during escape walks. Survival hardening removes the death cause, which removes the respawn-loop, which lets the escape complete.

---

## Notes

- **Item 0 validated end-to-end 2026-04-14** (bot reached 253 and 300 blocks from spawn across separate sessions). Remaining polish deferred.
- **Item 1 resolved 2026-04-14** via ViaBackwards 5.0.4 on server. Bot now stays connected cleanly.
- **Item 2 is now the acute blocker** — observed 2026-04-14: bot successfully escapes spawn, then drowns in the first body of water. Can't play without swim.
- **Item 3 partially shipped 2026-04-14** — `autoBreakStuckPlant` + terrain-safe movements + plant/tree spawn-zone split deployed. Remaining pieces depend on #2.
- Items 5 and 6 will interact — the torch inventory check in #5 + placement convention in #6 should share a common helper.
- Items 0 and 7 share infrastructure — both are "protected zone" rules. Factor out a `ProtectedZone` abstraction once #7 is implemented.
- Item 4 is the biggest latent performance bug after #0–#3 land fully.
- Item 8 should be last — don't add delays on top of a bot that can't swim/dig-with-the-right-tool.
- Item 9 is a philosophy that shapes how we approach 0–8 and everything beyond. Items #0, #2, #3, #7 are all direct applications of #9: the LLM shouldn't be reasoning about spawn-zone escape, swimming, swamp bush traversal, or structure boundaries — the code should.

---

## Recently completed

### Evening session 2026-04-14 — #1 resolved, #0 validated, #3 partially shipped

Across one long evening session, big wins landed on `fix/spawn-zone-escape` branch:

1. **#1 PartialReadError resolved.** ViaBackwards 5.0.4 installed in server's `mods/` folder + bot pinned to `minecraft_version: "1.21.4"`. ViaBackwards translates 1.21.4 protocol (769) → 1.21.0 server protocol (767). Before: ~4 reconnects/hr; after: 1 spawn per session, 0 reconnects over 10+ min windows. Commits: `70d1446` (bot settings), `5ed3a46` (whiteboard).
2. **#0 Spawn-zone escape validated end-to-end.** Bot successfully escaped the 250-block spawn protection zone twice across separate sessions (reaching 253 and 300 blocks from spawn). Hardening included: 2-min per-direction timeout, multi-direction retry, NaN-position guard, terrain-safe movements, position-check after every attempt regardless of outcome, `autoBreakStuckPlant` integration.
3. **digDown cavern short-circuit fixed.** Was letting pathfinder dig straight-down vertical shafts to reach caverns; now only takes the short-circuit if a non-destructive walk-in path exists. Commit `a0793dd`.
4. **Safety-mode mutex bypass.** Modes with `interrupts: ['all']` (self_preservation, hurt, cowardice, self_defense) now skip the bot mutex so they fire immediately even when a long skill is running. Commit `97c03fd`.
5. **#3 Swamp traversal partially shipped.** Extended `_configureTerrainSafeMovements` with additional damage-on-contact blocks (dripstone, cactus, magma, soul fire, powder snow). New `autoBreakStuckPlant` helper with plant-vs-tree split for spawn-zone, leaves allowed in spawn. Wired into both `goToGoal` and `escapeSpawnZone`. Commits `bbf4ea1`, `ee0168e`, `f001d80`, `d051ab1`.

**Death signal pointing at #2:** bot escaped spawn successfully, then drowned walking through water. Self-preservation fires (we confirmed the mutex bypass), but can't swim out. Next priority is #2.

### Post-merge stability check — bot mutex validated, two root causes surfaced (2026-04-14)

3-hour runtime on `develop` (commit `b17b17a`). Zero concurrency errors: 0 `goal was changed`, 0 `Digging aborted`, 0 SafeToss fallbacks across all observed windows. Mode wrap exercised cleanly by `mode:unstuck` (2 clean acquire/release pairs). `item_collecting ↔ SafeToss` scenario didn't naturally trigger (inventory never filled), so that specific race remains empirically untested — but every other mutex path is clean, so confidence is high.

The check surfaced **two** previously-unknown issues that explain why the bot accomplishes so little:

1. **Spawn-zone trap** — bot is physically inside its own 350-block spawn protection zone and cannot dig. It loops: `!digDown` → `[SpawnProtect] Blocked` → `Action was interrupted` → `mode:unstuck` → 3-5 blocks lateral → repeat. LLM knows it needs to move (wrote "Must move out from spawn limit" in its own memory) but can't figure out how. → Promoted to item #0.
2. **`PartialReadError` disconnect rate** — 13 reconnects in 3 hours. Only 1 in 4 commands completes before a disconnect aborts it. → Promoted to item #1.

### Bot action mutex — concurrency fix (2026-04-14, merged `6fdcff2`)

Root cause: LLM commands, AutoRecovery flows, SafeToss/digDown skills, and mineflayer-event-driven modes were all calling `bot.pathfinder.setGoal()` and `bot.dig()` concurrently with no coordination. Each new goal cancelled the prior one, throwing `goal was changed` / `Digging aborted`. SafeToss's disposal ladder always fell through to normal toss → bot dropped items at its feet → server re-picked them up → inventory still full → infinite loop.

Fix: reentrant FIFO mutex (`src/agent/bot_mutex.js`) gating every bot-mutating path. Reentrant by async context (`AsyncLocalStorage`) so nested skill calls don't deadlock. Applied at four entry points:

1. `Agent.handleMessage` — wraps both `executeCommand` callsites in `cmd:<name>`.
2. `AutoRecoveryEngine.checkAndRecover` — wraps recovery body in `autoRecovery:<pattern>`.
3. `skills.safeToss` + `skills.digDown` — wrap own bodies; rewrote SafeToss dump run as walk-and-dig (was trying to dig all 16 blocks from standing position, exceeding mineflayer's ~6-block reach).
4. `modes.js execute()` — single chokepoint for all modes; prevents `item_collecting`, `self_defense`, etc. from racing active skill work.

Also: save/restore `bot.pathfinder.movements` across `safeToss` and `digDown` to prevent lingering side effects.

**Results:** from 100% SafeToss failure to 96%+ success. Zero `Digging aborted`, zero `goal was changed` post-mode-wrap (in observed windows).

### Two commits under this umbrella

- `3c11948` fix: serialize bot actions with reentrant mutex (initial — covered commands, AutoRecovery, safeToss, digDown)
- `d9a5f66` fix: extend bot mutex to mode actions (covered `item_collecting` and other mode-triggered races)

---

## Known issues (deferred — out of scope for items 0–9)

- **Memory compression exceeding 500-char limit.** LLM repeatedly truncates its own memory summaries with "Memory truncated to 500 chars. Compress it more next time." Compression prompt isn't strict enough. Fix lives in the memory summarization prompt template.
- **`self_preservation` mode now waits on the bot mutex.** In rare cases (bot drowning during a long SafeToss), emergency response could be delayed by several seconds. Trade-off accepted for now vs. the constant disposal failure the race was causing. Can carve a priority-mutex exception later if it becomes a problem.

_(PartialReadError was here — promoted to item #1 after 2026-04-14 stability check showed 13 reconnects in 3 hours.)_
