# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-15 (to-do queue regrouped by status → importance; #7a restored to Recently completed)_

---

## Current state (live on develop)

- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b-it` via LM Studio.
- Branch: `develop` — HEAD `8f722ce`. All fixes merged + pushed to GitHub.
- Bot settings: `minecraft_version: "1.21.4"` (translates through ViaBackwards 5.0.4 installed on server) and default host/port.
- Stability: ViaBackwards holding (0 disconnects across multi-hour windows). Mutex balanced. Survival hardening shipped (maxDropDown=3, autoEat startAt=19). Tool selection now equipping correctly before every dig.
- Bot escapes spawn zone in 1 hop (226 → 265 blocks observed). Mining iron_ore yields drops (proves pickaxe equip is working).
- Inventory management: goal-aware classification with 4-tier priority (SINGLETON_KEEPS > BED_GROUP > STACK_CAPS > getItemValue). On inventory-full, `autoDiscardAllJunk` drains every limit-violating stack in one pass (crafting_table/furnace/bow/shield/flint_and_steel/bucket/water_bucket kept at 1; 30+ resources/materials capped at 1 stack; bed kept at 1 across all colors; all 17 shulker_box variants unlimited; lava_bucket/chest/ore_blocks treated as junk).

---

## In-progress

**Memory compression exceeding 500-char limit.** LLM repeatedly truncates its own memory summaries with "Memory truncated to 500 chars. Compress it more next time." Compression prompt isn't strict enough. Fix lives in the memory summarization prompt template. Currently analyzing logs to find root issue.

---

## To-do queue

Items grouped by status (⏳ Not started → 🟡 Partial → 🔁 Ongoing). Within each status group, items are sorted by importance/impact/severity — highest first. Numbers preserved from project history.

---

**⏳ Not started**

### 11. Tool / weapon / armor tier hierarchies (keep best, drop lower tiers)

**Status:** ⏳ not started • **Priority:** medium (pairs well with the inventory overhaul; same file, same patterns)

Currently all tools, weapons, and armor are in KEEP_ALWAYS (tier 5, unlimited). If the bot has wooden + stone + iron pickaxe, all three are kept forever. Should keep only the best tier of each role; lower tiers become tier 1 junk.

**Fix sketch:**
1. New `TOOL_HIERARCHY` in `inventory_utils.js` — per role (pickaxe, axe, shovel, hoe, sword), list tiers ordered best→worst (netherite > diamond > iron > stone > wooden).
2. New `ARMOR_SLOTS` — four per-slot hierarchies (helmet, chestplate, leggings, boots), each netherite > diamond > iron > golden > leather (chainmail if present — rare).
3. Extend `snapshotInventory` with a fifth check (after STACK_CAPS): for each role, find the best tier the bot owns → tier 5; lower tiers in that role → tier 1 junk with `discardable = total`.
4. Remove individual tool/weapon/armor item names from KEEP_ALWAYS — the new hierarchy logic supersedes them.

**Caveats (document, don't solve):**
- **Durability not considered.** A half-broken iron pickaxe still beats a fresh wooden one. Practically fine — bots craft new when tools break.
- **Enchantments not considered.** An enchanted wooden pickaxe (Efficiency V) would still be classified as junk if iron exists. Edge case for gemma-4.
- **Golden tools** stay out of hierarchies (rare drops, terrible durability, not crafted by bot).

**Signals to watch:** bot doesn't accumulate a wooden_pickaxe trail while mining iron; after crafting iron tools, AutoRecovery drains the stone tier on next inventory-full.

### 7. Respect player-built structures (50-block no-disturb radius)

**Status:** ⏳ not started • **Priority:** medium (protective feature, no active blocker)

The bot must not disturb player-built structures. No breaking, placing, digging, tossing items, or otherwise modifying blocks within 50 blocks of any player-built structure.

**Fix sketch:**
1. New config file or in-world registry `player_structures.json` — list of `{name, x, y, z, radius}` entries.
2. New helper `_isNearPlayerStructure(bot, x, y, z)` in `skills.js` (similar shape to `_isInSpawnZone`).
3. Add check inline in `breakBlockAt`, `placeBlock`, and SafeToss underground dig branch. On violation, return false with `"near player structure"` error (matchable by AutoRecovery).
4. **Reuses spawn-zone infrastructure:** factor out a `ProtectedZone` abstraction; one `_isInAnyProtectedZone(x, y, z)` gate handles spawn + all player structures.

**Auto-detection (later):** watch for `placeBlock` events from the player, cluster by proximity + time, promote to a protected structure automatically after N placements.

### 7b. Self-cleanup of incidental block placements

**Status:** ⏳ not started • **Priority:** medium (world-stewardship behavior)

JP observed the bot placing vertical/horizontal columns of resource blocks (cobblestone, dirt) for unclear reasons — pathfinder scaffolding / LLM confusion. Bot should track its placements and clean them up.

**Fix sketch:**
1. Track every block via `bot.placedBlocks = [{x, y, z, type, placedAt, purpose}]` (similar to `bot.placedTorches`).
2. Categorize purpose: `pathfinder-scaffold`, `spawn-block`, `unknown-llm` (cleanup-eligible) vs `intentional`/`torch`/`functional` (excluded).
3. New low-priority `cleanup_blocks` mode in `modes.js`, fires when idle: walks through eligible entries; if bot is now >5 blocks away AND block still exists, break it and remove from list.
4. Cap list size (200, FIFO). Clear on bot death/respawn.

### 8. Humanized action delays

**Status:** ⏳ not started • **Priority:** low

Bot currently acts as fast as LLM + mineflayer allows, which looks robotic and could trigger anti-cheat on some servers. Add variable delay between commands.

**Fix sketch:**
- New file `src/agent/human_delays.js` with command→delay-range map.
- In `Agent.handleMessage` after a command completes: `await new Promise(r => setTimeout(r, getHumanDelay(command_name)))`.
- Base delay 3s, scale by complexity (1-2s trivial, 2-3s movement, 3-5s gather/craft, 4-6s complex). ±1000ms jitter.
- Don't apply to mode-triggered actions (self_preservation, self_defense) — those react instantly.

---

**🟡 Partial**

### 10. Bot survival hardening (more)

**Status:** 🟡 fall prevention + auto-eat shipped 2026-04-15. Lava/mob/dimension safety pending. • **Priority:** high (every avoidable death is a respawn-loop)

**Remaining work:**
- **Lava avoidance** — strict avoid + cost penalty for lava/magma; detect `bot.entity.isInLava` and swim/jump up immediately.
- **Mob retreat** — when health < 6 (3 hearts) AND hostile mob nearby, override current goal with `moveAway` until health regenerates.
- **Pre-fight equip** — `self_defense` mode ensure best weapon is equipped before attacking. Partially done via #4 `equipHighestAttack`.
- **Suffocation escape** — extend `self_preservation` to detect head-in-block (sand/gravel collapse) and dig up.
- **Dimension safety** — if bot accidentally enters Nether or End via portal, retreat immediately. No dimension awareness today.

### 2. Bot swim capabilities

**Status:** 🟡 Layer 1 shipped 2026-04-14 (`canSwim=true` in pathfinder + `self_preservation` jump-when-drowning). Layer 2/3 deferred. • **Priority:** medium (bot survives most water now)

**Remaining work:**
- Layer 2: explicit `swim(bot, targetPos)` skill the LLM can invoke
- Layer 3: auto-equip turtle shell helmet / water-breathing potion if in inventory; prefer surface-swim paths over underwater paths

**Signals to watch:** bot crosses rivers without drowning (✅ since Layer 1); food/health stable in water; no "stuck" mode firing while swimming.

### 3. Swamp biome traversal — water + lily-pad pieces only

**Status:** 🟡 plant-side shipped 2026-04-14 (`autoBreakStuckPlant`, terrain-safe movements, plant-vs-tree split, leaves allowed in spawn). Water + lily-pad portions deferred. • **Priority:** medium

**Remaining work:**
- Water-traversal in shallow swamp pockets (depends on #2 Layer 2/3)
- `lily_pad` treated as walkable surface (mineflayer-pathfinder doesn't natively support "stand on this partial collision block" — may need custom handling)
- In-swamp biome detection to activate more aggressive movement configs dynamically (current implementation is biome-agnostic)

This item and #2 share terrain-awareness logic — consider a single "terrain profiles" abstraction once #2 lands.

### 6. Strategic torch placement underground — strict left-wall convention

**Status:** 🟡 breadcrumb placement shipped 2026-04-14 (`placeTorchAt` + `digDown` every-4-blocks marker + `goToSurface` follows torches). Strict left-wall geometry deferred — current placement is "behind bot on floor". • **Priority:** low (current behind-bot placement works for breadcrumbs)

**Remaining work:**
- Compute "left of facing direction" wall position for each placement
- Place wall_torch attached to left wall vs floor torch
- Update `goToSurface` ordering hint (right-side torches = ascent direction)

---

**🔁 Ongoing**

### 9. Reduce LLM reliance through programmatic enhancements

**Status:** 🔁 ongoing architectural theme • **Priority:** apply incrementally

Let the LLM do what it's good at — open-ended goal-setting, natural-language chat, high-level strategy. Program everything else — mechanical rules, state transitions, routine sub-goals.

**Candidate areas (grow as we work):**
- **Goal state machine** — gather_wood → craft_basic_tools → mine_stone → upgrade_tools → mine_iron → … as a deterministic state graph.
- **Scripted sub-tasks** — "mine N of X ore" → find nearest, equip correct tool, path, dig, collect, repeat. Single high-level command.
- **Inventory management** — auto-sort, auto-empty into chest, auto-pick-up. Some pieces already in AutoRecovery.
- **Pathing preferences** — prefer known-safe terrain, avoid known-lava areas (memory of prior deaths).
- **Food/sleep loop** — auto-eat (✅ shipped via #10) + auto-sleep at night when safe.
- **Combat reflexes** — `self_defense` auto-equips best weapon (✅ partially via #4); program: strafe, block with shield, retreat at low health.
- **Crafting plans** — auto-execute when prerequisites met (already have `getCraftingPlan`, just need auto-trigger).
- **Pattern-matched chat responses** — common greetings, status queries → canned. Only escalate to LLM for unusual input.
- **Auto-craft basic-need items** — torches when coal+stick available, sticks when oak_planks low, tools (best tier inventory supports). _(Surfaced 2026-04-14: bot's #5/#6 torch features silent-skipped because bot hadn't crafted any torches.)_

---

## Known issues (deferred — out of scope for current to-do)

- **Memory compression exceeding 500-char limit.** LLM repeatedly truncates its own memory summaries with "Memory truncated to 500 chars. Compress it more next time." Compression prompt isn't strict enough. Fix lives in the memory summarization prompt template.
- **`self_preservation` mode now waits on the bot mutex in routine paths.** `interrupts: ['all']` modes already bypass mutex (commit `97c03fd`); the trade-off is preserved. Edge cases (drowning during a long SafeToss) could still be delayed by a few seconds. Acceptable for now.
- **Mob combat against ranged attackers.** Bot died to a Pillager 2026-04-14 — `self_defense` works for melee but doesn't position well against crossbow / arrow attacks. Tracked partially under #10.
- **`Cannot smelt coal_ore` LLM confusion.** LLM tried to smelt the ore block instead of the dropped coal item. Could auto-correct via AutoRecovery pattern.

---

## Notes

- **Item 0 fully resolved 2026-04-15** — bot escapes spawn zone in 1 hop with 0 deaths after combined fix landed (escape rewrite + survival hardening + Bug A/C fixes).
- **Item 1 fully resolved 2026-04-14** — ViaBackwards 5.0.4 on server. Bot stays connected cleanly.
- **Item 4 fully resolved 2026-04-15** — `_equipBestToolFor` wired into all 7 `bot.dig` callsites; iron_ore drops confirmed.
- **Item 5 fully resolved 2026-04-14** — torch_placing mode trigger on actual darkness; bot needs to craft torches first (gameplay/LLM gap, tracked under #9 auto-craft).
- **Items 2 and 3 share terrain-awareness logic** — when both lands fully, factor into a "terrain profiles" abstraction.
- **Items 0 and 7 share infrastructure** — both are "protected zone" rules. Factor out `ProtectedZone` abstraction once #7 ships.
- **Item 8 should be last** — don't add delays on top of an unfinished bot. Fix behavior first, then slow it down.
- **Item 9 is the philosophy** — every routine/mechanical decision the LLM is asked to make is a candidate to convert to code. Items #0, #2, #3, #4, #7, #10, #11, and today's inventory overhaul are all applications.
- **#11 builds on today's inventory overhaul** — same file (`inventory_utils.js`), same `snapshotInventory` priority chain. Extending with tool/armor hierarchy is structurally a 5th check after STACK_CAPS. Factor once, extend cheaply.

---

## Recently completed

### 2026-04-15 — Inventory management overhaul ✅

End-to-end redesign of inventory classification and disposal, landed in four commits (`21976f3`, `50bf280`, `f141be8`, `8f722ce`). Previously inventory-full recovery only freed 5 slots at a time, so junky biomes triggered 3–4 back-to-back SafeToss cycles before stabilizing (the "visually stuck" behavior JP observed during `!collectBlocks("iron_ore", 50)`). Classification was also outdated — oak/birch/spruce only for wood goals, ore blocks unclassified, no limit on how many crafting_tables the bot could hoard, etc.

**Disposal strategy — `autoDiscardAllJunk`.** Replaces the old "free 5 slots" behavior in `auto_recovery.js recoverInventoryFull`. Drains every limit-violating stack in one pass, then the 60-second `DISCARD_COOLDOWN_MS` keeps the bot from re-entering the loop for the rest of the collect. Other call sites (`recoverWrongTool`, `recoverNeedCraftingTable`, `recoverNeedFurnace`) intentionally keep the targeted 2-slot variant — they only need a sliver of space. New `getJunkStackCount` helper gives a pre-drain log line.

**Classification — `snapshotInventory` priority chain.**  Single source of truth for every caller. For each inventory item, runs these checks in order:

1. **SINGLETON_KEEPS** (keep 1): `crafting_table, furnace, bow, shield, flint_and_steel, bucket, water_bucket`. Explicitly not on this list: `crossbow`, `fishing_rod`, `lava_bucket` (chose not to singleton-limit).
2. **BED_GROUP** (keep 1 of any color): plain `bed` + 16 dyed variants. First color encountered is the keeper; every other bed color in inventory becomes junk.
3. **STACK_CAPS** (keep 1 stack). `ender_pearl` caps at 16 (vanilla stack limit); 30+ others at 64: `blaze_rod`, `blaze_powder`, `torch`, `bone`, `string`, `gunpowder`, `arrow`, `feather`, `leather`, `slime_ball`, `magma_cream`, `ghast_tear`, `glowstone_dust`, `amethyst_shard`, `wheat`, `bread`, `iron_ingot`, `raw_iron`, `gold_ingot`, `raw_gold`, `copper_ingot`, `raw_copper`, `netherite_ingot`, `netherite_scrap`, `diamond`, `emerald`, `redstone`, `lapis_lazuli`, `coal`, `charcoal`, `quartz`.
4. **`getItemValue`** (fall-through). Fixed ordering bug: KEEP_ALWAYS checked BEFORE goal-protection (previously, items in both sets got downgraded from tier 5 → 4, which `getDiscardSuggestions` would surface as last-resort discards).

Entries with `discardable <= 0` are omitted (treated as protected).

**KEEP_ALWAYS additions & removals.**
- Added: `ancient_debris` (rarer than diamonds, protected until smelted to `netherite_scrap`), and all 17 `shulker_box` variants (portable storage, nest-friendly — JP: "shulker boxes are a keep as they can be nested").
- Removed: `lava_bucket`, `chest` — both moved to tier 1 junk. Bot doesn't hoard fuel or storage chests; shulker_boxes cover mobile storage.

**Tier 1 junk expansions** (so `autoDiscardAllJunk` actually drains them):
- Biome-specific bulk: `magma_block`, `soul_sand`, `soul_soil`, `sandstone`, `red_sandstone`, `red_sand`, `end_stone`, `prismarine`, `prismarine_bricks`, `dark_prismarine`, `coarse_dirt`, `rooted_dirt`, `podzol`, `mycelium`, `terracotta`.
- Ore blocks (smelt to the resource, drop the block): `iron_ore`, `deepslate_iron_ore`, `gold_ore`, `deepslate_gold_ore`, `nether_gold_ore`, `copper_ore`, `deepslate_copper_ore`, `diamond_ore`, `deepslate_diamond_ore`, `emerald_ore`, `deepslate_emerald_ore`, `redstone_ore`, `deepslate_redstone_ore`, `lapis_ore`, `deepslate_lapis_ore`, `coal_ore`, `deepslate_coal_ore`, `nether_quartz_ore`.
- Deprecated utility: `lava_bucket`, `chest` (see KEEP_ALWAYS removals above).

**Wood-type coverage.** New `ALL_PLANKS` / `ALL_LOGS` / `ALL_SAPLINGS` constants cover every MC 1.21 variant (oak, birch, spruce, dark_oak, jungle, acacia, mangrove, cherry, bamboo, pale_oak — mangrove uses `propagule`). GOAL_ITEM_MAP entries that previously only listed oak/birch/spruce now spread the full set, so a birch-forest bot with a "craft tools" goal no longer loses its birch_planks. `crafting_table` / `furnace` explicitly listed under craft/tool/smelt/house/etc. goals for defense-in-depth (redundant with KEEP_ALWAYS after the ordering fix, but readable).

**Log output.** Extras of limited items (`SINGLETON_KEEPS` / `BED_GROUP` / `STACK_CAPS`) log as `"N extra <item_name>"`; regular junk logs as `"N <item_name>"`. Pre-drain log line: `[AutoRecovery] Clearing inventory (goal-aware drain-all-junk, N junk stack(s) to drain)...`.

**Open extensions (not yet implemented):** tool/weapon/armor tier hierarchies — keep only the best tier of each role and toss lower tiers. JP flagged this for a separate conversation.

### 2026-04-15 — #4 Wrong tool for the block ✅

Commit `1c5b741`. New helper `_equipBestToolFor(bot, block)` using `bot.pathfinder.bestHarvestTool`. Wired into all 7 `bot.dig` callsites (`collectBlock`, `breakBlockAt`, `safeToss` walk-and-dig × 3, `safeToss` surface hole, `autoBreakStuckPlant`). Skip if no tool needed or already holding the best one. Bonus fix: `equipHighestAttack` sort comparator was returning a boolean — proper descending sort now. Verified post-deploy: bot collected 2 iron_ore (impossible bare-handed → confirms stone+ pickaxe is being equipped).

### 2026-04-15 — #10 Bot survival hardening (Layer 1) ✅

Commit `4def1fa`. Two pieces:
1. `pf.Movements.maxDropDown` set to 3 (vanilla no-damage limit; was default 4) on both non-destructive and destructive movements in `goToGoal`. Pathfinder no longer chooses paths with risky drops.
2. `bot.autoEat.options.startAt` bumped from 14 → 19. Bot eats whenever hunger < 19 (essentially always), keeping hunger at 18+ for continuous health regeneration.

Validated: bot escaped spawn zone in 1 hop (226 → 265 blocks) with 0 fall deaths, where prior sessions saw repeated fall-respawn cycles.

### 2026-04-15 — Bug B escape plateau ✅ (fully resolved)

Diagnosed via instrumentation (`a4981b0`): "mysterious teleport-back" was death+respawn from fall damage during escape walks. Fixed via combined work: escape rewrite (`ad3874d`) + survival hardening (`4def1fa`) + Bug A/C fixes (`ec75860`). Post-deploy: 1-hop escape with 0 deaths.

### 2026-04-15 — Bug A AutoBreakPlant terrain destruction ✅

Commit `ec75860`. `PLANT_LIKE_PATTERN` matched `grass_block` (solid terrain) via the bare token "grass". Tightened regex to `(^|_)grass$`, removed bare "moss" / "fungus", added `SOLID_GROUND_BLOCKS` hard-exclusion list (`grass_block`, `moss_block`, `mycelium`, `podzol`, `rooted_dirt`, `dirt_path`, `farmland`).

### 2026-04-15 — Bug C AutoBreakPlant repeat-failure ✅

Commit `ec75860`. Per-bot in-memory blacklist `bot._autoBreakBlacklist` (Map<"x,y,z", expiryTime>). On dig failure, position is blacklisted for 30 seconds. Subsequent invocations skip blacklisted positions; helper tries a different neighbor. Auto-prunes expired entries.

### 2026-04-15 — Spawn-zone escape rewrite (#0 Bug B fix) ✅

Commit `ad3874d`. Replaced cycle-through-4-cardinals with commit-to-direction strategy:
1. Try cached exit from `bot.escapeMemory` first (90s timeout).
2. Pick from 8 directions (4 cardinals + 4 diagonals) sorted by drift-from-spawn proximity. Commit to each in order.
3. Walk in 40-block hops with 45s timeouts. Progress ≥10 blocks resets stuck counter.
4. Stuck maneuver per JP: back 3 blocks, then alternate left/right sidestep 15 blocks (sidestep skipped if it would decrease distance from spawn further). Then `autoBreakStuckPlant`.
5. After 5 stucks on one direction → next direction in list.
6. Record successful exit to memory for future escapes from same spawn coord.

Followup `4201bae`: NaN-position guard (bound at 3 waits then bail direction) + cancel stale pathfinder goal on timeout (so next hop starts clean).

### 2026-04-14 — #1 PartialReadError reconnect storms ✅

Commit `70d1446` (bot settings) + ViaBackwards 5.0.4 in server `mods/`. Root cause: mineflayer 4.37 supports MC 1.21.1+, server runs 1.21.0 base — slot-component packet drift caused decoding errors. Fix: ViaBackwards translates 1.21.4 protocol (769) → 1.21.0 (767). Bot pinned to `minecraft_version: "1.21.4"`. Before: ~4 reconnects/hr; after: 1 spawn per session, 0 reconnects over multi-hour windows.

### 2026-04-14 — #5 Torches when dark ✅ (mode trigger)

Commit `436ff45`. `world.shouldPlaceTorch` rewritten: requires darkness (night via `bot.time.timeOfDay`, underground via `pos.y < 50`, or `block.skyLight < 8`) plus no torch within 8 blocks. Previously fired in broad daylight whenever no torch was nearby. New `placeTorchAt(bot, x, y, z, face)` helper records placements to `bot.placedTorches` for breadcrumb navigation.

### 2026-04-14 — #6 Torch placement during digDown (breadcrumbs) ✅

Commit `436ff45`. `digDown` places a torch every 4 descended blocks (lowered from 8 after observed `digDown(5)` never triggered). `goToSurface` follows the torch trail back up before falling back to naive surface probe.

### 2026-04-14 — Bot action mutex (concurrency fix) ✅

Commits `3c11948` + `d9a5f66`, merged as `6fdcff2`. Reentrant FIFO mutex gating every bot-mutating path (LLM commands, AutoRecovery, SafeToss, digDown, modes via `modes.js execute()` chokepoint). Reentrant by `AsyncLocalStorage`. Eliminated `goal was changed` / `Digging aborted` race errors. SafeToss disposal went from 100% failure to 96%+ success.

### 2026-04-14 — Spawn-zone protection design + initial escape work

Implemented `_isInSpawnZone` (`SPAWN_PROTECTION_RADIUS = 250`) blocking destructive actions inside zone. Initial `escapeSpawnZone` skill auto-walks bot to 350 blocks from spawn on every spawn event. Refined later through Bugs A/B/C and the rewrite above.

### Pre-2026-04-15 — #7a Replant tree saplings ✅

Already implemented in `skills.js collectBlock` (lines 494-641). Full `LOG_TO_SAPLING` mapping for 9 tree types (oak/birch/spruce/dark_oak/jungle/acacia/mangrove→propagule/cherry/pale_oak). Tracks tree base positions (lowest log per x/z = the stump) during a multi-log collect. After the dig batch, replants saplings on dirt/grass/podzol/mud/rooted_dirt/coarse_dirt/mycelium/moss_block. Skips if no sapling in inventory; spawn-zone protection inherited from `placeBlock`; non-fatal try/catch. Logs `"Replanted N sapling(s) where trees were chopped"` on success. Discovered to already exist 2026-04-15.
