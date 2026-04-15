# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-15 (#7 shipped + post-hoc collectBlock leak patched — grass_block/dirt in spawn regression fixed)_

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

_Nothing active. Pick next item from the to-do queue._

---

## To-do queue

Items grouped by status (⏳ Not started → 🟡 Partial → 🔁 Ongoing). Within each status group, items are sorted by importance/impact/severity — highest first. Numbers preserved from project history.

---

**⏳ Not started**

### 7c. Heuristic auto-detection of player-built structures

**Status:** ⏳ not started • **Priority:** medium (complements the #7 village detector; catches player bases)

Current state (post-#7): the bot protects user-managed zones from `player_structures.json` and auto-detects vanilla villages via villager/workstation/bell signals. It does NOT auto-detect player-built bases.

**Approach**: scan chunks for clusters of "strongly player-characteristic" blocks — stone_bricks + polished stones, doors, glass panes, wool, concrete, redstone components, banners, item frames, beds (outside villages), crafted stairs/slabs. ≥5 clustered within ~10 blocks → propose a protected zone with type='player_base'. False-positive mitigation: list curated to exclude ambiguous blocks (torches, crafting_tables, chests, furnaces — these cluster in villages too and the village detector already handles those).

**Deferred decisions:** exact threshold (5? 8?), cluster radius (10? 16?), block list tuning. Start conservative, tune from observed false-positives.

### 7d. Block-update watcher for runtime-placed structures

**Status:** ⏳ not started • **Priority:** low (complements 7c — catches live placements as they happen)

Listen to mineflayer's `blockUpdate` events, filter to player-placed (not world-generation), record `{player, block, x, y, z, timestamp}`. Cluster by proximity + time. Promote to protected zone after N placements within X blocks/Y minutes. Pairs well with 7c (startup heuristic) + live tracking.

### 7e. Seed-based chunk-diff detection (research-only)

**Status:** ⏳ research-only • **Priority:** very low (likely infeasible in JS for 1.21)

Given world seed + MC version, regenerate each chunk deterministically and diff against current state. Any differences are human modifications or pre-generated structures. 100% accurate in principle. **Practically**: no 1.21-compatible JS terrain generator exists. Porting Java's generator (~50K lines + caves-and-cliffs + trial chambers) is a major project. Park indefinitely; revisit if a library emerges.

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

### F. Long-term memory population audit

**Status:** ⏳ not started • **Priority:** medium-high (biggest leverage for "gemma-4 punches above its weight")

The mcgavin fork includes `LongTermMemory` — a Vectra-indexed persistent knowledge store. `seed_memory.js` populates 46 Minecraft-fundamental facts at startup. Beyond the seed, the system is only populated by explicit `agent.long_term_memory.store(text, category, metadata)` calls from gameplay code — and there's no evidence any gameplay path actually calls it. Investigation needed: is `store()` called anywhere outside the seed? If not, long-term memory is frozen at 46 facts forever and the fork's cross-session learning story is aspirational.

**Audit steps:**
1. `grep -rn 'long_term_memory.store\|longTermMemory.store' src/` — enumerate every call site.
2. Trace each call to the trigger event — is it actually fired during normal play?
3. If empty or sparse: design store-on-event hooks. Candidates:
   - **Spawn-escape paths (first concrete migration target)** — `skills.js escapeSpawnZone` currently caches successful exit directions in `bot.escapeMemory` (in-process Map, 90s timeout, keyed by spawn coord). Every restart discards this and the bot rediscovers via the 8-direction search. Migrate to LongTermMemory: on successful escape, `store("Spawn escape from (x,y,z): direction D, N hops, resolved @(x',y',z')", category: "place", metadata: {spawn_xyz, success_xyz, direction})`. On next spawn, query for `"escape spawn zone from (x,y,z)"` — if a match comes back, try that direction first before the 8-way search. Keeps the 90s in-process cache for hot retries, adds cross-session persistence as the fallback tier.
   - New player preferences (JP said "X") → store as `category: player`
   - Discovered landmarks (found village, diamond vein @X,Y,Z) → store as `category: place`
   - Death causes (died to lava at Y=-12) → store as `category: strategy`
   - Successful crafting plans (iron_pickaxe via crafting_table + 3 iron + 2 stick) → store as `category: strategy`
   - Failed approaches (tried to smelt coal_ore directly, rejected) → store as `category: fact`
4. Verify retrieval: during prompt building, does `ContextBuilder` actually surface the right long-term facts for the current context? Check semantic query quality (`_getContextQuery` in prompter.js).

**Success signal:** after a play session, `longterm_index/` grows beyond seed count. After a death, next restart bot "remembers" the danger (avoids lava based on stored event). After a successful spawn-escape, subsequent restarts from the same spawn coord pick the proven direction on the first try without re-searching. Cross-session continuity measurable.

**Why this matters for #9:** this is the highest-leverage place in the codebase to make the 4B model appear smarter. Every stored fact becomes "knowledge" the LLM doesn't have to re-derive from context each turn.

### G. Procedural memory / ConfidenceEngine activation audit

**Status:** ⏳ not started • **Priority:** medium (complementary to F)

`ProceduralMemory` tracks action-context pairs with Wilson-score confidence. `ConfidenceEngine.evaluate()` decides HIGH (≥0.85, bypass LLM) / MEDIUM (0.5-0.84, suggest) / LOW (<0.5, full reasoning). The audit question: what's the actual distribution? If the engine always falls through to LOW (cold-start with no data), procedural memory is collecting metrics nobody reads and the entire bypass mechanism is inert.

**Audit steps:**
1. Add instrumentation to `ConfidenceEngine.evaluate()` — log the bypass decision + confidence score + context key for 1 hour of play.
2. Analyze: confidence distribution across commands, bypass hit rate, how many unique contexts seen.
3. If cold-start dominates: consider seeding `procedural_memory.json` with hand-curated high-confidence patterns (e.g., `"equip pickaxe before mine stone" → confidence 1.0`).
4. If already firing at reasonable rate: adjust thresholds if false positives / false negatives appear.

**Success signal:** measurable fraction of commands bypass the LLM via HIGH confidence — speeds up the bot and reduces hallucination risk. Procedural memory grows session-over-session.

**Why this matters for #9:** bypassing the LLM entirely for routine actions is the purest expression of "let the LLM do what it's good at, program everything else."

---

**🟡 Partial**

### 10. Bot survival hardening (more)

**Status:** 🟡 fall prevention + auto-eat shipped 2026-04-15. Lava/mob/dimension safety pending. • **Priority:** high (every avoidable death is a respawn-loop)

**Remaining work:**
- **Lava avoidance** — strict avoid + cost penalty for lava/magma; detect `bot.entity.isInLava` and swim/jump up immediately.
- **Mob retreat** — when health < 6 (3 hearts) AND hostile mob nearby, override current goal with `moveAway` until health regenerates.
- **Ranged-attacker positioning** — `self_defense` works for melee but doesn't position well against crossbow/arrow attacks. Bot died to a Pillager 2026-04-14. Fix: strafe + use shield when arrow is incoming; close distance or break line-of-sight for crossbow attackers. (Folded in from Known issues 2026-04-15.)
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

_Empty. All prior entries either shipped as fixes or migrated into more accurate to-do items. Add new entries here only when a current concern can't yet be addressed._

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
- **#11 shipped as the fifth priority step** in `snapshotInventory` (`SINGLETON_KEEPS > BED_GROUP > STACK_CAPS > TIERED_ITEMS > getItemValue`). The "factor once, extend cheaply" bet paid off — adding a whole new classification dimension took one lookup table, one helper, and one new step in the chain.

---

## Recently completed

### 2026-04-15 — #7 post-hoc fix: plug collectBlock ProtectedZone leak ✅

Commit `cde1329`. Immediately after #7 landed, JP observed the bot breaking `grass_block` (dirt-with-grass-texture) inside the spawn zone. Root cause: `collectBlock` in `skills.js` calls `bot.dig(block)` and `bot.collectBlock.collect(block)` directly at lines 563/568 — **neither goes through `breakBlockAt`**, so `_isInAnyProtectedZone` was never consulted. `!collectBlocks("...")` bypassed every protected zone.

**Fix:** after `world.getNearestBlocksWhere` returns candidates, filter out any whose position is inside a protected zone. Bumped candidate count from 1 to 8 so valid alternatives remain after filtering. Counts logged per-iteration. When all candidates are protected, emit the actionable message "All N nearby X are inside protected zones..." — wording tuned to match the AutoRecovery `inside_protected_zone` regex so the bot auto-escapes via `ESCAPE_SPAWN_ZONE` and retries from a clean position.

**Audit of other `bot.dig` / `bot.collectBlock.collect` sites:** `breakBlockAt` (line 690) protected, `safeToss` dig branch (line 1009) protected, `autoBreakStuckPlant` (line 1655ish) protected with the longstanding plant-vs-structural carve-out. `collectBlock` was the only leak.

**Post-deploy verification**: bot restarted, tried `!collectBlocks("oak_log", 10)` inside spawn, log showed `collectBlock filtered 8 candidate oak_log block(s) inside protected zones` followed by the escape message and `Collected 0`. Zero digs into the protected zone.

### 2026-04-15 — #7 ProtectedZone completion + village auto-detection ✅

Commits `5fbfc83` (forcedMove log throttling, standalone cleanup), `a73e53b` (Y-bounds + JSON loader + AutoRecovery), `10d45d1` (village auto-detection). Finishes the #7 scaffolding that was sitting uncommitted on the gaming working tree since an earlier session. Bot now protects three zone sources with a unified check:

**Spawn zone** (existing, Y-agnostic). Unchanged.

**Manual zones via `player_structures.json`** at repo root. Loaded once at spawn by `loadPlayerStructures(bot)`. Each entry `{name, x, z, radius, yMin?, yMax?}`; Y bounds optional for full-column protection. Graceful degradation — missing file, malformed JSON, and invalid entries all log informatively and continue with partial or zero zones. Stub file shipped with schema comment.

**Auto-detected villages** via three independent signals in `detectNearbyVillages(bot)`:
- **Villager cluster** — ≥3 villagers within 32 blocks of each other (active villages).
- **Profession-workstation cluster** — ≥3 of `composter`, `smoker`, `loom`, `cartography_table`, `blast_furnace`, `grindstone`, `fletching_table`, `lectern`, `stonecutter` clustered within 32 blocks (abandoned/raided villages).
- **Bell blocks** — every bell within 128 blocks anchors a village zone (bells are village-exclusive in vanilla).

Periodic scanner re-runs every 30s, dedups against existing zones (50-block XZ match → skip). Scan starts 5s after spawn so chunks/entities load first.

**ProtectedZone shape** (unified across sources):
```js
{ name, type: 'spawn'|'structure'|'village', x, z, radius, yMin?, yMax? }
```

Y-bounds are optional per entry. `_isNearProtectedZone(bot, x, y, z)` and `_isInAnyProtectedZone(bot, x, y, z)` honor yMin/yMax if defined, otherwise treat the zone as full-column. All four callers (`breakBlockAt`, `placeBlock`, `safeToss`, `autoBreakStuckPlant`) thread `y` through. Spawn zone stays Y-agnostic by design — player-meta territory, not a specific structure.

**Village parameters** (tuned per JP 2026-04-15):
- `VILLAGE_PROTECT_RADIUS = 100` (200×200 XZ, covers large plains villages)
- `VILLAGE_Y_BELOW = 20` (yMin = centerY - 20, lets bot deep-mine under villages)
- `VILLAGE_Y_ABOVE = 30` (yMax = centerY + 30, covers watchtowers)
- `VILLAGE_MIN_SIGNALS = 3` (threshold for villager and workstation clusters)
- `VILLAGE_CLUSTER_RADIUS = 32` (how close signals must be to group)
- `VILLAGE_DEDUP_RADIUS = 50` (don't re-register if existing zone covers center)
- `VILLAGE_SCAN_INTERVAL_MS = 30000` (30s cadence)

**AutoRecovery** now routes `"near spawn"`, `"near protected structure"`, and `"protected structure 'X'"` all through the same `ESCAPE_SPAWN_ZONE` recovery — `escapeSpawnZone` walks the bot out of any zone regardless of source. Pattern renamed `inside_protected_zone` from `inside_spawn_zone`.

**Verification**: two local harnesses (22 tests for loader + Y-bounds, 29 tests for detector + clustering + dedup); all 51 passed. Post-deploy: bot auto-detected `village_106_83 via bell; Y[45..95]` within 5s of spawn — pipeline working end-to-end.

**Philosophy/rules adherence**: #1 (all detection is code, no LLM), #4 (villages re-detected deterministically from world state each startup; manual JSON persists), #5 (finishes the scaffolding migration from the earlier session), #8 (every registration logged with coords + source). Rules 1-5 (lookup tables, elegant helpers, 30-line doc block, root cause = "no data structure for player-owned areas", 51-test harness, zero callers touched beyond the new exports).

**Open follow-ups** (new to-do entries): `7c` (heuristic block-cluster detection for player bases), `7d` (blockUpdate event watcher for runtime placements), `7e` (seed-based chunk diff — research-only, likely infeasible in JS for MC 1.21).

### 2026-04-15 — #11 TIERED_ITEMS: best-tier tool/armor classification ✅

Commit `8657d9b`. Closed whiteboard item #11. Before this change, tools, weapons, and armor lived in `KEEP_ALWAYS` as individual entries (tier 5, unlimited). Bots accumulating wooden + stone + iron pickaxe kept all three forever, hoarding slots. After this change, `snapshotInventory` runs a tier-aware classifier: only the best-owned tier per role is protected; lower tiers become tier 1 junk.

**New in `src/utils/inventory_utils.js`:**
- `TIERED_ITEMS`: 9-role lookup (pickaxe, axe, shovel, hoe, sword + helmet, chestplate, leggings, boots), each best→worst array. 54 items total (netherite/diamond/iron/stone/wooden/golden for tools; netherite/diamond/iron/chainmail/golden/leather for armor).
- `TIERED_ITEM_NAMES`: flat Set built once at module load for O(1) membership.
- `_computeBestTierPerRole(totals)`: scans totals top-down per role, records the best-owned index. Roles with zero owned items omitted.
- `classifyByTier(name, bestTierPerRole)`: returns `{isJunk, role}` or `null` for non-tiered items.
- `snapshotInventory` priority chain extended: **SINGLETON_KEEPS > BED_GROUP > STACK_CAPS > TIERED_ITEMS > getItemValue** (five steps).
- `autoDiscardAllJunk` now emits three distinguishable log labels: `"N lower-tier X"` (tier-junk), `"N extra X"` (singleton/bed/stack cap extras), `"N X"` (plain tier 0/1 junk).

**`KEEP_ALWAYS` pruned:** all 24 tiered tool/weapon/armor entries removed. Non-tiered tools stay (`bow`, `crossbow`, `shield`, `fishing_rod`, `flint_and_steel`, `shears`).

**Rule 5 (no adverse effects) mitigated with a 29-test local harness** (`test-tier-classification.mjs`) covering: TIERED_ITEMS structural sanity, `_computeBestTierPerRole` on empty/partial/full inventories, `classifyByTier` at each tier position, **CORE SAFETY — best-tier tools never classified as junk** (explicit test at every tier), armor slot independence, only-lowest-tier protection, multi-stack best-tier retention, non-tiered-tool protection via SINGLETON_KEEPS, ore-block classification unchanged from earlier fix, chainmail < iron ordering. **All 29 passed before deploy.**

Audit of 4 external `inventory_utils` importers (`actions.js`, `skills.js`, `auto_recovery.js`, `modes.js`) confirmed no caller reaches into the classification constants directly — all interact via exported functions whose contracts are unchanged. Zero callsite changes required.

**Philosophy / rules adherence** (verified pre-code):
- DESIGN_PHILOSOPHY #1 (reduce LLM reliance), #5 (finish migrations — kills the hoarded-tiers pattern), #8 (fail loudly — distinguishable log labels).
- CODE_RULES #1 (flexible — lookup table, not branches), #2 (elegant — `classifyByTier` helper keeps snapshot loop flat), #3 (commented — 40+ line header on TIERED_ITEMS), #4 (root cause — KEEP_ALWAYS couldn't express tier), #5 (no adverse effects — audit + 29 unit tests).

**Caveats carried forward unsolved (documented in TIERED_ITEMS header):** durability ignored, enchantments ignored, `recoverWrongTool` handles no-tool-available case.

### 2026-04-15 — `self_preservation` mutex-wait Known Issue audited and closed ✅

Revisited the Known Issues entry stating self_preservation reflexes could be delayed by the bot mutex. Code audit + log review found it stale:

- **Drowning** now uses synchronous `bot.setControlState('jump', true)` in the update tick — no `execute()`, no mutex. Fixed in an earlier drowning-bug correction.
- **Sand/gravel head-cover, lava/fire, low-health flee** all go through `execute()` where `interrupts: ['all']` bypasses the mutex at `src/agent/modes.js:328`.
- **Inner skills** invoked by self_preservation (`moveAway`, `placeBlock`, `goToPosition`) don't acquire the mutex themselves. Only 5 skills do (`safeToss`, `autoBreakStuckPlant`, `escapeSpawnZone`, `digDown`, `placeTorchAt`), none reachable from self_preservation paths.

Log review of ~168 history files across the last ~10 hours: zero deaths attributable to mutex-delayed self_preservation. Deaths observed were combat (melee + ranged — tracked under #10 Layer 2) and suffocation (also #10 Layer 2, not yet coded). No drowning, lava, or fall deaths.

Outcome: removed from Known Issues (not "acceptable" — obsolete). Known Issues section now empty.

### 2026-04-15 — AutoRecovery `Cannot smelt <target>` handler ✅

Commits `efec3e4` + `79d02e6`. LLM was calling `!smelt("coal_ore")` (and variants) and hitting the upstream mineflayer error "Cannot smelt X. Hint: make sure you are smelting the 'raw' item." The `isSmeltable()` heuristic in `src/utils/mcdata.js` only accepts `raw*`, `*log*`, and a small whitelist — so every ore-block smelt attempt short-circuits. JP surfaced a related class of confusion: LLM trying to smelt fuels (coal, charcoal) or final products (iron_ingot, diamond, etc.) — both categorically wrong input types.

**New AutoRecovery pattern + handler** in `src/agent/auto_recovery.js`:
- `FAILURE_PATTERNS` entry `cannot_smelt` matching the error regex, routed to new `CORRECT_SMELT_TARGET` recovery action.
- `ORE_SMELT_LOOKUP` table classifies 19 ores into three groups:
  - **Group A** (11 entries: coal_ore, redstone_ore, lapis_ore, diamond_ore, emerald_ore, nether_quartz_ore + deepslate variants): mining drops the final item directly. Recovery tells the LLM no smelting is needed and notes whether the final drop is already in inventory — **no auto-action** (Option i per JP's call).
  - **Group B** (7 entries: iron_ore, gold_ore, copper_ore + deepslate + nether_gold_ore): mining drops `raw_Y`. If `raw_Y` is in inventory, recovery silently auto-corrects `!smelt("X_ore")` → `!smelt("raw_Y")` with the count from the original command clamped to available supply. Else tells LLM to mine first.
  - **Group C** (1 entry: `ancient_debris`): smeltable in vanilla but the upstream heuristic rejects it. Recovery surfaces the gap honestly so the LLM can route around it.
- `FURNACE_FUELS` set (5 entries: coal, charcoal, coal_block, blaze_rod, blaze_powder): recovery replies "X is a FUEL — goes INTO the furnace as energy, not as the smelt input" + inventory count.
- `SMELT_FINAL_PRODUCTS` set (10 entries: iron_ingot, gold_ingot, copper_ingot, netherite_ingot, netherite_scrap, diamond, emerald, redstone, lapis_lazuli, quartz): recovery replies "X is already a final smelted product. Use it for crafting, not smelting input" + count.
- Unknown items pass through the original error unchanged.

**Verification:** regex unit-tested against positive cases (coal_ore, iron_ore, deepslate_diamond_ore, ancient_debris) and negative (unrelated errors, unsmeltable non-ores). All three sets verified non-overlapping. Bot restarted on new code, running cleanly in a deepslate biome with matching ores in range.

Aligns with #9: converts three classes of recurring LLM production-chain confusion into deterministic code responses. No prompt-rewriting required.

### 2026-04-15 — D1 Legacy `history.memory` deprecation ✅

Commit `7ee597e`. Finished the migration that commit `018e222` ("Add episodic memory with semantic retrieval replacing lossy summaries") started — episodic was added alongside the upstream kolbytn/mindcraft 500-char summary but never actually replaced it. With `use_context_builder: true` (fork default), conversation prompts route through episodic + long-term memory at ContextBuilder priority 6; the legacy `history.memory` was only read by the coding template's `$MEMORY` placeholder, produced one wasted LLM call every 5 turns, and generated the visible "Memory truncated to 500 chars" warning.

**Changes:**
1. `src/agent/history.js summarizeMemories()` — wrapped `promptMemSaving()` in a `settings.use_context_builder` guard. When CB is on, skip the LLM call entirely. `episodic.addEpisode()` still runs unconditionally (that's the real memory capture).
2. `ThatCoolGuyDude.json` + `profiles/defaults/_default.json` — removed `$MEMORY` from the `coding` template. Coding prompts route through `messages` + `$CODE_DOCS` + `$EXAMPLES` (episodic is already in the conversation turns).
3. `history.memory` field + `history.save()` persistence intact for backward compat with existing memory.json files.
4. `$MEMORY` resolution in `replaceStrings()` left in place — still available to other code paths if any new feature needs it.

**Post-deploy verification** (fresh 45s capture after restart): zero "Storing memories..." / "Memory truncated" log lines. Single memory-subsystem log line: `[EpisodicMemory] Stored episode ep-1544 (200 total)` — correct behavior. ContextBuilder budget line shows `mem:1832` tokens allocated, confirming memory is still being injected into prompts via CB's episodic+long-term paths.

**Unaffected:** bot personality (profile conversing template), rules (RULES section + persistent_rules), seeded memory (46 MC facts in `longterm_index/`), goals (self_prompt + goal_queue), recent conversation recall (EpisodicMemory), cross-session facts (LongTermMemory).

**Followups queued:** F (long-term memory population audit — is `store()` ever called outside seed?) and G (procedural/ConfidenceEngine activation audit — is bypass actually firing?) — both added to To-do queue.

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
