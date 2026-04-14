# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-14 (evening: spawn-zone fix deployed; swim + swamp added)_

---

## Current state (live on develop)

- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b-it` via LM Studio.
- Branch: `fix/spawn-zone-escape` — HEAD `527ce2d`. Spawn-zone escape deployed 2026-04-14 evening. Bot fires `escapeSpawnZone` on spawn and walks toward the boundary.
- **Current observation:** escape skill fires correctly (bot is walking out) but keeps getting stuck on swamp-biome terrain (bushes, water pockets). This surfaces new whiteboard items #2 (swim) and #3 (swamp traversal).
- Open fixes pending merge to `develop`: spawn-zone escape (commit `527ce2d`), verification dependent on #2/#3 progress.

---

## In-progress

_Nothing active._

---

## 0. Spawn-zone auto-escape (bot self-rescue)

**Status:** code deployed on `fix/spawn-zone-escape` (commit `527ce2d`), verification in progress • **Priority:** blocker

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

## 1. `PartialReadError` reconnect storms

**Status:** not started • **Priority:** high (validation-blocker)

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

**Status:** not started • **Priority:** high (actively blocking bot travel — observed 2026-04-14)

**Observed:** during spawn-zone escape, bot got stuck trying to walk through a swamp bush. Swamp biomes combine terrain hazards that the default pathfinder handles poorly: shallow water pockets, lily pads, mangrove roots, tall grass, bushes, vines. Pathfinder treats bushes as solid (stops), water as unswimmable without #2, lily pads as walkable floor (then bot falls through).

**Expected behavior:**
Programmatic adjustments to pathfinder movement rules when the bot is in a swamp biome:
- Treat `dead_bush`, `fern`, `tall_grass`, `large_fern`, `sugar_cane`, `cobweb` as walk-through (break if necessary — costs ~0 time).
- Treat `lily_pad` as walkable surface (path on top without falling through).
- Treat shallow water (≤1 block deep) as walkable if floor is solid.
- Treat deep water as swimmable (depends on #2).
- Treat `mangrove_roots` and `mangrove_propagule` as breakable-for-passage.

**Fix sketch:**
1. New helper `_configureSwampMovements(movements)` in `skills.js` that mutates a `pf.Movements` instance to add the above exceptions:
   - `movements.blocksCantBreak.delete(id)` for bushes/grass/vines.
   - `movements.blocksToAvoid.delete(water_id)` (allow water steps in shallow areas).
   - Add lily pad to walkable-surface list (may require custom block collision override).
2. In `goToGoal`, detect swamp biome (`bot.world.getBiome(bot.entity.position)` returns biome ID — check against swamp IDs `swamp`, `mangrove_swamp`) and call `_configureSwampMovements` before pathfinding.
3. Consider an auto-break helper: when pathfinder says "path not found" and bot is in swamp, break the obstructing plant-block in front and retry.

This item and #2 share terrain-awareness logic — consider a single "terrain profiles" abstraction where different biomes activate different pathfinder configurations.

**Signals to watch after fix:**
- Bot escape from spawn zone completes even when path crosses swamp.
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
- **Pattern-matched chat responses.** Common greetings, acknowledgments, status queries → canned responses. Only escalate to LLM for unusual input.

**Fix sketch:**
Not a single fix — a design principle that should be applied incrementally. Every time we catch the LLM being asked to make a routine/mechanical decision, convert it to code. Track wins here as we make them.

Starting points: items #1 (tool selection), #3 (torch placement) are already in this spirit. Continue from there.

---

## Notes

- **Item 0 is deployed** but its first real validation run got interrupted by items 2/3 (swim + swamp). The code works; the bot just can't traverse the terrain it needs to cross to leave the zone.
- **Item 1 is a validation blocker** — without fixing PartialReadError reconnects, we can't empirically confirm any other fix holds over a realistic session length.
- **Items 2 and 3 are linked** — both are terrain/navigation issues. Probably share a common "movement profile" abstraction. Fix together.
- Items 5 and 6 will interact — the torch inventory check in #5 + placement convention in #6 should share a common helper.
- Items 0 and 7 share infrastructure — both are "protected zone" rules. Factor out a `ProtectedZone` abstraction when #0 is fully stable.
- Item 4 is the biggest latent performance bug after #0–#3. The current tool races and dig timeouts may silently resolve once the bot is actually using pickaxes on stone.
- Item 8 should be last — don't add delays on top of a broken bot. Fix behavior first, then slow it down.
- Item 9 is a philosophy that shapes how we approach 0–8 and everything beyond. Items #0, #2, #3, #7 are all direct applications of #9: the LLM shouldn't be reasoning about spawn-zone escape, swimming, swamp bush traversal, or structure boundaries — the code should.

---

## Recently completed

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
