# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-19. HEAD `54a31b9` on `origin/develop`. **In-progress:** BT-10b — low-HP mob retreat (sub-item of #10 survival hardening, companion to BT-10a). Existing low-HP branch only fires within 3s of a damage event; doesn't cover the case where a hostile is chasing the bot but hasn't landed a hit yet, or where HP is critical and damage-cooldown elapsed. **Shipped today:** #22, #28, #22b, #23, #24, #29, #25, #7c, OPT-H, OPT-I (live verified), OPT-J, BT-7b, BT-7f, BT-10a. Eleven items awaiting live verification. Prior ship: **Self-prompter recoverable circuit-breaker** (2026-04-18)._

---

## Current state (live on develop)

**Deployment:**
- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft-mcgavin`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b` via LM Studio. Bot is **running** — StateTicker (BT-1), BootSnapshot (BT-8), LLM call telemetry (BT-3), DamageStream (BT-2), startup-window ordering fix (BT-12), MemoryRecall (BT-4), AutoRecovery stats (BT-5), Skill lifecycle (BT-7 + BT-7b), Goal lifecycle, and Pathfinder telemetry (BT-6) all verified live 2026-04-17.
- Branch: `develop` — HEAD `5f274f1`. Most recent ship 2026-04-18: self-prompter recoverable circuit-breaker + `stoppedReason` attribution + watchdog telemetry (see Recently completed). Prior nineteen ships on 2026-04-17: eighteen observability items (BT-1 through BT-12, BT-3b, BT-7b, Goal lifecycle, BT-bundle(a/b/c)) + one migration-discovered bug fix (#26 phantom self_defense). Two-tier observability story complete: lifecycle layer (BT-7+BT-7b skills + Goal + BT-6 paths) sits underneath measurement layer (BT-5 AutoRecovery stats); BT-11 closes the prompt-construction counterpart alongside BT-4. Migration phase has nothing trigger-gated remaining. See Recently completed for per-item detail.
- Bot settings: `minecraft_version: "1.21.4"` (translates through ViaBackwards 5.0.4 installed on server) and default host/port.
- Project docs live at repo root: `DESIGN_PHILOSOPHY.md`, `CODE_RULES.md` (7 rules; Rule 7 "Complete the perimeter" added 2026-04-15), `WHITEBOARD.md` (this file).

**Stability:**
- ViaBackwards holding (0 disconnects across multi-hour windows). Mutex balanced; all bot-mutating paths serialized via `withBotLock`.
- Survival: `maxDropDown=3`, `autoEat startAt=19`, `_configureTerrainSafeMovements` applied to every Movements instance we control.
- `self_preservation` reflex paths (drowning, sand/gravel, lava/fire, low-health flee) audited and confirmed mutex-bypass-safe via `interrupts:['all']`.
- Safe Movements Stage 1: `bot.collectBlock.movements` now configured with `maxDropDown=3 / digCost=10 / canSwim=true / terrain-safe` — no more straight-down vertical shafts during `!collectBlocks`. Full audit tracked under #12.
- Bot escapes spawn zone in 1 hop (226 → 265 blocks observed), 0 fall deaths post-hardening.

**Inventory management (final shape):**
- 5-tier classification priority chain in `snapshotInventory`: **SINGLETON_KEEPS → BED_GROUP → STACK_CAPS → TIERED_ITEMS → getItemValue**.
- SINGLETON_KEEPS (keep 1): crafting_table, furnace, bow, shield, flint_and_steel, bucket, water_bucket.
- BED_GROUP: 1 bed of any color across 17 variants.
- STACK_CAPS (keep 1 stack): 30+ resources/materials, ender_pearl capped at 16.
- TIERED_ITEMS: 9 roles × 6 tiers (pickaxe/axe/shovel/hoe/sword + helmet/chestplate/leggings/boots, netherite→leather). Only best tier owned per role is protected; lower tiers drain as junk.
- KEEP_ALWAYS (unlimited): non-tiered tools (bow, crossbow, shield, fishing_rod, flint_and_steel, shears), precious resources, ancient_debris, utility blocks, all 17 shulker_box variants.
- Tier 1 junk (drained): cobblestone/bulk stone/sandstone/soil variants, all 18 ore blocks (smelt to resource then drop), lava_bucket, chest.
- `autoDiscardAllJunk` drains everything in one pass on inventory-full, 3 distinguishable log labels (`N X` / `N extra X` / `N lower-tier X`).

**Protected zones (#7 shipped 2026-04-15):**
- Unified shape `{name, type: 'spawn'|'structure'|'village', x, z, radius, yMin?, yMax?}` checked by `_isInAnyProtectedZone` before any destructive op.
- Spawn zone (existing, 250-block radius, Y-agnostic).
- Manual zones from `player_structures.json` at repo root (stub committed, empty `structures` array; users add as needed; graceful loader handles missing/malformed files).
- Auto-detected villages (3 signals: ≥3 villagers clustered, ≥3 profession workstations clustered, any bell). 100-block radius, `yMin = centerY - 20`, `yMax = centerY + 30`. Periodic re-scan every 30s. Catches abandoned villages via workstations + bells even when no villagers remain.
- AutoRecovery pattern `inside_protected_zone` routes "near spawn" / "near protected structure" / "protected structure 'X'" errors through `ESCAPE_PROTECTED_ZONE` recovery (zone-aware, handles all zone types). `skipRetryLimit: true` — bot never gives up on escaping a protected zone.
- `escapeProtectedZone` replaces `escapeSpawnZone` as the primary escape function. Phase 1 delegates to `escapeSpawnZone` for spawn zones, phase 2 handles village/structure zones by walking away from the zone center using directional hops. Escape buffer is 50% of zone radius (e.g., radius 250 → target 375). `agent.js` spawn-event hook updated to call `escapeProtectedZone`.
- Perimeter plugged: `breakBlockAt`, `placeBlock`, `safeToss`, `autoBreakStuckPlant`, AND `collectBlock` all consult the zone check. `collectBlock` leak was caught post-deploy and fixed; motivated Rule 7.

**LLM interaction & memory:**
- ContextBuilder active (`use_context_builder: true`) — conversation prompts route through episodic + long-term memory at priority 6.
- D1 shipped: legacy `history.memory` 500-char summary deprecated when ContextBuilder is enabled. `promptMemSaving` call skipped; `$MEMORY` removed from coding template. Episodic capture still runs unconditionally. No more "Memory truncated" warnings.
- AutoRecovery `cannot_smelt` handler: classifies `!smelt("X")` failures into 4 groups — ore-drops-directly (Group A, tell LLM), ore-needs-raw-form (Group B, auto-correct), vanilla-smeltable (Group C), plus FURNACE_FUELS and SMELT_FINAL_PRODUCTS meta-confusion handlers.

**Observability (fully active on `develop` — see Recently completed for per-item ship detail):**
- `src/observability/` module tree; `data/*-stream.jsonl` is the JSONL sink convention.
- **Lifecycle layer:** BT-7+BT-7b skills (uniform `[Skill]` telemetry across 42 public skill exports in `src/agent/library/skills.js`), Goal lifecycle, BT-6 pathfinder (`[Path]` event stream).
- **Measurement layer:** BT-5 AutoRecovery match/miss rate.
- **Ambient state:** BT-1 StateTicker (1 Hz `[StateTicker]` pulse), BT-8 BootSnapshot (`[Boot]` per init + `data/boot-snapshot.json`), BT-9 World/time events (`[World]` weather/respawn/time_phase), BT-10 Entity delta stream (`[Entity]` spawn/gone/died, Map-gated).
- **LLM:** BT-3+BT-3b uniform `[LLM]` round-trip telemetry across every adapter in `src/models/*.js` (12 Shape A defaults + 7 Shape B custom extractors + Azure-inherits-from-GPT via `this.constructor.name`).
- **Memory:** BT-4 MemoryRecall (`[MemoryRecall]` per retrieval + `data/recall-stream.jsonl`), BT-11 ContextBuilder truncation decisions (inline drop/truncate log points under budget pressure).
- **Damage + death:** BT-2 DamageStream (`[Damage]` per health-decrease + inferred source priority classifier; on-death source attribution stored to long-term memory).
- **Infrastructure:** BT-bundle(a) mutex wait elapsed-ms appended to `[BotMutex]` queued-acquire log, BT-bundle(b) structured `[Exit]` lines on every shutdown path Node naturally reaches (`clean_kill` / `uncaught` / `unhandled_rejection` / `process_exit`), BT-bundle(c) file-I/O silent-swallow tightened across 5 files (one latent-bug fix on `prompter.js:134`).
- **Ordering:** BT-12 moved `startEvents()` + `StateTicker.start()` ahead of the spawn-escape await so the 45-60s escape window is captured.
- All emitters Rule-7 audited: zero bot mutation added across the entire observability surface.

**Open behaviors / active monitoring:**
- Bot respawned after goal cycle and is now self-prompting toward `mine 64 ancient debris` (resumed from saved memory). Position ~(-310, 62, -28) after spawn-zone escape; diamond/coal/stick stack still in inventory. Live [LLM] and [StateTicker] telemetry confirms the full observability layer is active during this run.
- No known crashes, no silent failures, all error paths log with structured prefixes.
- Known issues section on the whiteboard is **empty** (self_preservation mutex stale entry audited out; memory compression closed by D1; Cannot-smelt closed by handler; mob-combat-ranged folded into #10 Layer 2).

---

## In-progress

### BT-10b. Low-HP mob retreat (sub-item of #10 survival hardening)

**Status:** in-progress (code phase) • **Priority:** high (single-encounter death risk — bot can get run down by a chasing mob before a damage event lands, or burn through regen while mid-task)

**Problem.** Existing low-HP branch in `self_preservation` only fires when:
```js
Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)
```
Gaps:
1. **Pre-damage chase.** Zombie horde bearing down on bot at HP=4; bot hasn't been hit in 3s because the mobs are just out of melee range — existing branch won't fire.
2. **No hostile-directional retreat.** Current logic does `moveAway(bot, 20)` in a random safe direction; can retreat directly AT another mob.
3. **No persistence.** One-shot retreat; if bot stops in open terrain and hostiles close again, no re-trigger until next hit.

**Design (extend existing `self_preservation`).**

1. **New branch placed AFTER the existing damage-based low-HP branch.**
2. **Gate:** `bot.health < 6` AND `!bot._lowHpRetreatActive` AND a hostile exists within 12 blocks (via `world.getNearestEntityWhere(bot, mc.isHostile, 12)`).
3. **Action:**
   - Set `bot._lowHpRetreatActive = true` latch.
   - Log `[Survival] low-hp-retreat hp=<X> hostile=<type> dist=<Y>`.
   - `say(agent, 'Low HP — retreating!')`.
   - `execute()` → compute retreat direction = bot.position minus hostile.position (normalized), scaled to 16 blocks; pass to `skills.moveAwayFromEntity(bot, hostile, 16)` if available, else `skills.moveAway(bot, 16)`.
   - In the execute() cleanup, DO NOT clear the latch — leave it to a separate re-check branch.
4. **Latch clear:** add a short pre-branch at the top of `update()`: if `bot._lowHpRetreatActive` AND (`bot.health >= 14` OR no hostile within 12 blocks), clear the latch. Log `[Survival] low-hp-retreat cleared hp=<X>`.

**Files.**
- `src/agent/modes.js` — enhance `self_preservation.update()`. Single-site edit. Uses already-imported `mc.isHostile` and `world.getNearestEntityWhere`. No new imports.

**Blast radius.**
- One mode, one `update()` function. `interrupts:['all']` already set.
- No touch to combat (`self_defense`), pathfinder, or any skill.
- Latch on the bot (`_lowHpRetreatActive`) owned solely by this mode.
- While latched, the branch won't re-fire even if HP drops further — but the existing `moveAway` execute() is already in flight, so we're not racing.

**Guardrails.**
- HP threshold of 6 (3 hearts) is aggressive but reflects the #10 spec. High enough to trigger before a single mob hit finishes the bot; low enough not to panic on minor damage during normal combat.
- HP regen threshold of 14 (7 hearts) gives a clear hysteresis band so the bot doesn't oscillate.
- Hostile-directional retreat (not random moveAway) is the main improvement over the existing branch — retreating toward safety, not sideways.
- `mc.isHostile` explicitly excludes iron_golem / snow_golem so allied tamed mobs don't trigger retreat.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. No fan-out. No changes to combat mode, which continues to engage as usual at higher HP.

**Skip (explicit).**
- Separate "find shelter" behavior (tree/hill/safe-spot seek). That's #10 memory-based safe-pathing sub-item.
- Eat-food-while-retreating (auto-eat already shipped; food handling belongs with the food/sleep loop item).
- Ranged-attacker special case (that's a separate #10 sub-item — BT-10c candidate).

**Success signal (live verification).**
- Bot at HP<6 with a zombie within 12 blocks → `[Survival] low-hp-retreat hp=X hostile=zombie dist=Y` fires; bot moves 16 blocks AWAY from zombie.
- After regen to HP≥14 OR hostile wanders off → `[Survival] low-hp-retreat cleared hp=X` fires; latch cleared; bot resumes normal work.
- HP drops below 6 with no hostiles in range → branch does NOT fire (no retreat needed from environment).
- Existing damage-based branch preserved — still fires under its original conditions.


## Shipped — awaiting live verification

### BT-10a. Lava avoidance reflex (`3c31b78`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs bot to step into lava OR stand adjacent to a lava tile while idle; then observe the escape log + motor behavior)

**What shipped.** Single-site enhancement to `self_preservation` mode in `src/agent/modes.js`. Three new code paths, all gated inside the existing `update()` body; zero new imports, no new module, no other file touched.

**1. Primary lava-escape branch (`bot.entity.isInLava`).** Short-circuits BEFORE the existing `block.name === 'lava'` branch. On first entry:
- Sets `bot._lavaEscapeActive` latch (dedup for the log line).
- Scans 4 cardinals at feet level (`position.offset(±1, 0, 0)` and `±z`); picks first neighbor whose feet-block is NOT `lava/fire/void_air` AND whose head-block is `air/cave_air`.
- Logs `[Survival] lava-escape dir=<N/S/E/W|none> has_water=<bool>`.
- `say(agent, 'Lava! Getting out!')`.
- `bot.lookAt(target, true)` toward chosen direction.
Every tick while submerged: `setControlState('jump', true)` + `setControlState('forward', true)`. Parallel: `execute()` to `skills.placeBlock(bot, 'water_bucket', ...)` if inventory has one, with try/catch so placement failure doesn't block the motor escape.

**2. Preemptive edge-detect.** After the existing lava/fire branch closes, a new branch fires only when `agent.isIdle() && !bot._lavaEdgeBackoffActive`. Checks 4 XZ cardinals at feet level for `lava` or `fire` names; if found:
- Sets `_lavaEdgeBackoffActive` latch (clears in the execute() cleanup).
- Logs `[Survival] lava-adjacent moving away`.
- `say(agent, 'Too close to lava — backing up.')`.
- `execute(this, agent, async () => { await skills.moveAway(bot, 2); })`.

**3. Latch cleanup.** The idle branch at the bottom of `update()` now clears `_lavaEscapeActive` when `!bot.entity.isInLava` so future lava episodes trigger the log fresh.

**Blast radius.**
- One file, one mode, one `update()` function. No touch to pathfinder, combat, other modes, or skills.js.
- Mode was already `interrupts:['all']` so combat/pathing yields to lava-escape automatically.
- Existing lava/fire branches preserved verbatim for the surface-splash and ceiling-drip cases.

**Verification signals to watch.**
- **isInLava trigger:** bot falls into a lava column → `[Survival] lava-escape dir=<X> has_water=<bool>` line appears in stdout; bot jumps, faces chosen direction, walks out. Log fires once per episode (not per tick).
- **Edge-detect trigger:** bot stands idle with lava in an adjacent block → `[Survival] lava-adjacent moving away` fires, bot moves 2 blocks away.
- **Existing behavior preserved:** bot takes a lava-splash on the head (no `isInLava`) → `I'm on fire!` say + water-bucket/moveAway path still runs.
- **Latch reset:** after escape, bot idles on safe ground → `_lavaEscapeActive` clears (verifiable on next lava entry, log fires again).

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. No parallel sites, no fan-out. Sole state introduced lives on the bot: `_lavaEscapeActive` + `_lavaEdgeBackoffActive`, both owned by this mode.

**Skip (explicit).**
- Pathfinder `Movements` cost-penalty for lava (separate #10 sub-item).
- Magma-block damage reflex (different heuristic — non-burning contact damage).
- Memory of prior lava-death locations (long-term #10 item; needs persistence design).

**Companion gap (deferred).** Water-bucket placement inside the escape branch still respects the existing `skills.placeBlock` zone-guard — inside spawn protection the placement will no-op silently. Motor escape (jump + forward) runs regardless, so the bot still gets out; it just doesn't get the free water-cooling effect. Acceptable.


### BT-7f. Close doors/fence gates the bot opened (`6c18197`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs bot to pathfind through a door or execute `!activate` on one; then observe the close 3+ blocks away with no player nearby)

**What shipped.**
- NEW `src/observability/door_tracker.js` (~195 lines) — closure-state module mirroring `placement_tracker.js` shape. Public surface: `configureDoorTracker()`, `hookDoorTracker(agent)` (idempotent via `bot._hookedDoorTracker` reference-identity gate), `getDoorStats()`, `recordDoorClose()`, `doorHelpers` (re-exported `isTrackable`/`isOpen` predicates for the close mode).
- `src/agent/modes.js` — new `close_doors` mode inserted before `cleanup_blocks`. Idle-only (`interrupts:[]`), min_distance 3, player_guard 3, one close per tick, re-verifies block identity + open state before activating.
- `src/agent/agent.js` — `hookDoorTracker(this)` wired after `hookPlacementTracker`, before `escapeProtectedZone`.

**Attribution mechanism.** The hook monkey-patches `bot.activateBlock`. On call, if the target block is a trackable door/gate, the wrapper samples open-state BEFORE the upstream call, then re-reads the block afterward. If state flipped closed→open, push `{x, y, z, type, t}` to `bot._openedDoors`. Pathfinder's auto-open calls go through `bot.activateBlock` internally; LLM `!activate` commands use the same path. Player-opened doors never touch this method and are never tracked.

**Scope (trackable).**
- Wooden doors: every `*_door` name EXCEPT `iron_door` (which can't be toggled by right-click).
- Fence gates: every `*_fence_gate` name.
- Trapdoors and iron doors: **not tracked** (out of scope).

**Close mode logic.**
1. Pick oldest entry in `bot._openedDoors`.
2. Skip if distance(bot, door-center) ≤ 3 blocks.
3. Skip (but retry next tick) if any non-bot player entity within 3 blocks of the door — logged as `close-skipped reason:"player-nearby"`.
4. Re-read block via `bot.blockAt`. If no longer a door/gate → splice + `reason:"not-trackable"`. If already closed → splice + `reason:"already-closed"`.
5. Call `bot.activateBlock(blk)`. Splice entry regardless of outcome to avoid retry loops. Record `event:"closed"` on success, `event:"close-skipped" reason:"activate-threw"` on error.

**No protected-zone skip.** Deliberate: closing doors inside player bases is *exactly* what we want (keeps mobs out at night). The zone guards that exist for destructive primitives (`breakBlockAt`, `placeBlock`) don't apply here — `activateBlock` on a door toggles a state bit, it doesn't break or change the world structure.

**Blast radius.**
- `bot.activateBlock` wrapper is transparent: delegates to the original via `_origActivateBlock`, returns the same value, no extra latency beyond a `getProperties()` read. Idempotent via the outer `_hookedDoorTracker` gate.
- New mode: `interrupts:[]`, one close per tick, no preemption.
- No touch to pathfinder, no touch to existing skills, no touch to protected-zone logic.

**Verification signals to watch.**
- **Opened record:** pathfinder routes the bot through a village door → `data/door-stream.jsonl` grows one `event:"opened"` line with correct coords/type.
- **Closed record:** bot moves >3 blocks past the door, no player standing next to it → `event:"closed"` follows; door visually shuts in-world.
- **Player-nearby guard:** player stands next to a bot-opened door → repeated `event:"close-skipped" reason:"player-nearby"` lines; door stays open until player leaves.
- **Player-opened door ignored:** player opens a door near the bot → no `opened` record (player's action didn't flow through `bot.activateBlock`).
- **Death clears:** bot dies with doors in tracker → `[Doors] death — cleared N tracked doors` log; list resets.

**Rule 7 audit.** Single perimeter for the tracker module. Mode + agent wiring are parallel single-site additions that meet only at `bot._openedDoors` (new field) and `recordDoorClose` (new export). No fan-out.

**Skip (explicit).**
- Retroactive closing of pre-existing open doors in the world.
- Trapdoors (can revisit if bot starts using them).
- Iron doors (no toggle path exists).
- Doors the player opened (not our state to manage).

**Companion gap (deferred).** If the bot opens a door and dies inside the house, the tracker clears on respawn — so the door stays open until someone manually closes it. Acceptable trade for the simplicity of the clear-on-death invariant.


### BT-7b. Self-cleanup of incidental block placements (`67d8d82`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs bot to naturally produce a pathfinder scaffold, or operator `!placeBlock` for the `intentional` path; then wait 30s + bot-moves-5-blocks to observe cleanup)

**What shipped.**
- NEW `src/observability/placement_tracker.js` (+191 lines) — closure-state observability module mirroring `path_telemetry.js` shape exactly. Public surface: `configurePlacementTracker()`, `hookPlacementTracker(agent)` (idempotent via `bot._hookedPlacementTracker` reference-identity gate), `getPlacementStats()`, `recordCleanup()`.
- `src/agent/library/skills.js` — `_impl_placeBlock` body wrapped in `try { bot._placeIntent='intentional'; ... } finally { bot._placeIntent = null; }` so the blockPlaced handler can distinguish LLM-driven calls from pathfinder scaffolding.
- `src/agent/modes.js` — new `cleanup_blocks` mode (idle-only, `interrupts:[]`, min-age 30s, min-distance 5 blocks from bot, at most one break per tick, uses `skills.breakBlockAt` which enforces protected-zone guard).
- `src/agent/agent.js` — `hookPlacementTracker(this)` wired after `hookPathTelemetry(this)`, before `escapeProtectedZone`.

**Purpose taxonomy.** Every `blockPlaced` resolves to exactly one of:
1. `intentional` — `_impl_placeBlock` set the flag → never cleaned up.
2. `torch` — head of `bot.placedTorches` matches coords → skipped (torch logic owns it).
3. `pathfinder-scaffold` — `bot.pathfinder.isMoving()` returned true at event-time.
4. `unknown-llm` — everything else (default).

**Streams.** `data/placement-stream.jsonl` gets one line per placement (`event:"placed"`) and one per cleanup attempt (`event:"cleaned"` or `"cleanup-skipped"`).

**Blast radius.** New module is additive (zero touch to existing code paths). The `_impl_placeBlock` try/finally is a single-function change — the private `_placeIntent` sentinel has no other reader in the codebase. The new mode follows the existing mode contract and `interrupts:[]` means it can never preempt running work. Agent wiring is one import + one hook call, directly parallel to the existing `hookPathTelemetry` block.

**Verification signals to watch.**
- **Placed event:** `data/placement-stream.jsonl` grows by one line per block the bot puts down; `purpose` field populated.
- **Intentional path:** `!placeBlock dirt X Y Z` from chat → stream shows `purpose:"intentional"`. Wait 60s and confirm no `cleaned` event for those coords.
- **Scaffold path:** next time the bot digs down and pillars back up (or pathfinder adds a bridge block), stream shows `purpose:"pathfinder-scaffold"`. After the bot has moved on (>5 blocks) and 30s elapsed, a `cleaned` event follows and the block is broken.
- **Zone guard:** placements inside the spawn protection zone (250-block radius around `bot.spawnPoint`) that somehow land in the tracker will be refused by `breakBlockAt` — `ok:false` in the cleanup record; the entry is spliced either way (no retry loop).
- **Death clears:** die to a mob / lava → `bot._placedBlocks` drops to `[]` and the `[Placement] death — cleared N tracked placements` log line appears.
- **Cap holds:** `bot._placedBlocks.length` never exceeds 200 under any live play conditions.

**Rule 7 audit.** Single perimeter for the tracker module. The mode, the agent wiring, and the skills.js intent-flag edit each form their own single-site change. Pieces meet at two new bot-level fields: `bot._placedBlocks` and `bot._placeIntent`. No fan-out; every reader/writer is in one of the three touched files.

**Skip (explicit, for honesty).**
- **Retroactive cleanup** of existing scaffolds already in the world — only tracks from the ship forward. JP can manually clear pre-existing scaffolds.
- **Spawn-block purpose** from the original sketch — dropped from v1 (the spawn path doesn't currently place blocks). Revisit if that changes.
- **Cross-dimension safety** beyond the death/respawn clear — if the bot nether-portals without dying, the stale coords will fail the `blockAt` name-match check and get spliced on first scan (soft-correct, one-tick cost per stale entry).

**Companion gap (already-shipped-related).** None. BT-7b's cleanup *uses* `breakBlockAt`'s existing zone guard — no duplication.



### 7c. Heuristic auto-detection of player-built structures (`0ff5c29`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs JP to build a structure with ≥6 player-characteristic blocks within 12 blocks of each other AND for the bot to be within 64 blocks during a scan pass; can be smoke-tested by placing a quick test cluster near the bot)

**Change.** Three additions, all mirroring the village-detector pattern:

1. **New module block in `src/agent/library/skills.js`** (inserted after the village exports). Declares `PLAYER_CHARACTERISTIC_BLOCKS` (curated allowlist) + six tunable constants (`PLAYER_SCAN_RADIUS=64`, `PLAYER_CLUSTER_RADIUS=12`, `PLAYER_MIN_SIGNALS=6`, `PLAYER_PROTECT_RADIUS=40`, `PLAYER_Y_BELOW=20`, `PLAYER_Y_ABOVE=30`, `PLAYER_DEDUP_RADIUS=30`). Helpers: `_playerBaseAlreadyRegistered`, `_playerBaseZoneFromCenter`. Main function `detectNearbyPlayerStructures(bot)`:
   - Resolves block-name allowlist → numeric id Set (skips blocks missing from this mineflayer data version).
   - `bot.findBlocks(matching: idSet, maxDistance: 64, count: 512)` → candidate positions.
   - Reuses `_clusterPositions(positions, 12)` helper from the village detector (no duplication).
   - For each cluster with count ≥6 and not already registered within 30 blocks: pushes zone `{name: 'player_base_<x>_<z>', type: 'player_base', x, z, radius: 40, yMin: y-20, yMax: y+30, source: 'auto-detect (<N> signals)'}` to `bot.protectedZones`, logs the registration.

2. **New scanner `startPlayerStructureScanner(bot)`** — 10s initial delay (longer than village's 5s because player-characteristic blocks live deeper in chunk data and first-pass chunk load may not include far blocks), then 30s `setInterval`. Wrapped in try/catch on both fire paths. Exports: `detectNearbyPlayerStructures`, `startPlayerStructureScanner`.

3. **Wiring in `src/agent/agent.js`** — right after the village-scanner startup block, same shape: `clearInterval(this._playerStructureScanInterval)` guard then `this._playerStructureScanInterval = skills.startPlayerStructureScanner(this.bot)`. Error log tagged `[PlayerStructureScan]`.

**Block allowlist (curated).**
- Stone bricks family + polished stones (stone_bricks + 3 variants + polished_granite/diorite/andesite/blackstone/blackstone_bricks)
- All wood doors (11 variants) + iron_door
- Glass panes: glass_pane + 16 stained_glass_panes
- All 16 wool colors
- All 16 concrete colors
- Redstone mechanisms: redstone_lamp, redstone_torch, repeater, comparator, piston, sticky_piston, observer, hopper, dispenser, dropper, lever, note_block
- All 16 banner colors
- All 16 bed colors

**Deliberately excluded:** torches / crafting_tables / chests / furnaces (village detector's workstation signal handles these — player-built kitchens next to a villager-workstation would double-fire otherwise). Item frames (entities, not blocks — different scan path). Stairs/slabs (too generic — stone stairs appear in strongholds, wood slabs in witch huts).

**Why this closes the gap.** Post-#7, `player_structures.json` is still manual. JP has to remember to add every build by hand — and the bot keeps trying to mine blocks in a base JP just built until that file is updated and the bot is restarted. With #7c, any substantial player build (6+ signals within 12 blocks — i.e. a wool-floored shelter, a stone-brick tower, a redstone contraption) is auto-registered within 40s worst case (10s initial + 30s cadence) once the bot comes within 64 blocks.

**Guardrails.**
- Curated allowlist is strongly-player-characteristic (min signals = 6, not 3) — reduces false positives. Stone bricks + wool + redstone cluster does not appear in vanilla terrain.
- Dedup radius 30 blocks (larger than protect radius 40 might seem to imply, but the dedup is center-to-center — this prevents registering overlapping player_base zones for adjacent rooms of one base).
- Initial delay 10s (vs. village's 5s) because player-characteristic blocks live in chunk block-data rather than entity data — chunk population on spawn can lag.
- Try/catch around `bot.findBlocks` and the full scan — no throw propagates.
- Interval-cleanup guard in agent.js — soft reconnects don't leak timers.
- Allowlist resolved to id Set once per scan — `findBlocks` filter is O(1) lookup.

**Rule 7 audit.** Single new module block in skills.js, single new wiring site in agent.js. Reuses existing `_clusterPositions` helper rather than redefining. All tunables live at the top of the new block, not leaked. No touch to village detector, no touch to zone-dispatch, no touch to spawn-escape logic. Exports follow the same `export { ... }` shape as village scanner.

**Verification signals to watch.**
- After bot spawns, expect within 40s (first scan at 10s + 30s periodic) one of:
  - No logs (scan ran, no clusters above threshold — the 99% case for wilderness spawns).
  - `[PlayerStructureScan] Detected player-built cluster at (x, z) — N signals; registering zone player_base_<x>_<z> (radius 40)` — each time a new cluster qualifies.
- Next breakBlockAt / placeBlock attempt by LLM or pathfinder inside a newly-registered `player_base` zone — expect the existing zone guard to refuse.
- Re-scans of the same area should produce ZERO `Detected` logs after the first hit (dedup holds).

**Companion ship.** Complementary to #7 (village auto-detect) — villages handled via entities + workstations + bells; player bases now handled via block-cluster signature. Between the two, `bot.protectedZones` populates automatically for both vanilla and player-built protectables.

**Deferred (may promote later).**
- Tuning pass: if false positives appear (e.g. rare stone-brick ruin with 6+ signals auto-registering) bump `PLAYER_MIN_SIGNALS` to 8 or narrow allowlist. Wait for observed data.
- Item-frame signal: strong player marker but needs `bot.entities` scan, not `findBlocks`. Cleaner to add as a second signal source in a follow-up if cluster-from-blocks alone misses decorated-but-sparse bases.
- Zone retirement: if JP demolishes a player base, the zone stays registered forever. Belongs with a periodic zone-health-check task (would verify the signal cluster still exists on each scan tick and retire zones when signal count drops below threshold) — separate BT.
- Auto-persist to `player_structures.json` so restarts don't re-scan: intentionally NOT added. Scan is cheap (30s cadence, O(512) findBlocks budget), and auto-rescan means a newly-placed structure is protected even without restart.


### 25. `!addRule` armor/durability pattern + `replaceBrokenArmor` skill (`4cae55d`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs JP to register an armor-break rule via chat AND for an equipped piece to drop below 20% durability; can be smoke-tested by spawning the bot with damaged armor in creative or by riding a goal that wears armor down)

**Change.** Three coordinated additions:

1. **New skill `replaceBrokenArmor(bot)`** (src/agent/library/skills.js, ~100 lines added after the `equip` export). Scans equipped armor slots 5/6/7/8. For each piece below 20% durability:
   - Searches main inventory for a same-or-better-tier replacement (`leather` < `chainmail` < `iron` < `golden` < `diamond` < `netherite`) that itself has >20% durability. If found, `bot.equip(item, bodyPart)`.
   - Else: attempts `craftRecipe(bot, '<tier>_<piece>', 1)` for the same tier, then equips if a fresh item appeared in inventory.
   - Re-entry throttle via `bot._lastArmorReplace` (5s cooldown) prevents craft-loop spam since the rule fires every self-prompter iteration.
   - Per-piece try/catch around `bot.equip`; craft fallback in its own try/catch. All failure modes log via `log(bot, ...)` and do not throw.

2. **New `!replaceBrokenArmor` command** (src/agent/commands/actions.js, registered right after `!equip`). No args. Calls `skills.replaceBrokenArmor(agent.bot)`.

3. **New armor/durability case in `!addRule.perform`** (src/agent/commands/actions.js). Keyed on `armor|armour|durability`:
   - **Condition:** scans slots 5–8 for any equipped piece at <20% durability → returns true.
   - **Action:** `!replaceBrokenArmor`.

**Why this closes the gap.** JP's 2026-04-17 chat — "add a new rule, if any part of your diamond armor breaks, make a replacement corresponding diamond armor and equip it" — had nowhere to land in `!addRule`'s dispatch. The description would fall through to `conditionFn = () => true` (fires every tick forever) and `action = '!searchForBlock("diamond_ore", 64)'` — wrong on both axes. Even if BT-24 had landed in time and the LLM had emitted `!addRule(...)`, the resulting rule would have been useless. With this patch, the same description registers a real durability-aware condition and a real corrective action.

**Guardrails.**
- Re-entry throttle (5s) on `bot._lastArmorReplace` keeps the rule from spamming craft attempts when self-prompter ticks fast.
- Replacement search skips items that are themselves at <20% durability — no swapping broken-for-broken.
- Equipped slot (5/6/7/8) excluded from replacement scan — cannot accidentally "equip" the already-equipped broken item.
- Tier comparison uses prefix matching (`leather_`, `iron_`, etc.) — won't confuse `iron_helmet` with `iron_pickaxe` because `_armorTier` only ranks the prefix, and the suffix gate (`item.name.endsWith('_' + piece.suffix)`) ensures only matching armor pieces are considered.

**Rule 7 audit.** Single dispatch case in `!addRule`, single new skill, single new command registration. Tier-ranking table (`ARMOR_TIERS`) and slot-mapping table (`ARMOR_PIECES`) live inside the new skill, not leaked. No cross-module fan-out, no touch to existing rules dispatch model.

**Verification signals to watch.**
- JP chat: `!addRule("if any part of your diamond armor breaks, make a replacement and equip it")` → expect `Persistent rule #N added: "..." → !replaceBrokenArmor` (note the action no longer reads `!searchForBlock("diamond_ore", 64)`).
- When an equipped piece drops below 20% durability, expect on the next self-prompter iteration: `[ReplaceArmor] <piece> (<itemName>) at NN% durability — looking for replacement` followed by either `[ReplaceArmor] Equipped <itemName> in <bodyPart> slot` (in-inventory swap), or `[ReplaceArmor] Crafted and equipped <name>` (craft path), or `[ReplaceArmor] Craft of <name> did not produce inventory item (missing ingredients or no nearby crafting table)` (failure path).
- No `[ReplaceArmor]` log spam — lines should appear at most once every 5 seconds even though the rule fires every tick.

**Companion ship.** #24 (`0b2e0df`) closed the player-chat-invisibility path that originally killed this rule attempt on 2026-04-17. #25 closes the dispatch-pattern gap so when the player chat does land, `!addRule` produces a usable rule.

**Deferred (may promote later).**
- Empty-slot bootstrap: if a slot is unequipped (e.g., bot has never had a helmet), the current condition won't fire. Could add a parallel rule like `!ensureBestArmor` that crafts/equips the best available tier per slot regardless of durability. Not in scope here — JP's request was specifically about replacement on break.
- Tier auto-upgrade: if the bot has a netherite chestplate sitting in inventory and is wearing a worn diamond chestplate at 50% durability, the rule won't fire (durability >20%). Belongs with a separate "always wear best armor" rule pattern.


### 29. `autoBreakStuckPlant` vertical-scan extension — dy=-1 and dy=2 added (`a6a3e9b`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs a tree-canopy spawn or low-leaf-ceiling stuck event to fire; JP needs to `/kill` the currently-stranded bot for the next natural spawn to exercise the new path)

**Change.** Extended the offsets array in `_impl_autoBreakStuckPlant` (src/agent/library/skills.js) from 16 offsets (8 horizontal at dy=0, 8 horizontal at dy=1) to 34 offsets across four Y layers:
- `dy=-1` (below feet): 9 offsets including `[0,-1,0]` directly below — catches bot standing on a leaf canopy.
- `dy=0` (feet level): 8 horizontal neighbors (unchanged).
- `dy=1` (head level): 8 horizontal neighbors (unchanged).
- `dy=2` (above head): 9 offsets including `[0,2,0]` directly above — catches bot stuck under a low leaf ceiling.

**Why this closes the gap.** On 2026-04-19 ≈19:15Z bot spawned on top of a tree at (-84, 80, 61). `autoBreakStuckPlant` correctly identified `oak_log` as a tree part inside spawn zone and skipped it (per `d051ab1` allowlist). But the leaves at y=79 — the only breakable candidates that would have let the bot fall — were one block below the feet-level scan and so invisible to the skill. Pathfinder has `canDig=false` inside spawn zone, so it can't plan a dig either. Net result: scan returns no candidates, skill aborts, bot stranded indefinitely.

With the extended scan, the same scenario goes: bot finds `oak_leaves` at `(x, y-1, z)` (or one of the 8 diagonal-below offsets), `MOVEMENT_BLOCKING_PLANTS` matches inside zone → break → bot falls one block → next tick re-scan. Repeats until the bot drops below the canopy and pathfinder can take over.

**Guardrails.**
- `SOLID_GROUND_BLOCKS.has()` hard-skip already covers the "standing on dirt/grass_block/stone" case — `dy=-1` returns before the plant-check on those blocks. No risk of digging into terrain.
- Same allowlist as before (`PLANT_LIKE_PATTERN`, `TREE_PART_PATTERN`, `MOVEMENT_BLOCKING_PLANTS` shipped `d051ab1`). Logs/wood/structural tree parts still skipped inside spawn zone.
- Existing per-block 30s blacklist cooldown unchanged — failed-dig retries throttled.
- Reactive only — fires when pathfinder reports stuck. Bot still cannot proactively chew leaves during normal in-zone travel.

**Rule 7 audit.** Single offsets array inside a single function. No cross-module fan-out. The `d051ab1` zone-aware allowlist (the perimeter for what's safe to break in spawn zone) was already complete; this patch just extends the geometry of where the scan looks.

**Verification signals to watch.**
- Next tree-canopy spawn (or any stuck-on-canopy event): `[AutoBreakPlant] Breaking movement-blocking oak_leaves inside spawn zone at (x, y-1, z)` → bot falls → scan repeats → lands on solid ground → escape-zone hops resume.
- Or a low-leaf-ceiling stuck event: same log shape but at `(x, y+2, z)`.
- No new `[AutoBreakPlant] Refusing to break tree-part oak_log` for any block at `dy=-1` or `dy=2` — confirms zone-aware allowlist still gating logs correctly at the new layers.

**Companion ship.** Complementary to `d051ab1` (which expanded the WHAT — leaves became breakable in zone) — this patch expands the WHERE (now scans below feet and above head, not just feet+head horizontals).

**Deferred (may promote later).**
- Pathfinder-level `canDig=true` + `safeToBreak` override inside spawn zone for leaves only. Rejected for now — higher blast radius (would proactively plan leaf-chewing during normal travel, not just when stuck). Revisit if the reactive layer proves insufficient.
- Stuck-on-spawn detection at AutoRecovery layer (timeout-based escape kick). Different bug class — belongs with #10.


### 24. Self-prompter yields to queued player chat before next self-prompt (`0b2e0df`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs a natural stuck-command pattern + concurrent player chat to fire; can also be smoke-tested by JP sending chat during any active self-prompt goal)

**Change.** Added a top-of-loop drain block in `SelfPrompter.startLoop` (src/agent/self_prompter.js), positioned after the #23 ChunkWait gate and before the persistent-rules check. If `_playerMsgQueue` has anything, each message is drained via `handleMessage(username, msg)` in sequence — each gets a dedicated LLM turn with `source=username` rather than `'system'`. After draining, `no_command_count` and `_consecutiveNoProgress` are reset and the loop `continue`s (skipping the self-prompt this tick). Log: `[SelfPrompter] yielding to player message from <user>`. Re-entry is guarded by the existing `_processingPlayerMsg` flag.

**Why this closes the gap.** Before this change, `_playerMsgQueue` was drained AFTER the self-prompt LLM call. So when a player spoke mid-generation (or during the cooldown sleep), the in-flight LLM had zero visibility into what they said relative to the stuck pattern it was already pattern-completing. Net effect on 2026-04-17 ≈19:00Z: bot was in `!digDown(10)` → "dangerous drop ahead, 0 blocks dug" loop; JP sent `!addRule(...)` chat via `Bones_McGavin`; chat received in tmux but never acted on, zero `[PersistentRule]` logs, `memory.json persistent_rules: []` after the save. With top-of-loop drain, the rule message would have been the NEXT LLM turn (as a player message, not a system self-prompt), the LLM would have executed `!addRule`, and the rule would have been added before any new dig-down ran.

**Guardrails.**
- Optional chaining (`this.agent._playerMsgQueue?.length`) safe if queue isn't initialized yet.
- `_processingPlayerMsg` flag prevents re-entry if the bottom drain is still running.
- Counter resets prevent any cascade into #23's circuit-breaker STOPPED-with-null-self_prompt path — player turns are first-class, not just noise to be counted against the self-prompt.
- Existing bottom-of-loop drain kept as a safety net for messages that arrive during the LLM self-prompt round-trip itself. Both drains shift the same queue; no double-processing.

**Rule 7 audit.** Single site (top of `startLoop` while-body, immediately after the #23 gate's "hold released" log block). All downstream LLM calls in this loop (persistent-rules check, self-prompt `handleMessage`, no-command counter) sit under it. Player-chat handlers OUTSIDE this loop (`agent.js:respondFunc` immediate-response path and the queuing path when `prompter.awaiting_response`) are intentionally unchanged — those were never the bug.

**Verification signals to watch.**
- Next time JP sends chat while self-prompter is ACTIVE mid-goal: `[SelfPrompter] yielding to player message from Bones_McGavin` in tmux before any new self-prompt LLM call.
- `!addRule` / `!goal` / player-requested command actually appears in the rotated history file AND executes (look for `[PersistentRule]` / `[Goal]` logs).
- No `[Goal] event=end ... reason=circuit_breaker` fires from player-chat-only turns — counters reset correctly.

**Companion ship.** #23 (`933ee16`) closed the goal-loss path during NaN windows. #24 closes the player-ignored path during stuck-command patterns. Together the self-prompter loop now: (a) backs off when it has nothing actionable to say, (b) yields cleanly when the player has something to say, (c) keeps counters sane so neither path walks into the circuit-breaker.

**Deferred (may promote later).**
- Chat-aware prompt prefix ("A player just said: X — address it before continuing."). Probably unnecessary — player message is already in history as its own turn. Revisit only if verify shows LLM still pattern-completes past the player turn on stuck goals.
- Stuck-loop detection (same command N times in a row). Different bug class — belongs with #10 survival hardening.


### 23. Self-prompter held-state back-off during ChunkWait/NaN windows (`933ee16`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs the next natural ChunkWait hold while self-prompter is ACTIVE — suffocation recovery, reconnect window, or any NaN-position event)

**Change.** `SelfPrompter.startLoop` (src/agent/self_prompter.js) now gates its while-body on `this.agent.chunk_wait.isHeld()`. While held, the loop sleeps 1s and `continue`s — skipping the persistent-rules check, the LLM `handleMessage` call, and the `no_command_count` increment. Added `_heldLogged` flag in the constructor for edge-triggered logging: `[SelfPrompter] held — backing off (reason: ...)` on enter, `[SelfPrompter] hold released — resuming` on exit. No log spam during the hold window.

**Why this closes the gap.** On 2026-04-17 during a 60s ChunkWait hold, the loop fired 3+ `handleMessage` calls with no valid world state to reason about. Each returned no command → `no_command_count` reached `MAX_NO_COMMAND=3` → circuit-breaker fired → `state = STOPPED` → `history.save()` serialized `self_prompt: null`. Next restart loaded the null and the "mine 64 ancient debris" goal was gone. Persistence was working correctly; the bug was upstream. With this gate in place, the counter stays frozen for the duration of the hold, `state` stays `ACTIVE`, and the goal survives the NaN window intact.

**Guardrails.**
- Optional chaining (`this.agent?.chunk_wait?.isHeld?.()`) keeps the check safe if `chunk_wait` isn't initialized yet or is missing entirely.
- 1s poll during hold vs. the 2–10s self-prompter cooldown — resumes quickly once chunks load / position becomes finite.
- `_heldLogged` flag ensures exactly one enter/exit log per hold, not one per poll tick.

**Rule 7 audit.** Single site: top of `startLoop` while-body. All three failure modes (LLM round-trip, no-command counter advance, persistent-rule action) sit downstream of the gate. Player-chat and system-event `handleMessage` calls that don't route through this loop are intentionally unaffected — those are #24's territory (stuck-loop interruption on player chat).

**Verification signal to watch.** Next ChunkWait hold with self-prompter active:
- `[ChunkWait] ENTER held state` → `[SelfPrompter] held — backing off (reason: ...)`.
- Zero `handleMessage` or `[LLM]` round-trips during the hold window.
- `state` stays `ACTIVE`; `memory.json` save during the window still reflects the active goal (`self_prompt` non-null, `self_prompting_state: 1`).
- `[ChunkWait] EXIT held state` → `[SelfPrompter] hold released — resuming` → loop returns to normal cadence.

**Companion ships.** #22 (`8c2b6fe`) + #22b (`d921016`) close the death path during NaN windows; #23 closes the goal-loss path. Together they mean the bot can now survive AND retain its goal through a ChunkWait hold.


### 22b. `escapeProtectedZone` current-position suffocation — NaN-position recovery (`d921016`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs a natural NaN-suffocation event to fire; can't be reliably reproduced without a specific mob-shove / fall-into-pocket scenario)

**Change.** Extended `_installSpawnEscapeInstrumentation` in `src/agent/library/skills.js`. New closure-scoped state (`_suffocLastGoodPos`, `_suffocFirstTickMs`, `_suffocTickCount`, `_suffocStageARan`, `_suffocStageBRan`, `_suffocJumpTimer`). The existing `health` listener now detects the suffocation signature: a health drop while `bot.entity.position` is non-finite (NaN window). First NaN-drop starts the counter; ≥3 ticks within 2s triggers **Stage A** (cancel pathfinder goal, clear all control states, `setControlState('jump', true)` pulsing every 250ms for 2s). If NaN damage persists ≥3s from the first tick, **Stage B** fires `bot.chat('/kill')` for clean respawn. State resets on `respawn`. A new `bot.on('physicsTick', _suffocSamplePos)` keeps `_suffocLastGoodPos` fresh at 20Hz for Stage B logging.

**Why this closes the gap.** BT-22's pre-move passability guard protects the *target* block, so pathfinder never commits into solids. But the bot's *current* hitbox can still end up wedged — mob shove, fall into a pocket, pathfinder glitch depositing it between block boundaries. During that window `bot.entity.position` is NaN, the DamageStream classifier can't attribute a source, and 11 consecutive 1.58-dmg/tick suffocations killed the bot on 2026-04-19 17:50:37–50Z during BT-22/BT-28 live verification. The `/kill` fallback is brutal but deterministic: items drop at the current tile, bot respawns at spawn, the spawn-side `escapeProtectedZone` fires cleanly, net-negative vs. a guaranteed death.

**Guardrails.**
- Detection requires BOTH health-drop AND non-finite position — normal mob hits at finite positions never trigger.
- 2s rolling window — single stray NaN-drops from server-side weirdness don't escalate.
- `_suffocStageARan` flag prevents re-entry during the 2s jump window.
- Stage B only after Stage A has had ≥3s to work — stage A's jump-spam gets a fair chance first.
- `respawn` handler resets all state so subsequent sessions start clean.

**Rule 7 audit.** Single site (existing `health` listener inside `_installSpawnEscapeInstrumentation`). No fan-out. Module-state, helpers, and detection logic all live in the same closure. One new event subscription (`physicsTick` for position sampling) — Rule 7 invariant holds: no bot mutation added outside the suffocation-recovery path.

**v1 deferred (may become v2 if evidence warrants).**
- `bot.dig` rescue at `_lastGoodPos` head/feet — probably fails during NaN (no valid entity position for aim). Skipped until we see a NaN window survive long enough to test it.
- `damageStream.getLastDamage()` integration — NaN-position-during-drop is already a specific enough signature; adding `source:unknown` check is redundant and would require an import chain.
- Server `/back` or `/spawn` alternative to `/kill` — depends on op status and server config, unverified.

**Verification signals to watch.**
- `[SuffocationRecovery] detected` followed by either:
  - `[SuffocationRecovery] recovered — position finite` (best case, Stage A worked), OR
  - `[SuffocationRecovery] stage_b — self-kill via /kill (last good pos: ...)` + subsequent `[SpawnEscape][EVENT] respawn` (acceptable case, fallback engaged).
- Next session's `data/damage-stream.jsonl`: zero multi-tick `source:"unknown" pos:null` lethal sequences.

**Sibling ships for cross-reference.** #22 (`8c2b6fe`) closed the pathfinder-commit-point suffocation sub-failure. #28 (`f3bee88`) closed the mid-session in-zone stranding gap (teleport into zone re-fires escape). Together with #22b, the "suffocation + stranding" class is fully covered pending live verification.


### 28. Mid-session in-zone re-fire on `forcedMove` (`f3bee88`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (need a mid-session `forcedMove` into the zone; post-restart the spawn-side trigger runs first, which is the default path)

**Change.** Hook the existing `forcedMove` listener in `_installSpawnEscapeInstrumentation`. After a 500ms debounce, if bot is inside the spawn zone (`_isInSpawnZone`), alive, has a finite position, and `botMutex.currentHolder` is not `escapeProtectedZone` or `escapeSpawnZone`, call `_impl_escapeProtectedZone(bot)` with a 30s cooldown. Imported `botMutex` from `../bot_mutex.js`.

**Why now.** JP `/tp`'d the bot to spawn mid-session to exercise BT-22. Bot sat idle — `escapeProtectedZone` only fires on spawn/login, so any server teleport or op `/tp` into the zone stranded the bot. This closes that gap and simultaneously unblocks BT-22 live verification.

**Guardrails.**
- 500ms debounce — teleport bursts coalesce into one check.
- Mutex holder check — no re-entry during an active escape.
- 30s cooldown — prevents re-fire loops if escape itself triggers more forcedMoves.
- Finite-position + alive check — ignores NaN/dead windows.

**Rule 7 audit.** Single event site (`bot.on('forcedMove', ...)`), no fan-out. Install-confirmation log updated to include `#28 in-zone re-fire enabled` for discoverability.

**Verification signal to watch.** Next mid-session `forcedMove` into zone: `[SpawnEscape] forcedMove landed in protected zone at (...) — re-firing escape` line + `[BotMutex] #N acquired: escapeProtectedZone` immediately after.


### 22. `escapeProtectedZone` suffocation trap — pre-move passability guard (`8c2b6fe`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification**

**Change.** Two helpers (`_isTargetPassable`, `_findPassableY`) + a guard block at the top of `_escapeTryPath` in `src/agent/library/skills.js`. Before committing `GoalNear`, check feet+head blocks at the target; if both known-solid, try Y offsets `[0, -1, +1, -2, +2, -3, +3]`. If nothing passable in ±3, log `[EscapeZone] <label>: target ... rejected` and return so the caller's stuck/next-direction logic fires. Unknown (unloaded-chunk) blocks return `null` and defer to pathfinder — we only reject KNOWN-solid targets, preserving all currently-working paths.

**Rule 7 perimeter.** One guard, four callers: cached-exit (`_impl_escapeSpawnZone`), dir-hop (`_commitToDirection`), stuck-back + stuck-sidestep (`_executeStuckManeuver`). `grep -nE '_escapeTryPath' src/agent/library/skills.js` → 4 callers, all covered.

**Evidence that motivated the fix.** 5 lethal unknown-source 2-dmg/tick suffocation sequences on 2026-04-19 between 15:35:49–15:44:58Z. At 15:44:57–58Z: `held:true reason:chunk_wait` → next tick `mutex.holder:"escapeProtectedZone"` heading `(-34.5, 91, -35.5)` → `(-7, 91, -64)`. Y=91 hop through uneven terrain deposited the hitbox inside solid material.

**Verification signal to watch.** After next natural escape event: `[EscapeZone]` log lines in tmux, zero `source:"unknown"` lethal sequences in `data/damage-stream.jsonl`. Guard currently idle because bot spawned outside the protected zone.


Feature-level entries that have landed on `develop` but haven't yet been observed working in live play. Graduate to **Recently completed** once the "how we verify" checklist is ticked. Pure refactors, docs, and mechanical sweeps skip this section and go straight to Recently completed — this bucket is specifically for behaviors that need world-side confirmation.

### 16.2. Block-family expansion for logs and planks

**Status:** shipped `ab997fb` — awaiting live verification • **Priority:** high

When the LLM requests a specific wood type (e.g., `oak_log`) that doesn’t exist in the current biome, `collectBlock` and `goToNearestBlock` now automatically expand the search to all log variants before reporting failure. Eliminates the infinite loop where the bot cycles searchForBlock → "Could not find" → goToSurface → retry on a wood type absent from the biome.

**Implementation:** `BLOCK_FAMILIES` constant + `expandBlockFamily()` helper at module top of `skills.js`. Data-driven — one table entry per family (logs and planks shipped). `collectBlock` adds family members to the `blocktypes` array (same pattern as ore/deepslate expansion). `goToNearestBlock` falls back through variants with "No X found — using Y instead" log message.

**Root cause (discovered during log review):** The original #16.2 described a generic empty-search loop. Actual root cause was the LLM picking biome-specific wood types — a Principle 1 problem (mechanical decision the LLM is bad at). Fix is code-level block-family equivalence, not an AutoRecovery pattern.

**How to verify:**
- [ ] Bot issues collectBlocks("oak_log", N) in a non-oak biome → log shows family expansion finding spruce/birch/etc. instead
- [ ] Bot issues searchForBlock("oak_log", N) in a non-oak biome → log shows "No oak_log found — using spruce_log instead"
- [x] No regression: bot collecting logs in a biome that HAS the requested type still works normally (observed: `collectBlocks("oak_log", 20)` succeeded in oak biome)

## To-do queue

Items grouped by status (⏳ Not started → 🟡 Partial → 🔁 Ongoing). Within each status group, items are sorted by importance/impact/severity — highest first. Numbers preserved from project history.

---

**⏳ Not started**



### 21. L1 cleanup bundle (low-priority nits)

**Status:** ⏳ not started • **Priority:** low (documentation / Rule-3 nits surfaced by L1 migration-marker grep) • **Source:** audit findings L1.1, L1.3, L6.3, L6.5

Four small items in one bundle so none are forgotten:

- `src/agent/modes.js:38` — `// hacky fix when blocks are not loaded` comment admits a band-aid (Rule 4). Either investigate the root cause (chunk timing?) or upgrade the comment to explain why treat-as-air is the right fallback.
- `src/models/prompter.js:552` — bare `// deprecated` comment with no "why" / "when to remove" context (Rule 3). Either remove the deprecated code or annotate.
- `src/agent/history.js:66` — the `!settings.use_context_builder` gate reads as profile-driven but the default actually lives in `src/settings.js:100`. Add a one-line pointer comment to save the next audit a round-trip (L5.1 shakedown lesson).
- `src/models/prompter.js:237` — `// Combine legacy summary with episodic memory retrieval` comment. Needs read-in-context to confirm whether this branch is gated by `!use_context_builder` (clean) or always runs (contradicts D1 story).

### L1.4 verification — possibly-dead exports (pending JP confirmation)

**Status:** ⏳ pending JP confirmation • **Priority:** low • **Source:** audit finding L1.4

Two exports in `src/agent/library/skills.js` have no internal caller, no `!command` registration in `actions.js`, and no external grep hit:

- `tillAndSow` (line 3071)
- `activateNearestBlock` (line 3160)

The LLM can reach them only via `coder.js`-generated code addressing `skills.X()` by name, but there's no documentation path for the LLM to know they exist. May be intentional library surface for future commands, or forgotten leftovers.

**Question for JP:** were these ever wired, are they planned surface, or forgotten? If planned, convert to tracked command-registration work. If forgotten, remove per Principle 5.

### OPT-bundle. Unverified optimization findings from 2026-04-16 audit

**Status:** ⏳ not started — **needs full Rule 2 codebase read before any can be actioned** • **Priority:** low (code quality; none functionally broken)

Surface-level findings from an optimization audit that did NOT follow proper review process (governing docs and full codebase were not read before analysis). Listed here so they aren't lost, but each must be verified with a proper Rule 1/2/3/4 pass before implementation.

- **B.** `goToGoal` creates two Movements objects every call (lines ~2936-2950) — both `nonDestructiveMovements` and `destructiveMovements` constructed upfront via `createMovements(bot)`. The destructive one may only be needed if the non-destructive path fails. Needs verification: is there a reason both are created eagerly?
- **C.** `pickupNearbyItems` creates Movements per loop iteration (line ~723). Could potentially create once before the loop. Needs verification: does the bot's position change between iterations in a way that invalidates a cached Movements?
- **D.** `_isDangerous` rebuilds an array + `.includes()` on every call (line ~2628). Called in tight loops during safeToss direction validation. Could be a module-level Set. Needs verification: is this actually a measurable perf concern or just cosmetic?
- **E.** `scanForCaverns` allocates `rockTypes` Set every call (line ~3902). Could be a module-level constant. Same verification question as D.
- **F.** Duplicate yaw-to-cardinal direction snapping in `digDown` and `digUp`. Identical code. Could extract to a shared helper. Pure cleanup — low risk but needs blast-radius check.
- **I.** `moveAway` creates Movements twice (lines ~3317-3321) — first for `setMovements`, second inside the cheat-mode branch. First could potentially be reused. Needs verification: does the cheat-mode branch need different config?

**Do not implement any of these without first completing a full codebase read per Sam's Binding Rule 2.**

---

### 7d. Block-update watcher for runtime-placed structures

**Status:** ⏳ not started • **Priority:** low (complements 7c — catches live placements as they happen)

Listen to mineflayer's `blockUpdate` events, filter to player-placed (not world-generation), record `{player, block, x, y, z, timestamp}`. Cluster by proximity + time. Promote to protected zone after N placements within X blocks/Y minutes. Pairs well with 7c (startup heuristic) + live tracking.

### 8. Humanized action delays

**Status:** ⏳ not started • **Priority:** low

Bot currently acts as fast as LLM + mineflayer allows, which looks robotic and could trigger anti-cheat on some servers. Add variable delay between commands.

**Fix sketch:**
- New file `src/agent/human_delays.js` with command→delay-range map.
- In `Agent.handleMessage` after a command completes: `await new Promise(r => setTimeout(r, getHumanDelay(command_name)))`.
- Base delay 3s, scale by complexity (1-2s trivial, 2-3s movement, 3-5s gather/craft, 4-6s complex). ±1000ms jitter.
- Don't apply to mode-triggered actions (self_preservation, self_defense) — those react instantly.

### 7e. Seed-based chunk-diff detection (research-only)

**Status:** ⏳ research-only • **Priority:** very low (likely infeasible in JS for 1.21)

Given world seed + MC version, regenerate each chunk deterministically and diff against current state. Any differences are human modifications or pre-generated structures. 100% accurate in principle. **Practically**: no 1.21-compatible JS terrain generator exists. Porting Java's generator (~50K lines + caves-and-cliffs + trial chambers) is a major project. Park indefinitely; revisit if a library emerges.


### 27. Legacy `memory.json` residue under ContextBuilder

**Status:** ⏳ not started • **Priority:** low (cosmetic/forensic — no behavior impact)

**Problem.** `bots/<profile>/memory.json` `memory` field still carries the legacy `"…(Memory truncated to 500 chars. Compress it more next time)"` residue tail. D1 (commit `7ee597e`) stopped the *producer* (`promptMemSaving()` skipped when `use_context_builder` is true) but never *cleared* what was already persisted. The string rides along in every `history.save()` forever — under CB-on there is no path that overwrites it.

**Root cause.** D1 was a surgical producer-side skip. The consumer-side cleanup — wipe the persisted field on load when CB is on — was never shipped. Principle 5 violation we inherited quietly: migration finished the write path but left a read-path residue.

**Solution sketch.** On `history.load()`, if `use_context_builder` is true, clear `memory` to empty string (or strip the legacy truncation marker). Alternatively a one-shot manual wipe across the active `memory.json` files. Producer-side skip is correct — this is consumer-side hygiene.

**Files.**
- `src/agent/history.js` — load path (conditional field clear under CB).
- One-time wipe of `bots/*/memory.json` `memory` fields.

**Blast radius.** Nil. Field is dead under CB — no caller reads it when ContextBuilder is active.

**Success signal.** Fresh `memory.json` saves under CB show `"memory": ""` (or equivalent) instead of the frozen legacy snippet.

**Philosophy alignment.** Principle 5 (finish migrations, kill redundancy). Rule 4 (root cause not symptom — the wipe closes the class, not just the instance).



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
- **Dimension safety** — if bot accidentally enters Nether or End via portal, retreat immediately. No dimension awareness currently.

### 12. Movements safety audit — Rule 7 follow-through

**Status:** 🟡 Stage 1 shipped (commit `e59a307` — `bot.collectBlock.movements` now safety-configured); full audit deferred • **Priority:** medium-high (bot safety; currently ~20 sites use raw pathfinder defaults)

**Audit update 2026-04-15 (L2 findings):** full perimeter sweep confirmed 20+ raw-default callsites. Five are hot-path and should be prioritized before the broader refactor:

- `skills.js:426, 432` — enemyKite combat (bot chased into lava/cactus = unnecessary damage)
- `skills.js:740` — breakBlockAt approach (target buried → straight-down shaft risk, same class as Stage-1 fix)
- `skills.js:937, 943` — placeBlock approach (2 sites, same pattern as breakBlockAt)
- `skills.js:2889, 2920, 2939, 3131, 3176` — moveAwayFromEntity / moveAwayFromPosition / avoidEnemies / activateNearestBlock / activateFarmland

Other raw sites (`collectBlock:506`, `pickupNearbyItems:681`, `followPlayer:2824`) carry lower risk and are acceptable as "deferred to full audit." Stage 2 (the `createSafeMovements` helper) unblocks #17 (skills.js decomposition — the helper extraction is a natural first module boundary).

Rule 7 (Complete the perimeter) calls for every `pf.Movements` instance in the codebase to be constructed via a shared helper so the safety invariant — `maxDropDown=3`, `canSwim=true`, `_configureTerrainSafeMovements`, sensible `digCost` — holds everywhere. Right now only `goToGoal` (for its two internal Movements objects) and `bot.collectBlock.movements` (as of Stage 1) apply the safer config. Every other `new pf.Movements(bot)` in `skills.js` uses raw pathfinder defaults.

**Known raw-defaults callsites (grep output 2026-04-15):**

- `world.js:397` — isClearPath (read-only, low risk)
- `skills.js:426/432` — defendSelf (hostile follow, short-lived)
- `skills.js:506` — collectBlock local movements (short-lived, already has ProtectedZone filter)
- `skills.js:681` — breakBlockAt approach (short-lived)
- `skills.js:740` — breakBlockAt internal retry (short-lived)
- `skills.js:937/943` — goToPlayer (destructive path to player)
- `skills.js:2783/2848/2851/2879/2898/3090/3135` — various pathfinder setup blocks
- `skills.js:3493` — digDown cavern-path pre-check (non-destructive, OK)
- `CollectBlock.js` (plugin) — fixed via Stage 1

Short-lived and short-distance pathfinding (breakBlockAt approach, defendSelf, unstuck) carries less straight-shaft risk because targets are usually at bot height. The biggest risks were `collectBlock` (fixed) and potentially `goToPlayer` if the player is buried.

**Fix sketch:**

1. New `createSafeMovements(bot, opts = {})` helper in `skills.js`. Returns a `new pf.Movements(bot)` with safety defaults applied:

```js
const m = new pf.Movements(bot);
m.maxDropDown = opts.maxDropDown ?? 3;
m.canSwim = opts.canSwim ?? true;
m.digCost = opts.digCost ?? 10;  // discourage mining-through
m.placeCost = opts.placeCost ?? 2;
if (opts.canDig !== undefined) m.canDig = opts.canDig;
_configureTerrainSafeMovements(bot, m);
return m;
```

2. Route every `new pf.Movements(bot)` in `src/agent/library/skills.js` through `createSafeMovements(bot, {...})`. Per-site opts let callers override (e.g., `canDig=false` for non-destructive probes).

3. Document the invariant in the helper's header — "No bare `new pf.Movements(bot)` anywhere in mindcraft-mcgavin code; use `createSafeMovements`."

4. Optional lint-style check (sibling to the 29-test classification harness): a script that greps `src/` for `new pf.Movements(bot)` outside `createSafeMovements` itself and fails if any are found.

**Signals to watch:** no more straight-down digging during `!collectBlocks`, `!goToPlayer`, or any other pathfinder-driven command. Bot consistently uses staircases and walks around obstacles rather than mining through.

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

### 17. `skills.js` decomposition (long-term)

**Status:** 🟡 partial — gated on #12 Stage 2 shipping first • **Priority:** low (architectural; deferred until #12 lands) • **Source:** audit finding L6.1

`src/agent/library/skills.js` is 4,138 lines — 4× the next-largest file in the tree. Every perimeter-audit finding in L2 lives here, every pathfinder catch violation in L3 lives here, and the file is the natural focus of every audit because everything is in it. Rule 2 (elegance) flags this implicitly: the per-function elegance is fine, but the aggregate cognitive cost is high.

**Natural first extraction target:** `createSafeMovements` helper from #12. Once the helper exists, move all movements-related code (plus its callers' safe-config glue) into a new `src/agent/library/movements.js`. After that: consider splitting combat / building / inventory / spawn-protection into separate modules.

Defer until #12 Stage 2 actually ships — jumping ahead would create a split-refactor hazard. Keep flagged so it isn't forgotten.

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

- **Audit trail 2026-04-15** — `/mindcraft-audit` v1.1 first run. Full reports in workspace-local `mindcraft-mcgavin-audit/2026-04-15/`. 9 new entries (#13–#21 + L1.4) added to the to-do queue at audit time; mechanical bundle shipped same day (see Recently completed).
- **Items 2 and 3 share terrain-awareness logic** — factor into a "terrain profiles" abstraction when both land.
- **Item 8 should be last** — don't add delays on top of an unfinished bot. Fix behavior first, then slow it down.
- **Item 9 is the philosophy** — every routine/mechanical decision the LLM is asked to make is a candidate to convert to code.

---

## Recently completed

### OPT-I. `_impl_defendSelf` try/finally unpause — fix one-hit-then-die combat bug (`94442d2`, 2026-04-19)

**Status:** ✅ completed — **live verified 2026-04-19 20:26** (two `defendSelf` fires 19s apart against two zombies; 0 post-combat damage, bot killed both mobs)

**Symptom.** JP observed: bot says "Fighting zombie!", hits once, then takes lethal damage with zero retaliation.

**Root cause.** `_impl_defendSelf` paused `self_defense` + `cowardice` at entry but never unpaused. The modes controller only auto-unpauses when `_agent.isIdle()`; during any active goal (e.g. "make 64 torches") the agent is never idle, so after `defendSelf`'s while-loop exits (mob drifts >8 blocks during knockback → loop ends), both modes stay paused for the rest of the goal. The mode that would re-invoke `defendSelf` on the next hit can no longer fire. Bot is defenseless.

**Change.** Single function edit in `src/agent/library/skills.js`. Wrapped the body of `_impl_defendSelf` in `try { ... } finally { bot.modes.unpause('self_defense'); bot.modes.unpause('cowardice'); }`. Every exit path (normal return, `bot.interrupt_code` early return, thrown error) now runs the unpause. Added a leading comment block explaining the invariant so future edits don't re-introduce the bug.

**Blast radius.** Single function, single perimeter. The unpause is the direct complement of the pause calls at 458–459. No touch to mode controller, `bot.pvp`, or other `defend*` helpers.

**Forensic evidence of the bug pre-fix.**
- 2026-04-19 20:05:32–38: zombie 20→8, unk 8→6→4→2→0 LETHAL over 6s. skill-stream: `defendSelf outcome:success ms:3570` at 20:05:32.8, NO re-entry.
- 2026-04-19 18:34:35–45: zombie 20→18, 9 sequential 'unknown' hits over 10s. `defendSelf outcome:abort ms:12590` post-mortem.

**Verification signals to watch.**
- Next combat encounter: expect multiple `bot.pvp.attack` bursts per engagement, NOT a single burst. Mob dies OR bot dies after sustained fight (not silent absorption).
- After `defendSelf` completes, `bot.modes.getStr()` should show `self_defense(ON)` and `cowardice(ON)` (not paused).
- `skill-stream.jsonl` `defendSelf` records remain the same shape — behavioral change is at the *mode* layer, not the skill layer. What should differ is the count of `defendSelf` invocations per goal: many instead of one.

**Rule 7 audit.** Single function, single perimeter. Pause at entry is now balanced by unpause in finally. No fan-out.

**Companion finding (deferred, separate ship).** `_impl_goToPlayer` (skills.js 3836) has the same pattern: `pause('self_defense') + pause('cowardice')` at entry, no unpause. Same risk class — will fix when JP prioritizes (lower urgency because goToPlayer is typically short-lived).



### OPT-J. Added `lava`, `campfire`, `soul_campfire` to pathfinder `blocksToAvoid` (`e2b680b`, 2026-04-19)

**Status:** ✅ completed (pure correctness — no live verification needed; next pathfind operation uses the updated avoid set).

**Change.** Three-line append to the `hazards` array in `_configureTerrainSafeMovements` (skills.js line 2169). All `Movements` instances in the codebase route through `createMovements(bot)`; the factory calls `_configureTerrainSafeMovements` before returning, so the new entries apply universally the moment a new `Movements` is constructed.

**Why.** Last death 2026-04-19 20:19:26Z — "ThatCoolGuyDude discovered the floor was lava" at (-107.28, 7.18, -149.04). Pathfinder routed through a lava block because `lava` wasn't on the explicit avoid list. Campfire + soul_campfire added preemptively — same block class (standing on = damage), common near villages.

**Final hazards list (11 entries):** sweet_berry_bush, pointed_dripstone, cactus, wither_rose, magma_block, fire, soul_fire, powder_snow, lava, campfire, soul_campfire.

**Behavioral difference.** Pathfinder will not generate paths through any of the three new block types. Deep-Y mining targets adjacent to lava become harder to reach (bot must pillar around or bridge across — separate task if it becomes a blocker). Campfires near spawn/village are walked around instead of through.

**Blast radius.** Single array in single function. Set dedup makes re-adds no-op; `bot.registry.blocksByName[name]` resolve-or-skip handles missing block names gracefully across data versions.

**Rule 7 audit.** Single perimeter. No touch to pathfinder wiring, no new Movements callsite, no change to `createMovements` factory or zone-aware dig/scaffold logic.

**Companion gap (deferred).** This only prevents *pathing through* hazards. It does NOT prevent the bot from standing on a block adjacent to lava (edge of a pool) nor from falling into lava via `digDown` / `breakBlockAt`. Those holes are handled by the in-action reflexes (`self_preservation`, `autoBreakStuckPlant`) and manual-command guards — not part of OPT-J scope.


### OPT-H. Removed `sugar_cane` from `MOVEMENT_BLOCKING_PLANTS` (`4f5141e`, 2026-04-19)

**Status:** ✅ completed (pure correctness — no live verification needed).

**Change.** Single-line deletion in `src/agent/library/skills.js` `MOVEMENT_BLOCKING_PLANTS` Set. Closes the half-shipped intent of commit `d1df31f` (2026-04-16) which was titled "remove sugar_cane from MOVEMENT_BLOCKING_PLANTS — no collision box" but only updated a docblock comment, leaving the Set entry in place.

**Why.** Sugar cane has no collision box in modern Minecraft (1.14+). The bot walks through it freely and it never blocks movement. The entry + `// solid hitbox` inline comment were both wrong.

**Behavioral difference.** `autoBreakStuckPlant` scan inside spawn zone no longer treats `sugar_cane` as a candidate to break. Correct — the bot could never have been stuck on sugar_cane in the first place, so this branch could only ever fire as a false positive. Outside spawn zone, `sugar_cane` was never a breakable candidate anyway.

**Preserved.** `PLANT_LIKE_PATTERN` regex (line 2248) still matches `sugar_cane` so any "is this a plant?" classifier path elsewhere still returns true for it.

**Rule 7 audit.** Single-line deletion, single Set. No fan-out, no touch to dispatch or other plant-classification paths.


### 2026-04-18 — Self-prompter recoverable circuit-breaker + stop attribution + telemetry ✅

Shipped `5f274f1` on `develop` — 44-line additive fix to `src/agent/self_prompter.js` closing a multi-hour idle failure mode observed live 2026-04-18.

**The bug.** JP asked "what's the bot doing right now?" and the answer was: nothing, for ~3 hours. `session.log` showed the self-prompt loop emitted `Agent did not use command in the last 3 auto-prompts. Stopping auto-prompting.` at 14:41:35Z. After that line, the only LLM calls over the next several hours were triggered by death-respawn `handleMessage` events; once the bot stopped dying, there was no pump to restart the agent loop. `[Goal] event=start prompt="gather 64 ancient debris"` was still the last goal event — no `event=end`, no `event=pause`, just silence.

**Root cause.** `startLoop()` at `src/agent/self_prompter.js` had a circuit breaker at `MAX_NO_COMMAND = 3`: when the LLM returned three consecutive responses with no `!commandName`, the loop set `this.state = STOPPED; break;` and exited. The STOPPED state is a terminal sink — `update(delta)` only restarts the loop when `state === ACTIVE`. There was no distinction between "user stopped the bot" (don't resume) and "circuit breaker tripped" (should eventually resume), so making the breaker self-healing required adding attribution first. Goal lifecycle telemetry also never fired on the breaker path — the active goal just disappeared from the log stream.

**The fix (A+C+D combined, guarded by new attribution field).**

1. **Stop attribution (`stoppedReason`).** New field on `SelfPrompter`. Set to `'user'` in `stop()` before `state = STOPPED`, `'circuitBreaker'` in the `MAX_NO_COMMAND` branch of `startLoop()`, cleared to `null` in `start()`, `handleLoad()`, and on watchdog resume. No external readers (greped). Enables everything downstream.

2. **Circuit-breaker telemetry (D).** The `MAX_NO_COMMAND` branch now emits `[Goal] event=end prompt=<JSON> reason=circuit_breaker ms=<elapsed>` and clears `_goalStartTime`/`_goalPrompt` before setting `stoppedReason = 'circuitBreaker'` and `state = STOPPED`. Goal lifecycle is now complete on this path; log analysis can count breaker trips independently of user stops.

3. **Watchdog in `update()` (C).** New branch: `else if (this.state === STOPPED && this.stoppedReason === 'circuitBreaker' && this.prompt && !this.loop_active && !this.interrupt)`. Accumulates `idle_time` while the agent is idle; after `WATCHDOG_MS = 180000` (3 min) it emits `[Goal] event=resume prompt=<JSON> reason=circuit_breaker_watchdog`, sets `state = ACTIVE`, clears `stoppedReason`, restarts `_goalStartTime`/`_goalPrompt`, and calls `startLoop()`. User stops (`stoppedReason === 'user'`) never auto-resume.

**Telemetry contract (new).**
- `[Goal] event=end prompt=<JSON> reason=circuit_breaker ms=<n>` — emitted when 3 consecutive no-command responses trip the breaker.
- `[Goal] event=resume prompt=<JSON> reason=circuit_breaker_watchdog` — emitted when the watchdog auto-resumes after 3 min idle in `circuitBreaker` state.
- `[Goal] event=end prompt=<JSON> reason=stop ms=<n>` — unchanged; user-initiated stops.

**Blast radius (small and safe).** `grep -rn "stoppedReason" src/` returns only the 8 sites inside `self_prompter.js`. `node --check` passes. Behavior is strictly additive: the new watchdog only runs when `state === STOPPED && stoppedReason === 'circuitBreaker'`, a state that didn't exist before this commit. Existing user-stop semantics untouched.

**Verification — honest status.**
- Boot-verified: bot restarted via `start.sh`, first `[LLM]` call fired (`Hello world, I'm ThatCoolGuyDude.`), StateTicker streaming, `auto_recovery.invocations=0` (fresh counters), no runtime error.
- Live circuit-breaker exercise: **deferred**. The 3-consecutive-no-command failure case is LLM-random and can't be forced cleanly without adding speculative instrumentation. When it trips in real play the logs will show the new telemetry contract above. Per Rule 6, this is a boot-verified ship, not a breaker-exercised one.

**Philosophy alignment.** Principle 5 (eliminate tribal knowledge — the single-use-flag stop-attribution pattern makes the distinction between user intent and automatic recovery explicit in state rather than inferred from log context). Rule 4 (root cause first — the "bot goes idle for hours" symptom traced to a terminal STOPPED state with no recovery path; fixed by giving STOPPED an attribution field rather than adding an external watchdog or restart cron). Rule 9 (simplicity first — rejected four-option bundle in favor of A+C+D, declined B as speculative; rejected stateless watchdog in favor of additive field with 0 external readers). Rule 10 (surgical — only `self_prompter.js` changed, +44 lines, no refactor of adjacent code).

**Followups (not blocking).**
- Consider classifying `[Goal] event=end reason=circuit_breaker ms=<n>` into `data/` JSONL if breaker trips become frequent — lets us compute trip rate by goal category.
- If watchdog resume → immediate re-trip becomes a pattern, add trip-count backoff (e.g., second breaker in same goal within 10 min escalates to goal-advance or human-notify). Not shipping speculatively.

### 2026-04-17 — #26 phantom self_defense fixed: narrow mode detection range to defendSelf attack range ✅

Shipped `df9b737` same day on top of BT-7b, immediately after the BT-7b telemetry surfaced the bug. One-line fix in `src/agent/modes.js:171` — `self_defense` mode's hostile-detection range narrowed from `16` → `8` to match `defendSelf`'s default attack range. Found-and-fixed in the same pass; no doc-only "to-do queue" entry intermediate (kept git history clean as `feat(modes)` + `docs(whiteboard)`).

**The bug.** JP observed live: bot kept announcing `Fighting enderman!` in chat while no actual combat was happening, paired with rapid `disconnect.spam` reconnect storms ("Removed from server due to flying, spamming, or invalid movement"). `data/skill-stream.jsonl` showed 241 `defendSelf` calls in a short window — every one with `outcome=abort` and `notes="No enemies nearby to defend self from"` — fired alongside `[Boot]` events repeating roughly once per minute.

**Root cause.** `self_defense` mode (L165-179) called `world.getNearestEntityWhere(bot, isHostile, 16)` to decide whether to trigger, then `say(agent, 'Fighting X!')` and `execute(this, agent, () => skills.defendSelf(agent.bot))`. But `defendSelf`'s `range` parameter defaulted to `9` (and was wrapped by BT-7b to take a default of `8` after the alignment) — the skill scanned a smaller radius than the mode that triggered it. Hostiles sitting in the 8–16 ring (e.g. an enderman observed at dist 10.5) tripped the mode's announce-and-execute path but the skill scanned at 8, found nothing, and aborted with `outcome=abort`. The mode's `interrupts: ['all']` wedged on every tick, breaking whatever else was running (notably the active `escapeProtectedZone` mutex holder) and producing fast enough chat/movement chatter that the server's anti-spam tripped and kicked the bot — which then auto-reconnected, which re-spawned, which re-detected the same ring-resident enderman, which re-tripped the mode. The reconnect storm and the stuck-escape were both symptoms; phantom combat was the cause. Note that `cowardice` (L149-162) had the inverse-correct relationship (detect=16, flee=24, flee > detect) — only `self_defense` had the inversion.

**The fix.** One-line change at `modes.js:171` — `getNearestEntityWhere(...)` range argument `16` → `8`, plus a multi-line comment block explaining why future readers must keep mode-detection-range ≤ skill-attack-range. `skills.defendSelf(agent.bot, 8)` made explicit at the call site to defeat any future default-arg drift. Net diff: 1 line of behavior, ~6 lines of comment, kept under Rule 10 (surgical changes — touched only `self_defense`, did not "fix" the cowardice numbers because they're already correct, did not refactor the broader mode system).

**The triple-win on verification.** The one-line fix resolved three previously-reported symptoms simultaneously, and the metrics held over a 3-minute post-restart observation window:

| Signal                              | Pre-fix (3 min)       | Post-fix (3 min)        |
|-------------------------------------|-----------------------|-------------------------|
| `Fighting X!` chat announcements    | ~1/sec                | 0                       |
| `[Skill]` `defendSelf` calls        | 241                   | 0                       |
| `disconnect.spam` server kicks      | 10                    | 0                       |
| `[Exit]` lines (any reason)         | 10                    | 0                       |
| `[Boot]` snapshots                  | 11                    | 1                       |
| Mutex holder                        | `escapeProtectedZone` | `null`                  |
| `pathfinder.active`                 | `true`                | `false`                 |
| Position                            | stuck at (-137,72,164)| escaped to (-169,69,192)|
| `nearby_entities`                   | enderman dist 10.5    | empty                   |

The phantom combat was the direct fix; the reconnect storm dropped because no more anti-spam-tripping chat/movement chatter; the stuck escape unwedged because `self_defense` (`interrupts: ['all']`) was no longer constantly preempting it. Three observed bugs, one root cause, one line.

**Why BT-7b made this findable.** Pre-BT-7b, only the 11 hottest skills emitted `[Skill]` lifecycle lines; `defendSelf` was not one of them. The bug had been sitting latent since `defendSelf` got an `attackRange` parameter mismatch (origin date unknown) — the symptom was visible (chat spam) but the smoking gun (`outcome=abort` in `data/skill-stream.jsonl` 241 times in a tight window with `notes="No enemies nearby"`) only became greppable once BT-7b shipped earlier on 2026-04-17. Within minutes of BT-7b going live, the JSONL stream made the misalignment obvious. Direct payoff for the migration: a class of phantom-action bugs (mode triggers skill, skill aborts immediately) is now mechanically findable across all 42 wrapped skills via `outcome=abort` clustering.

**Philosophy alignment.** Principle 1 (don't ask the LLM to reason about mechanical signals — the mode and the skill share a numeric range; that should be a single source of truth, not a coincidence between two literals). Principle 8 (fail loudly — the abort case was already loud once BT-7b landed; the fix makes the success case loud by removing the no-op trigger). Rule 4 (root cause first — fixed the misaligned constant, did not add a guard inside `defendSelf` to silently swallow the no-target case). Rule 6 (verify honestly — pass criterion was "0 phantom Fighting announcements + 0 abort defendSelf calls + escapeProtectedZone unwedges", confirmed all three over 3 minutes; not just "no error in logs").

**Followups deferred (not blocking).**
- Bug B `disconnect.spam` (item L530-ish queue) — root cause confirmed downstream of phantom combat; the reconnect storm was the symptom of the chat-spam-trip. If `disconnect.spam` recurs in a context that doesn't involve `self_defense`, treat as a new bug. Closing the existing tracking entry on this evidence.
- Single-source-of-truth for skill ranges (constants module exporting `DEFEND_SELF_RANGE`, `ATTACK_NEAREST_RANGE`, etc.) is a Principle 5 candidate but out of scope here. Filed mentally; will surface if a second range-mismatch bug appears.
- `self_defense` being `interrupts: ['all']` is correct for the "real combat" case but means a single false trigger blows up everything. Considered widening the mode's pre-check to require `isClearPath + range≤attack_range`, but that already happens — the fix above is sufficient. No mode-system refactor needed.

**What didn't ship.**
- No changes to `cowardice` (numbers correct, leave it alone — Rule 10).
- No changes to `defendSelf`'s internal logic; only the call-site default at `modes.js:171` was made explicit.
- No new constants module; one-line fix doesn't justify a new abstraction (Rule 9, simplicity).
- No changes to the 30 other modes; only `self_defense` had the inversion.

### 2026-04-17 — BT-7b Skill lifecycle sweep: `wrapSkill` wrap landed on the remaining 31 exports in `skills.js` ✅

Shipped `e563456` same day on top of BT-3b, closing the Principle 5 migration BT-7 started. Before BT-7b, only the 11 hottest exports in `src/agent/library/skills.js` (`collectBlock, craftRecipe, smeltItem, pickupNearbyItems, placeBlock, equip, safeToss, safeTossBatch, goToNearestBlock, digDown, digUp`) emitted the uniform `[Skill] name=… args=… ms=… outcome=success|abort|error [err_class=…] [notes=…]` lifecycle line BT-7 introduced; the remaining skills used ad-hoc `bot.chat` / bespoke `[Skills]` logs (or nothing). Every public skill export in the agent library now emits exactly one `[Skill]` line per call, regardless of category. 62 insertions, 31 deletions across one file.

**Waves (31 shipped):**
- **Wave 1 — combat/safety (6):** `escapeSpawnZone`, `escapeProtectedZone`, `attackNearest`, `attackEntity`, `defendSelf`, `avoidEnemies`.
- **Wave 2 — movement (10):** `goToPosition`, `goToNearestEntity`, `goToPlayer`, `followPlayer`, `moveAway`, `moveAwayFromEntity`, `stay`, `useDoor`, `goToBed`, `goToSurface`.
- **Wave 3 — world/chest/trade (15):** `clearNearestFurnace`, `breakBlockAt`, `autoBreakStuckPlant`, `discard`, `putInChest`, `takeFromChest`, `viewChest`, `consume`, `giveToPlayer`, `tillAndSow`, `activateNearestBlock`, `showVillagerTrades`, `tradeWithVillager`, `placeTorchAt`, `useToolOn`.

**Pattern.** Same rename-impl convention BT-7 established: `export async function X(...)` → `async function _impl_X(...)` + `export const X = wrapSkill('X', _impl_X)`. Intra-module callsites intentionally reference the wrapped public export (e.g., `defendSelf` calling `attackEntity` goes through the wrap), preserving the BT-7 convention that nested skill calls produce nested `[Skill]` lifecycle lines — two visible round-trips, one inner, one outer. 84 `_impl_` references in the final file = exactly 2 per wrap (one definition + one `wrapSkill` wiring), confirming no accidental intra-module calls to the raw impl.

**Skip list (utility primitives, kept raw):** `wait` (L191) and `goToGoal` (L2960). Both are low-level primitives called by other wrapped skills; wrapping them would double-count the outer skill's duration and emit telemetry for what is semantically a single skill invocation. Principle 9 (simplicity) and Rule 10 (surgical changes) — the utility layer does not need its own lifecycle line.

**Rule 7 "Complete the perimeter" audit.** Every public async skill export in `src/agent/library/skills.js` is now wrapped. Final inventory: 51 exports, 42 wrapped (11 pre-existing BT-7 + 31 new BT-7b), 9 non-skill exports (`wait`, `goToGoal`, plus 7 sync helpers / re-exports that don't fit the async-lifecycle shape). Grep of the modified file for `^export async function ` returns exactly `wait` and `goToGoal` — both on the documented skip list above. Grep of the wider codebase for callers importing any of the 31 newly-wrapped skills shows all callers receive the wrapped function (identical signature, transparent return) — zero call-site changes required. The BT-7 taxonomy (`success` = truthy return, `abort` = literal `false`, `error` = throw) applies cleanly to all 31 new wraps; no skill returns a non-boolean-non-throw value that would defeat the classifier.

**Verification — synthetic-proven + live-regression clean:**

- `node --check src/agent/library/skills.js` parse-clean after all three waves. ✅
- Dynamic `import()` enumerates 51 exported functions, 0 missing targets from the wrap list, 0 dangling `_impl_` names leaking through the module surface. ✅
- **Synthetic three-branch lifecycle test** (`/tmp/synth-bt7b.mjs` on gaming): wraps three test fns (`_impl_synthOK` returns `true`, `_impl_synthAbort` returns `false`, `_impl_synthErr` throws `TypeError('boom')`) via `wrapSkill` + `configureSkillLifecycle`. Captured console output matches canonical format exactly: `[Skill] name=synthOK args=["aaa"] ms=0 outcome=success`, `[Skill] name=synthAbort args=["bbb"] ms=0 outcome=abort`, `[Skill] name=synthErr args=["ccc"] ms=0 outcome=error err_class=TypeError`. All three outcome branches verified including the `err_class=` rider only present on throws. ✅
- **Live post-restart on `e563456`:** gaming-server tmux session `mindcraft-mcgavin` was relaunched on the new SHA (tmux scrollback raised to 100000 after prior StateTicker saturation). Baseline `data/skill-stream.jsonl` snapshotted at 424 records as `.pre-bt7b.bak`; post-regression run appended 49 new records (473 total). Two newly-wrapped skills fired in-engine: `autoBreakStuckPlant` ×34 (all `outcome=abort`, matching the "no stuck plant present" fast-path) and `defendSelf` ×15 (13 `abort`, 2 `success` — bot responded to incidental mob proximity during the escape-zone loop). Sample record: `{"t":"2026-04-18T02:38:46.196Z","name":"autoBreakStuckPlant","args_str":"[]","ms":2,"outcome":"abort","err_class":null,"notes":null}`. Format byte-identical to pre-BT-7b BT-7 records. ✅
- **Live natural trigger for the other 29 is gated by world state.** The bot has been locked in `escapeProtectedZone` (mutex holder) since startup — this is the known pre-compaction stuck state, not a BT-7b regression. Issuing a new goal would queue behind the active escape rather than exercise the new wraps. Accepted under the BT-6/BT-9/BT-10/BT-bundle/BT-3b acceptance pattern — synthetic-proven across all three outcome branches + parse-clean + import-clean + live-regression-clean on two representative wraps (one wave-1 combat, one wave-3 world) is sufficient; waiting for the bot to naturally traverse 29 more skill categories would block indefinitely.

**Philosophy alignment.** Principle 5 (finish the migration — every public skill in `src/agent/library/skills.js` now ships the uniform `[Skill]` telemetry BT-7 introduced; the dormant per-skill `[Skills]` log variants that BT-7 explicitly deferred are now unified under a single wrapper). Principle 8 (fail / emit loudly — every skill round-trip now produces a greppable structured line regardless of which outcome branch fires; `outcome=abort` is no longer silent on the 31 previously-unwrapped skills). Rule 10 (surgical changes — only the rename-impl pattern applied; no adjacent refactors; no ad-hoc `[Skills]` log removals in this pass because the uniform line runs in addition to, not instead of, any pre-existing log — Principle 5 redundancy cleanup can happen in a follow-up once we confirm nothing downstream greps for the old format). Rule 9 (simplicity — two utility primitives deliberately excluded from the wrap list to prevent double-counting on nested calls).

**Downstream unblock.** Closes the skill-library side of the observability story. Pre-BT-7b: a tailer reading `[Skill]` lines saw only the 11 hottest skills and had to cross-reference ad-hoc `[Skills]` logs (where present) to reconstruct what the bot actually did. Post-BT-7b: one `grep '^\[Skill\]' tmux-buffer` surfaces every public skill round-trip in the agent library uniformly — `name=` disambiguates which skill fired, `outcome=` classifies success/abort/error without having to read the skill's internal return-value convention, `ms=` quantifies duration, `err_class=` surfaces the throw type on failures. The two-tier observability story (lifecycle: BT-7 + BT-7b skills + Goal + BT-6 paths; measurement: BT-5) is now complete on the lifecycle side at the fleet level.

**What didn't ship (kept narrow on purpose).**
- No changes to the two skip-list primitives (`wait`, `goToGoal`). Wrapping them would emit misleading nested lifecycle lines on every skill that calls them as infrastructure.
- No ad-hoc `[Skills]` log removals inside the 31 wrapped skills. The uniform `[Skill]` line runs alongside any pre-existing skill-internal log. Principle 5 cleanup of the redundant variants can happen in a follow-up pass once we confirm no downstream reader depends on the legacy format.
- No callsite changes outside `skills.js`. Every caller imports the public export by name and sees an identical signature; the wrap is transparent.
- No taxonomy changes to `wrapSkill` / `configureSkillLifecycle`. The BT-7 design (success-truthy, abort-false, error-throw, 80-char args cap, `argSelector` default drop-first-positional) survives one more full sweep unchanged — no adjustment needed after the live-data review that the BT-7b trigger originally required.
- No changes to `data/skill-stream.jsonl` schema. Same record shape BT-7 established (`t, name, args_str, ms, outcome, err_class, notes`). Just more records from more names.

**Next in the logging roadmap:** Observability migration phase fully closed at the library level — BT-1 through BT-12, BT-bundle(a/b/c), BT-3b, and BT-7b all shipped. Nothing trigger-gated remains. The `src/agent/library/skills.js` file is now fully covered at the export-lifecycle layer. Any future observability work will be new entries (not migration follow-ups).

### 2026-04-17 — BT-3b LLM adapter sweep: `withLLMMetrics` wrap landed on the remaining 18 files (+ `azure.js` inherits) ✅

Shipped `8580a11` same day on top of BT-bundle(c), closing the Principle 5 migration BT-3 started. Before BT-3b, `src/models/lmstudio.js` was the only adapter that emitted the uniform `[LLM]` structured telemetry line BT-3 introduced; the other 19 files (`azure, cerebras, claude, deepseek, gemini, glhf, gpt, grok, groq, huggingface, hyperbolic, mercury, mistral, novita, ollama, openrouter, qwen, replicate, vllm`) retained their original ad-hoc per-adapter logging. Every LLM round-trip across the fleet now emits exactly one `[LLM] label=… model=… elapsed_ms=… prompt_tok=… completion_tok=… total_tok=… tok_per_s=… retries=… finish=… cache_hit=… status=ok|error` line, regardless of which provider the active profile points at. 344 insertions, 108 deletions across 18 files.

**Files (18 shipped + 1 inherits):**
- **Shape A — OpenAI-compatible (default `extractUsage`):** `cerebras.js`, `deepseek.js`, `grok.js`, `groq.js`, `novita.js`, `openrouter.js`, `vllm.js`, `mercury.js` (chat + embed), `glhf.js`, `qwen.js` (chat + embed), `gpt.js` (dual-path: `chat.completions.create` AND `responses.create` AND embed — three call sites in one file). Each wrap: `import { withLLMMetrics } from '../utils/retry.js'` + `withLLMMetrics({ label, model }, () => <original call>)` around the async API site.
- **Shape A — inherited (no direct edit):** `azure.js` extends `GPT`; `gpt.js`'s label argument was changed from a hardcoded `'GPT'` to `this.constructor.name`, so instantiating `AzureGPT` (which subclasses GPT) produces `label=AzureGPT` on every `[LLM]` line with zero edit to `azure.js` itself.
- **Shape B — Anthropic (`claude.js`):** custom `_extractClaudeUsage` maps `response.usage.{input_tokens, output_tokens}` → `{prompt_tokens, completion_tokens}`, sums to `total_tokens`, reads `response.stop_reason` as `finish_reason`, and folds `response.usage.cache_read_input_tokens > 0` into the `cache_hit` boolean.
- **Shape B — Google (`gemini.js`):** custom `_extractGeminiUsage` maps `response.usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}` → prompt/completion/total, `response.candidates[0].finishReason` → `finish_reason`, `response.usageMetadata.cachedContentTokenCount > 0` → `cache_hit`. Chat + embed both wrapped.
- **Shape B — Mistral (`mistral.js`):** OpenAI-compatible response shape, so default extractor suffices; wrap applied to `this.#client.chat.complete(...)` and `this.#client.embeddings.create(...)` — private `#client` field preserved.
- **Shape B — Replicate (`replicate.js`):** streaming async iterator; no usage metadata on the final chunk. Inner callback consumes the iterator and returns the accumulated string; default extractor sees no `usage` field and emits all-null token fields. Stop-sequence handling inside the iterator preserved exactly. Same null-tokens-accepted convention used for embed.
- **Shape B — Ollama (`ollama.js`):** custom `_extractOllamaUsage` maps `response.eval_count` → `completion_tokens`, `response.prompt_eval_count` → `prompt_tokens`, sums to `total_tokens`, `response.done_reason` (or `done ? 'stop' : null`) → `finish_reason`. Wrap sits inside the existing think-block retry loop so each attempt emits one `[LLM]` line. Embed endpoint also wrapped with `label='Ollama-Embed'`.
- **Shape B — Hyperbolic (`hyperbolic.js`):** raw `fetch` to OpenAI-style endpoint. Custom `_extractHyperbolicUsage` is explicit (even though it matches default) because the error-path body may be malformed — explicit extractor documents the contract. Inner callback does `fetch` + `response.json()` so the extractor sees parsed JSON. Wrap sits inside the think-block retry loop.
- **Shape B — HuggingFace (`huggingface.js`):** streaming `chatCompletionStream`; no usage surfaced. Inner callback consumes the stream and returns the accumulated string; null-tokens accepted. Wrap sits inside the think-block retry loop so each regeneration attempt emits one `[LLM]` line.

**Wrap-placement convention (think-block retry loops).** Five adapters (`glhf.js`, `qwen.js`-embed, `ollama.js`, `hyperbolic.js`, `huggingface.js`) have `maxAttempts=5` think-block retry loops inside `sendRequest` — when a `<think>` block is detected without a closing `</think>`, the adapter regenerates the response. In every such adapter, the `withLLMMetrics` wrap was placed **inside** the retry loop body so each regeneration attempt emits exactly one `[LLM]` line, matching the BT-3 per-round-trip convention on `lmstudio.js`. Placing the wrap *outside* the loop would collapse N regenerations into a single `[LLM]` line — misleading when the "retries" field is meant to reflect `withRetry`'s transient-error retries, not the adapter's own think-block regenerations. The two counters stay distinct: `withLLMMetrics` counts network retries, the think-block loop counts regenerations, and one `[LLM]` line is emitted per round-trip regardless of which loop triggered the next attempt.

**`gpt.js` dual-path wrap.** `gpt.js` branches on `this.url`: with a custom URL it calls `openai.chat.completions.create(pack)`, without one it calls `openai.responses.create(pack)`. Both sites wrapped — `chat.completions.create` uses the default extractor, `responses.create` uses a local `_extractGPTResponsesUsage` that maps the OpenAI Responses API shape (`usage.input_tokens` / `usage.output_tokens`) into the unified field set. Labels: `${this.constructor.name}` and `${this.constructor.name}-Responses` respectively; embed uses `${this.constructor.name}-Embed`. Dynamic label enables the azure-inherits-from-GPT mechanic described above.

**Design decisions:**
- **`this.constructor.name` as label, not hardcoded `'GPT'` in `gpt.js`.** Enables `azure.js` (which extends GPT) to inherit the wrap verbatim and surface as `label=AzureGPT` automatically — zero edit to `azure.js`. Alternative would be to override the label in `azure.js`, which means every GPT subclass has to remember to do so. Using `this.constructor.name` makes the label follow the class hierarchy naturally and eliminates the failure mode.
- **Custom `extractUsage` callbacks live as module-top `function _extract<Provider>Usage(response)` in each Shape B adapter, not as inline arrow functions.** Keeps the wrap call site short and the extractor testable in isolation. Consistent naming (`_extract<Provider>Usage`) makes the pattern grep-friendly across the fleet.
- **Streaming adapters accept null-token fields.** `replicate.js` and `huggingface.js` use streaming APIs that don't surface token usage on the final chunk. Default extractor sees no `usage` field and returns all nulls, which the log emitter renders as `prompt_tok=? completion_tok=? total_tok=? tok_per_s=?`. Same convention BT-3 established for LMStudio embed calls that return `{prompt_tokens:0, total_tokens:0}`. Alternative would be to count tokens manually inside the iterator — not worth the complexity since `elapsed_ms` + `status` are the signals a tailer actually needs.
- **No retry-logic changes.** Out of scope. Every adapter's internal `maxAttempts=5` think-block loop is preserved unchanged; `withLLMMetrics`'s own `withRetry` handles transient network errors orthogonally. Pre-existing error-handling branches (`try/catch` around `fetch`, adapter-specific `'context length exceeded'` handling in `hyperbolic.js` + `ollama.js`) are preserved byte-identical.
- **No new module.** The wrap is `withLLMMetrics` from `src/utils/retry.js` — shipped in BT-3. No new observability emitter introduced. Each adapter touches: one import line + one (or two, for dual-path adapters) wrap call + optionally one custom extractor function at the top of the file.
- **Embed calls wrapped where present.** Some adapters throw for embed (`claude, deepseek, cerebras, glhf, grok, groq, huggingface, hyperbolic, novita, openrouter, vllm, azure` — 12 throw immediately with `'Embeddings are not supported by <Provider>.'`); those are unchanged. Embed-capable adapters (`mercury, gpt/azure, qwen, mistral, gemini, ollama, replicate`) ship with `label=<Provider>-Embed` wraps.

**Rule 7 "Complete the perimeter" audit.** Each of the 18 modified adapter files is localized to its own class's API call sites. Grep of each modified file for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches — model adapters don't hold a mineflayer `bot` reference; they operate on conversation turns + system messages + return-string or embedding-vector payloads. Zero new state on any adapter class. Zero new listeners. Success path byte-identical to pre-wrap behavior on every adapter (each wrap forwards the raw response unchanged through its success branch). The `gpt.js` label switch from `'GPT'` to `this.constructor.name` is the only behavioral change, and it only affects the `label=` field of the log line — not the return value, not the error path.

**Verification — synthetic-proven + live-regression clean:**

- `node --check` parse-clean on all 19 adapter files (18 modified + azure). ✅
- Dynamic `import()` resolves on all 19 — confirms the new imports and top-level extractor functions don't break module load. ✅
- Synthetic log-capture test (`/tmp/bt3b_synth.mjs`): mock Shape A response (OpenAI-shape `{choices:[{finish_reason:'stop'}], usage:{prompt_tokens:12, completion_tokens:34, total_tokens:46}}`, label `Mercury`) + mock Shape B response (Anthropic-shape `{stop_reason:'end_turn', usage:{input_tokens:50, output_tokens:100, cache_read_input_tokens:25}}`, label `Claude`). Captured `[LLM]` lines confirmed exact format match: Mercury → `prompt_tok=12 completion_tok=34 total_tok=46 finish=stop status=ok`; Claude → `prompt_tok=50 completion_tok=100 total_tok=150 finish=end_turn cache_hit=true status=ok`. 2/2 checks passed. ✅
- **Live post-restart on `8580a11`:** gaming-server tmux session `mindcraft-mcgavin` was torn down and relaunched on the new SHA. Bot connected to MC, spawned as `ThatCoolGuyDude`, StateTicker resumed ticking normally. 115 `[LLM] label=LMStudio-Embed ...` lines captured within 25s of restart, format byte-identical to pre-BT-3b (`elapsed_ms=<n> prompt_tok=0 completion_tok=? total_tok=0 tok_per_s=? retries=0 finish=? cache_hit=? status=ok`). Confirms BT-3's LMStudio wrap path survived the BT-3b diff cleanly and `retry.js` was undisturbed. ✅
- **Live natural trigger for the other 17 is out of reach by construction.** JP's only active provider is LM Studio; chat completions from the other adapters never fire in this profile. Accepted under the BT-6/BT-9/BT-10/BT-bundle acceptance pattern — synthetic-proven + parse-clean + import-clean + live-regression-clean on the one active provider is sufficient; waiting for JP to reconfigure to every other provider would block indefinitely.

**Philosophy alignment.** Principle 5 (finish the migration — every adapter now ships the same `[LLM]` telemetry format BT-3 introduced; the dormant per-adapter error-handling variants that BT-3 explicitly deferred are now unified under a single wrapper). Principle 8 (fail / emit loudly — switching profile to Claude, Gemini, GPT, Ollama, or any other provider no longer drops the bot into an opaque I/O surface; every round-trip produces a greppable structured line regardless of provider). Principle 1 (reduce LLM reliance — tok_per_s, elapsed_ms, retries, finish_reason, cache_hit are all mechanical signals the bot itself doesn't need to reason about; the telemetry surfaces them at emit time for a human-facing tailer).

**Downstream unblock.** Closes the model-fleet side of the observability story. Pre-BT-3b: reading a postmortem required knowing which adapter was active + which error-handling style that adapter used + whether it logged anything at all. Post-BT-3b: one `grep '^\[LLM\]' tmux-buffer` surfaces every round-trip from every provider uniformly — `label=` disambiguates which adapter fired. Every failure class (`finish=length`, `finish=content_filter`, `status=error err_class=HTTPError`, etc.) is now comparable across providers. The dormant-code migration concern (BT-3 explicitly deferred because "Migrating all 19 without real credentials to test each risks shipping broken error paths to code JP does not exercise") is resolved by the synthetic + parse-clean + import-clean verification triple: the wrap is transparent on the success path (return value unchanged), and the error path routes through `withRetry` + `withLLMMetrics`'s terminal-error log line which has been battle-tested on LMStudio for the full BT-3 → BT-bundle(c) run.

**What didn't ship (kept narrow on purpose).**
- No retry-logic changes. Each adapter's internal `maxAttempts=5` think-block loop stays. `withLLMMetrics` adds its own `withRetry` for transient network errors; the two loops are orthogonal and compose cleanly.
- No removal of per-adapter retry logic. Even where `withRetry` might subsume an adapter's manual retry, Rule 10 (surgical changes) says don't touch what isn't broken; the manual retries carry adapter-specific policy (e.g., `ollama.js` context-length handling with `turns.slice(1)`) that isn't a candidate for generic replacement.
- No new sink beyond console `[LLM]` lines. Matches BT-3's console-only convention. Aggregation is a reader's job.
- No behavior change on the success path. Every `sendRequest` returns the same raw string it did before, through the same code path, with the same error-classification branches. The wrap observes; it does not transform.
- No change to `azure.js`. The inheritance-driven label mechanic made a direct edit unnecessary; Rule 10 (don't touch what isn't broken) applied at the file level.

**Next in the logging roadmap:** Observability side is fully closed at the system level — BT-1 through BT-12, BT-bundle(a/b/c), and BT-3b all shipped. BT-7b (~72 remaining skill wraps in `src/agent/library/skills.js`) is the only migration follow-up still open; it stays trigger-gated on "BT-7's live-stream data has been reviewed and the wrapper format is confirmed sound." Nothing new on the observability side of the roadmap.

### 2026-04-17 — BT-bundle(c) File I/O silent-swallow: six catch branches tightened across 5 files (including one latent-bug fix on `prompter.js:134`) ✅

Shipped `4b7fc33` same day on top of BT-bundle(b), closing the third and final BT-bundle item. Before BT-bundle(c), the L3 audit (April 15) had flagged "27 `readFileSync` + 8 async `fs.readFile/writeFile` calls — audit each `catch` branch for 'logged or swallowed.'" Full re-enumeration 2026-04-17 found 21 I/O callsites on `develop` (13 reads + 8 writes; the L3 count had included `existsSync` pre-checks which don't throw). All 13 reads had catch-and-log, but four write sites had silent-swallow or misleading patterns and two read sites logged weakly — so under a disk-full, permission-denied, or malformed-JSON scenario, the affected paths produced no greppable structured line. BT-bundle(c) closes that gap for ~17 lines of real change (+ explanatory comments) across 5 files.

**Files (5 shipped):**
- `src/models/prompter.js` (line 134) — **real latent bug fix**. Prior pattern was `writeFileSync(path, data, (err) => { if (err) throw ... })`. Sync `writeFileSync` does not accept a callback; the arrow was silently discarded by Node. A real write failure (ENOSPC, EACCES) threw synchronously and the intended "Failed to save profile" message never appeared. Now wrapped in a proper try/catch with `[Prompter] Failed to save profile <path>: <err.message>` log + `throw err` so the caller still sees the failure. Existing `console.log("Copy profile saved.")` preserved on the success branch.
- `src/agent/history.js` (line 83) — init `writeFileSync(this.full_history_fp, '[]', 'utf8')` was *outside* the existing try/catch. A missing `histories/` dir or permission error would propagate up into async `appendFullHistory()`'s caller (`add()`) with no catch → unhandled rejection, no `[History]` log. Wrapped with its own try/catch, logs `[History] init write failed <path>: <err.message>`, resets `full_history_fp = undefined` so a later call may retry, and returns gracefully (non-fatal — a full-history init failure shouldn't kill the session).
- `src/agent/history.js` (line 89) — misleading-label rename. The catch-block at line 89 wraps `readFileSync → JSON.parse → turns.push → writeFileSync`; the catch message read `'Error reading ${this.name}'s full history file'`. A write-side throw (ENOSPC, EACCES) got mislabeled "reading." Renamed to `'Error appending to ${this.name}'s full history file'` — "appending" accurately covers the whole read-parse-push-write sequence and correctly describes what the try-block is doing.
- `src/agent/vision/camera.js` (line 62) — screenshot `await fs.writeFile(filepath, buf)` had no local try/catch and the caller (`vision_interpreter.js`) doesn't wrap either. A disk-full or permission error would bubble up through the vision command handler with no `[Camera]` prefix. Wrapped with try/catch, logs `[Camera] screenshot save failed (<path>): <err.message>`, re-throws so the caller's existing failure-unwinding stays intact — the log just surfaces *where* in the vision pipeline the failure happened.
- `src/agent/npc/controller.js` (line 45) — weak-log tightening. Prior: `console.error('Error reading construction file')` — no prefix, no error message, no filename. Now: `` console.error(`[NPC] Error reading construction files from src/agent/npc/construction: ${e.message}`) `` — prefix + directory path + error message. Directory is fixed so path context is implicit; the file-level granularity inside the loop was unreachable anyway (the try wraps the whole `readdirSync`+loop, so `file` isn't in scope when `readdirSync` itself throws).
- `src/utils/keys.js` (line 5) — parse-vs-missing disambiguation. Prior: `console.warn('keys.json not found. Defaulting to environment variables.')` for every error class (ENOENT, SyntaxError, EACCES all produced the identical message). Now branches on `err.code === 'ENOENT'` — ENOENT keeps the original message verbatim (backward-compatible for anyone grepping for it); parse/permission errors emit `` `[Keys] keys.json read/parse failed: ${err.message}. Defaulting to environment variables.` ``.

**Format:**
- Profile save failure: `[Prompter] Failed to save profile ./bots/ThatCoolGuyDude/last_profile.json: EACCES: permission denied`
- First-append init-write failure: `[History] init write failed ./bots/ThatCoolGuyDude/histories/2026-04-17-12-34-56-789-AM.json: ENOENT: no such file or directory`
- History append cascade failure: `Error appending to ThatCoolGuyDude's full history file: ENOSPC: no space left on device`
- Screenshot save failure: `[Camera] screenshot save failed (/path/to/screenshots/screenshot_2026-04-17T12-34-56-789Z.jpg): ENOSPC: no space left on device`
- NPC construction-dir read failure: `[NPC] Error reading construction files from src/agent/npc/construction: ENOENT: no such file or directory`
- keys.json parse failure: `[Keys] keys.json read/parse failed: Unexpected token } in JSON at position 42. Defaulting to environment variables.`
- keys.json missing (backward-compat): `keys.json not found. Defaulting to environment variables.`

**Design decisions:**
- **Explicit re-throw in `prompter.js:134` and `camera.js:62`.** Both sites have callers that don't catch — `Prompter`'s constructor and `vision_interpreter.js`'s `capture()` chain. Without the re-throw, a write failure would be logged *and silently eaten*, which is worse than the prior behavior (at least the prior uncaught throw reached BT-bundle(b)'s `uncaughtException` handler and produced *some* structured line before the process exited). Re-throwing after logging gives the reader both: a local `[Prompter]` / `[Camera]` stamp at the fault site, *and* the existing propagation through the uncaught-exception chain if nothing catches it downstream.
- **Graceful-return + `fp = undefined` reset in `history.js:83`.** The init-write failure path takes a *different* design choice than the re-throw sites. A full-history init failure shouldn't kill the session — it's diagnostic, not mission-critical. Setting `full_history_fp = undefined` means the next `appendFullHistory` call will re-enter the init branch and retry, so a transient failure (dir wasn't ready, race with a housekeeping process) self-heals without manual intervention. Logging + returning matches the "non-fatal logging" tone of the existing line-89 catch.
- **Misleading-rename, not "add a second catch."** `history.js:89` was one logical operation (read-modify-write the full history), not three. Splitting into read-catch / parse-catch / write-catch would have grown the method body disproportionally to the signal gain. Renaming "reading" → "appending" fixes the label without restructuring.
- **`err.code === 'ENOENT'` branch in `keys.js`, not string-match on message.** The ENOENT check is structured (survives locale changes, Node version bumps); a string-match on "ENOENT" in `err.message` would be brittle. Keeps the original ENOENT message byte-identical for anyone with `grep 'keys.json not found'` in their tooling.
- **`[NPC]` prefix chosen over `[Construction]` or `[NPCController]`.** Matches the existing subsystem-naming pattern (`[StateTicker]`, `[BootSnapshot]`, `[BotMutex]`, `[Exit]`, `[Prompter]`) — short, unambiguous, and consistent with how a reader visually parses the tmux stream. The three-character shorter prefix also means the message body gets more horizontal budget.
- **No JSONL sink.** Matches the existing `[Boot] snapshot file write error`, `[ProtectedZone]`, `[MindServer]`, `[Prompter]`, `[Coder]` conventions — file-I/O failure logging stays console-only. Aggregation is a reader's job, not an emitter's.
- **No retry / backoff logic.** Out of logging scope. A separate concern; adding retry would change behavior semantics beyond the "tighten the catch branches" mandate.
- **No changes to the 13 read catch branches that already log.** Only the two weakly-logged reads (`controller.js:45` and `keys.js:5`) got a tighter message. Rule 10 (surgical changes) — don't touch what isn't broken.
- **No `existsSync` review.** 8 callsites, but `existsSync` doesn't throw — it returns boolean. Failures are logical, not exceptional; logging them is not a catch-branch concern.

**Rule 7 "Complete the perimeter" audit.** Grep of all 5 modified files for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches for any new code. `prompter.js`: no bot reference exists at this scope (the `Prompter` class doesn't hold a bot ref; the save-profile write is pure filesystem work); the wrap is try/catch + log + re-throw only, zero mineflayer API touched. `history.js` `appendFullHistory`: the new init-try/catch wraps `writeFileSync('[]', 'utf8')` and a local variable reset; the renamed line-89 catch message is a string change only; neither touches the bot, the read/write pipeline, or any append logic downstream. `controller.js` `init()`: one-line message tightening on an existing catch that wraps `readdirSync` + `readFileSync` + `JSON.parse`; the downstream block-padding loop and `bot.on('idle', ...)` handler registration are untouched. `keys.js`: module-top try/catch at import time, no bot reference exists at this scope, `getKey`/`hasKey` exports unchanged, `readFileSync`/`JSON.parse` pipeline unchanged. `camera.js` `capture()`: try/catch wraps only the existing `await fs.writeFile(filepath, buf)` call; `imageStream = this.canvas.createJPEGStream(...)` / `getBufferFromStream` / `_ensureScreenshotDirectory` / `console.log('saved', ...)` sequence is unchanged; the `throw err` inside the new catch preserves the caller's existing failure-unwinding. No bot mutation, no new listeners, no new state on any class.

**Verification — synthetic-proven + live-smoke:**

- `node --check` parse-clean on all 5 modified files. ✅
- Synthetic test `test_btc.mjs` — 14/14 checks passed. ✅ Real I/O exercised every failure path:
  1. **`prompter.js:134`** — `mkdtempSync` + `chmodSync(0o555)` creates a read-only temp dir; `writeFileSync` into it → captured `[Prompter] Failed to save profile <path>: EACCES: permission denied`, confirmed re-throw (`err.code === 'EACCES'`), confirmed filepath in log. ✅ (3 checks)
  2. **`history.js:83`** — `writeFileSync` into `/nonexistent_dir_btc_test/...` → captured `[History] init write failed <path>: ENOENT: no such file or directory`, confirmed no throw (swallowed gracefully), confirmed filepath in log. ✅ (3 checks)
  3. **`history.js:89`** — synthetic `throw new Error('boom')` inside the rename-probe catch → captured `Error appending to TestName's full history file: boom`, confirming the rename landed. ✅ (1 check)
  4. **`controller.js:45`** — synthetic `ENOENT` throw → captured `[NPC] Error reading construction files from src/agent/npc/construction: ENOENT: no such file`, confirmed `[NPC]` prefix + error message. ✅ (2 checks)
  5. **`keys.js:5` ENOENT branch** — `Object.assign(new Error(...), { code: 'ENOENT' })` → captured exact legacy message `keys.json not found. Defaulting to environment variables.` ✅ (1 check)
  6. **`keys.js:5` parse-error branch** — `new SyntaxError('Unexpected token } in JSON')` (no ENOENT code) → captured `[Keys] keys.json read/parse failed: Unexpected token } in JSON. Defaulting to environment variables.` ✅ (1 check)
  7. **`camera.js:62`** — `await writeFile('/nonexistent_dir_btc_test/screenshot.jpg', ...)` → captured `[Camera] screenshot save failed (<path>): ENOENT: no such file or directory`, confirmed re-throw (`err.code === 'ENOENT'`), confirmed filepath in log. ✅ (3 checks)
- **Live post-restart on `4b7fc33`:** gaming-server tmux session `mindcraft-mcgavin` was torn down and relaunched on the new SHA. `ThatCoolGuyDude spawned` observed. `[StateTicker] started: interval=1000ms console=true file=data/state-stream.jsonl` observed. StateTicker ticks continued normally (health=20 food=11, position numeric, no held=true stubs). No `[Prompter] Failed to save profile`, no `[History] init write failed`, no `[NPC] Error reading construction files`, no `[Keys] keys.json read/parse failed`, no `[Camera] screenshot save failed` lines in the boot buffer — confirmed happy path byte-identical to pre-BT-bundle(c). ✅
- **Live natural failure trigger awaited:** all 6 fix sites fire on failure only — none have a natural happy-path trigger that would exercise the new log lines in normal play. Per the BT-6 / BT-9 / BT-10 / BT-bundle(a) / BT-bundle(b) acceptance pattern, synthetic-proven + live-smoke-clean + handlers-in-place is sufficient; we do not block progress waiting for a disk-full or permission error to happen on the gaming server.

**Philosophy alignment.** Principle 8 (fail / emit loudly — six previously-silent or mislabeled failure surfaces now produce greppable `[Prompter]` / `[History]` / `[NPC]` / `[Keys]` / `[Camera]` lines; a postmortem reader can `grep '^\[Prompter\]\|^\[History\]\|^\[NPC\]\|^\[Keys\]\|^\[Camera\]' tmux-buffer` and see every file-I/O failure from the session). Principle 5 (finish the migration — BT-bundle(c) closes the last unaudited silent-failure surface flagged by the April 15 L3 audit; BT-bundle(a) + BT-bundle(b) + BT-bundle(c) together complete the BT-bundle; the #15 `full_state.js` sweep pattern is now applied to the whole codebase's file-I/O perimeter). Principle 1 (reduce LLM reliance — a human-facing tailer reading a postmortem can pinpoint *which* subsystem's file-I/O failed without having to guess from a generic "Error reading..." message or a stack trace; the structured prefix + path + error.message triple does the work at emit time).

**Downstream unblock.** Closes the BT-bundle entirely. Pre-BT-bundle state: observability roadmap had 3 known gaps (mutex wait duration, process exit reasons, file-I/O silent-swallow). Post-BT-bundle state: 0 known gaps on the observability-minor side of the roadmap. Every user-visible file-I/O operation now emits a structured `[<Subsystem>] ...` line on failure, matching the `[StateTicker]` / `[BootSnapshot]` / `[LLM]` / `[Exit]` conventions. The `[Prompter]:134` bug fix is a bonus — even without BT-bundle(c)'s logging motivation, that callback-on-sync-writeFileSync was a real latent bug that would have surfaced the moment someone tried to save a profile to a read-only dir; now it surfaces cleanly with a structured log instead of a silent throw.

**What didn't ship (kept narrow on purpose).**
- No JSONL sink. Console-only matches the existing `[Prompter]` / `[Boot]` / `[Coder]` conventions for file-I/O failure logs.
- No retry / backoff logic. Out of logging scope; adding retry would change behavior semantics beyond "tighten the catch branches."
- No `readFileSync` changes beyond the two weak-log reads. The other 11 reads already log with prefix + path + error message; Rule 10 (surgical changes) — don't touch what isn't broken.
- No `existsSync` review. `existsSync` doesn't throw; failures are logical, not exceptional.
- No new observability module. The 6 fix sites sit inline with the code they protect; a dedicated "file-I/O emitter" module would add indirection for zero signal gain.
- No full-stack capture. Prior art (BT-bundle(b) `stack_head` is first-frame-only) keeps structured lines single-line-greppable; `err.message` is sufficient context for pattern-matching.

**Next in the logging roadmap:** BT-bundle complete. BT-3b (19 LLM adapter sweep) and BT-7b (~72 remaining skill wraps) both remain trigger-gated by "more adapters/skills actually firing in live play"; neither is promoted until the corresponding subsystem actually fires enough in live play to matter. Nothing new on the observability side of the roadmap. _(Updated 2026-04-17 later same day: BT-3b subsequently promoted by JP and shipped `8580a11`; only BT-7b remains trigger-gated.)_

### 2026-04-17 — BT-bundle(b) Process exit reasons: structured `[Exit]` log points covering every shutdown path Node naturally reaches ✅

Shipped `46024a6` same day on top of BT-bundle(a), continuing the BT-bundle remainder. Before BT-bundle(b), `src/agent/agent.js cleanKill(msg, code)` called `this.bot?.chat(msg)` + `this.history.save()` + `process.exit(code)` with no structured log line. `process.on('exit')`, `process.on('uncaughtException')`, and `process.on('unhandledRejection')` were not wired anywhere — neither in `src/process/init_agent.js` (the child-process entry point) nor in `src/agent/agent.js`. A session-replay reader saw the tmux buffer end mid-sentence with no indication of whether the process shut down cleanly (`cleanKill` from spawn-timeout / duplicate login / task complete), crashed (uncaught error or unhandled rejection), or drained the event loop naturally. BT-bundle(b) closes that gap with four structured log points and 20 lines of real change across two files.

**Files (2 shipped):**
- `src/process/init_agent.js` — three `process.on(...)` handlers installed at module top level, above the existing `(async () => { ... })()` IIFE. `'exit'` handler logs `[Exit] event=process_exit code=${code}` (single-line, no side effects — `exit` must be synchronous in Node). `'uncaughtException'` handler quotes the error message and trims the first stack frame, logs `[Exit] event=uncaught err="..." stack_head="..."`, then calls `process.exit(1)` explicitly. `'unhandledRejection'` handler quotes the reason and logs `[Exit] event=unhandled_rejection reason="..."` then calls `process.exit(1)`.
- `src/agent/agent.js` — one prepended line in `cleanKill(msg, code)` before the existing `history.add` / `bot.chat` / `history.save` / `state_ticker.stop` / `process.exit` sequence: `console.log(\`[Exit] event=clean_kill code=${code} reason="<quoted msg>"\`)`. The rest of the method body is untouched.

**Format:**
- Clean intentional shutdown (`cleanKill` path — spawn timeout, duplicate login, bot-command kill/stop):
  - `[Exit] event=clean_kill code=1 reason="Killing agent process..."`
  - `[Exit] event=process_exit code=1`
- Uncaught exception in the async stack:
  - `[Exit] event=uncaught err="Cannot read properties of undefined" stack_head="at Object.execute (/RAID/mindcraft-mcgavin/src/agent/commands/...)"`
  - `[Exit] event=process_exit code=1`
- Unhandled promise rejection:
  - `[Exit] event=unhandled_rejection reason="Pathfinder.goto timed out"`
  - `[Exit] event=process_exit code=1`
- Event loop drain (no explicit exit call): `[Exit] event=process_exit code=0` alone.

**Design decisions:**
- **Two handlers, one log point per shutdown class.** Every path the Node runtime naturally reaches passes through `'exit'`, so `event=process_exit` is always the last structured line and always pairs with a `code=<n>`. The `cleanKill` log sits above the cascade so it emits even if `bot.chat` or `history.save` throws synchronously — "why" reaches the buffer before "did" has a chance to fail.
- **Explicit `process.exit(1)` in the crash handlers is load-bearing.** This was the one gotcha that nearly shipped wrong. Registering a listener on `uncaughtException` or `unhandledRejection` **suppresses Node's default crash-exit code** (1) and lets the process exit 0 instead. The parent supervisor at `src/process/agent_process.js:31` has `if (code !== 0 && signal !== 'SIGINT') { restart }` — so a crash that exited 0 would silently break the crash-restart contract. The initial implementation had `code=0` on uncaughtException; caught on synthetic test before deploy; fixed with explicit `process.exit(1)` on both crash handlers; re-verified `exit_code=1` on re-test.
- **`init_agent.js` is the right place, not `agent.js`.** `agent.js` loads after `init_agent.js`, and the mineflayer `bot` instance isn't constructed until `agent.start()`. Registering `uncaughtException` at the `agent.js` level would miss pre-bot crashes (profile-load failures, `serverProxy.connect` failures, constructor errors). Registering at `init_agent.js` catches every crash from the moment the child process boots.
- **`cleanKill` log placed before the cascade, not after.** The `history.add` / `bot.chat` / `history.save` lines can throw (bot disconnected mid-shutdown, filesystem error); placing the log first guarantees "why" reaches the tmux buffer even if the rest fails.
- **`stack_head` is trimmed to the first frame only.** Full stack traces belong in a separate fatal-error sink (not shipped); one frame is enough for a tailer to pattern-match the crash site, and keeps the structured line single-line-greppable.
- **Signal-delivered shutdowns (SIGTERM, SIGINT, `tmux kill-session`) are out of scope.** Tested via `/tmp/test_signals.mjs`: in Node, when no signal handler is registered for SIGTERM/SIGINT, the signal bypasses `process.on('exit')` entirely and the process terminates without reaching any installed listener. Handling signals would require installing a SIGTERM/SIGINT handler that calls `process.exit()`, which changes shutdown semantics (could defer or block termination) and is explicitly out of the BT-bundle(b) "logging-only" scope boundary. Filed as a future enhancement only if we add graceful-shutdown (flush-and-exit) work later.
- **No JSONL sink.** Matches the BT-bundle(a) / existing `[Exit]`-style convention — console-only, interleaved with the rest of the tmux stream for human reading. Aggregation is a reader's job.

**Rule 7 "Complete the perimeter" audit.** Grep of `src/process/init_agent.js` and the modified region of `src/agent/agent.js cleanKill` for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches for the new code (the existing `this.bot.chat(...)` in `cleanKill` predates BT-bundle(b) and is unchanged; it sits *after* the new log line, not inside it). The three `process.on(...)` handlers are additive — they don't replace or shadow any existing handler. Mineflayer's own `bot.on('error', ...)` at `agent.js:184` is a bot-level listener, not a Node-process-level one, and is untouched. The `agent_process.js:31` parent-side `agentProcess.on('exit', ...)` is in the **parent** process and sees the child's exit; BT-bundle(b) logs from the **child** process and emits its lines *before* the parent logs `Agent process exited with code ...`. Both ends appear in the same tmux stream (stdio is inherited), so a reader sees child-side reason + parent-side observation in order.

**Verification — synthetic-proven, live-deferred to natural trigger (same precedent as BT-6, BT-9, BT-10, BT-bundle(a)):**

- `node --check` parse-clean on both modified files. ✅
- Synthetic test #1 — clean exit (`/tmp/test_exit_clean.mjs`): registered handlers, called `process.exit(0)`. Captured output: `[Exit] event=process_exit code=0`. ✅
- Synthetic test #2 — uncaught throw (`/tmp/test_exit_uncaught.mjs`): registered handlers, threw inside `setImmediate`. Initial run showed `exit_code=0` (the gotcha); after adding explicit `process.exit(1)` to the handler, re-ran and captured: `[Exit] event=uncaught err="Boom!" stack_head="at Immediate.<anonymous>..."` then `[Exit] event=process_exit code=1`, exit_code=1. ✅
- Synthetic test #3 — unhandled rejection (`/tmp/test_exit_unhandled.mjs`): registered handlers, kicked off `Promise.reject('nope')`. Captured: `[Exit] event=unhandled_rejection reason="nope"` then `[Exit] event=process_exit code=1`, exit_code=1. ✅
- Synthetic test #4 — signal delivery (`/tmp/test_signals.mjs`): sent SIGTERM to a Node process with the handlers registered. `process.on('exit')` did **not** fire (documented as out-of-scope; Node bypasses `exit` on signal termination when no signal handler is installed). ✅
- **Live post-restart on `46024a6`:** gaming-server tmux session `mindcraft-mcgavin` was torn down and relaunched on the new SHA. The old child process (`PID ...`) was the first natural shutdown on the new code; the parent-side `Agent process exited with code ...` line appeared in the buffer as expected. Bot running on `46024a6` (PID 2849076) with all three `process.on(...)` handlers installed; `/tmp/bot-mutex-live.log` pipe-pane still active for BT-bundle(a) capture.
- **Live natural cleanKill trigger awaited:** `cleanKill` fires on spawn timeout, duplicate login, bot-command `!kill` / `!stop`, and task-complete paths — none of which have fired since the 46024a6 deploy. Per the BT-bundle(a) / BT-6 / BT-9 / BT-10 acceptance pattern, synthetic-proven + live-handlers-installed + awaiting natural trigger is sufficient; we do not block progress waiting for a natural shutdown to happen.

**Philosophy alignment.** Principle 8 (fail / emit loudly — previously-invisible end-of-session reason now leaves a greppable line with code; `grep '^\[Exit\]' tmux-buffer` gives every shutdown's reason-and-code in order). Principle 5 (finish the migration — BootSnapshot shipped the *beginning* of a session, StateTicker shipped the *middle*; BT-bundle(b) finishes the triad by shipping the *end*). Principle 1 (reduce LLM reliance — a human-facing tailer reading a postmortem can now answer "did this process die cleanly, crash, or get killed?" with one grep, without having to correlate against the parent-side exit-code log or the absence of structured output).

**Downstream unblock.** Closes the end-of-session observability story. Pairs with the parent-side `Agent process exited with code ...` log in `agent_process.js:31` — child emits reason (`event=clean_kill` or `event=uncaught` or `event=unhandled_rejection`) + Node-visible exit code (`event=process_exit`), parent confirms from outside with `code` + `signal`. Any mismatch between the child's reason and the parent's observation surfaces a Node runtime oddity (e.g., if the child logs `event=uncaught` but the parent sees `code=0`, that's the Node-default-suppression bug we just fixed — regression signal).

**What didn't ship (kept narrow on purpose).**
- No SIGTERM/SIGINT handlers. Those would change shutdown semantics (graceful-shutdown hook, flush-before-exit); BT-bundle(b) is strictly logging-only. Filed as a future concern if graceful shutdown becomes a requirement.
- No JSONL sink. Console-only matches the existing `[BotMutex]` / `[StateTicker]` / `[Exit]` conventions.
- No log-level config. If a reader wants to suppress `[Exit]` lines, a grep filter is simpler than a runtime switch.
- No changes to the spawn-timeout / duplicate-login / disconnect paths. They route through `cleanKill` or `process.exit` directly, and the new log points catch them uniformly without bespoke hooks.
- No full-stack capture — first frame only. Full traces belong in a separate fatal-error sink; BT-bundle(b) keeps the structured line single-line-greppable.

**Next in the logging roadmap:** BT-bundle(c) File I/O silent-swallow audit — the final BT-bundle item. Scan the 27 `readFileSync` + 8 async `fs.readFile/writeFile` catch branches for "logged or swallowed." Already noted in the L3 audit (April 15). Risk: silent memory-save failures. Extends #15 (`full_state.js` sweep, shipped) to the whole codebase. BT-3b (19 adapter sweep) and BT-7b (~72 remaining skill wraps) remain trigger-gated.

### 2026-04-17 — BT-bundle(a) Mutex wait duration: elapsed-ms stamp appended to the `[BotMutex]` acquire log for queued-wait acquires ✅

Shipped `d87045b` same day on top of BT-10, starting the BT-bundle remainder. Before BT-bundle(a), `src/agent/bot_mutex.js` already logged queue depth on acquire (`(queue: <n>)`) — a tailer could see *that* contention happened but not *how bad* it was. A 5 ms wait and a 5,000 ms wait both produced the exact same log line. Under a concurrency bug (missed release, runaway pathfinder, cascading recovery) the only signal before BT-bundle(a) was "queue is growing" without a latency number to pair it with. BT-bundle(a) closes that gap for 4 lines of real change, all inside one function.

**Files (1 shipped):**
- `src/agent/bot_mutex.js` — `withLock`: capture `const enterT = Date.now();` and `let queued = false;` right before the FIFO wait `while` loop; set `queued = true;` on each loop iteration (cheap, same value on repeats); after acquisition compute `const waitMs = queued ? Date.now() - enterT : 0;`; append `${queued ? ` wait=${waitMs}ms` : ''}` to the existing acquire log line.

**Format:**
- Uncontended acquire: `[BotMutex] #42 acquired: safeToss` (byte-identical to before BT-bundle(a)).
- Contended acquire, queue was drained by our turn: `[BotMutex] #43 acquired: safeToss wait=14ms`.
- Contended acquire, more waiters behind us: `[BotMutex] #44 acquired: safeToss (queue: 1) wait=14ms`.

**Design decisions:**
- **Flag-flip inside the loop, not "1 − reentrant check" outside.** The reentrant early-return already returns without any acquire — we never reach the wait loop from a reentrant call. So `queued` is a pure first-acquire signal. Setting it inside the loop body (where it flips to `true` the moment the caller actually awaits) is precise and survives refactors that add other bail-out paths before the loop.
- **`Date.now()`, not `performance.now()`.** The mutex lives in the main bot process, not a worker; `Date.now()` is sufficient for human-readable ms and matches the existing `[StateTicker]` / `[LLM] elapsed_ms` conventions. No sub-millisecond precision needed — contention on this mutex is measured in tens or hundreds of ms.
- **Uncontended is byte-identical.** When `queued === false`, the template literal's trailing segment evaluates to `''`, which the JS engine elides at runtime — and more importantly, we skip the `Date.now()` call on release entirely (`waitMs = queued ? ... : 0` short-circuits). A log tailer cannot tell a post-BT-bundle(a) uncontended line from a pre-BT-bundle(a) one. This matters because the uncontended path is the vast majority (state-stream.jsonl: 27,111 of 27,317 ticks = 99.25% had `mutex.queue == 0`).
- **No release-side timing.** Hold duration is a separate concern (how long did the critical section actually run?) with different signal-to-noise properties (almost every skill spends >10 ms holding; almost no skill *ever* waits). BT-bundle(a) is narrow by design — just wait duration.
- **No JSONL sink.** Other observability modules ship a paired `data/*-stream.jsonl` for structured ingestion; BT-bundle(a) emits console-only. Mutex lines are already interleaved with the rest of the tmux stream for human reading, and the existing StateTicker `mutex.queue` field in `data/state-stream.jsonl` covers the structured ingestion case. A third sink would be redundant.

**Rule 7 "Complete the perimeter" audit.** Grep of `src/agent/bot_mutex.js` for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches. The new work inside `withLock` is a `Date.now()` read, a local flag, a subtraction, and a template literal append — no bot mutation, no new listeners, no new state on the `BotActionMutex` instance. The mutex's own state machine (`_holderToken`, `_holderLabel`, `_queue`, `_acquireCount`) and reentrant early-return path are untouched.

**Verification — synthetic-proven, live-deferred to natural trigger (same precedent as BT-6, BT-9, BT-10):**

- Synthetic test (Node REPL, `node test_mutex.mjs` on a scratch copy of the file):
  1. **Uncontended:** `withBotLock('uncontended', sleep(5))` → logs `#1 acquired: uncontended` (no `wait=`, no `(queue:)`). ✅
  2. **Contended:** `withBotLock('first', sleep(50))` + after 1 ms `withBotLock('second', sleep(5))` → first logs `#2 acquired: first` (no `wait=`); second logs `#3 acquired: second wait=50ms`. ✅
  3. **Reentrant:** `withBotLock('outer', async () => { await sleep(2); await withBotLock('inner-should-not-log', sleep(2)); })` → logs only `#4 acquired: outer` + `#4 released: outer`. The inner acquire is fully suppressed by the reentrant early-return (not just wait-less — the entire acquire/log flow is skipped). ✅
  4. **Three-deep contention:** `q1 (sleep 40)` + 1 ms gap + `q2 (sleep 40)` + 1 ms gap + `q3 (sleep 5)` → q1 logs no wait; q2 logs `(queue: 1) wait=39ms`; q3 logs `wait=84ms` (no `(queue:)` because queue drained to 0 by q3's turn). Ascending wait values as expected; `(queue:)` + `wait=` fields are independent as designed. ✅
- **Live post-restart on `d87045b`:** `./start.sh` booted the tmux session `mindcraft-mcgavin`; first post-restart tmux capture showed six uncontended acquires — `#1 escapeProtectedZone` + `#2..#5 cmd:!digDown` + `#6 cmd:!digDown` — all logged without `wait=`, confirming the byte-identical-uncontended contract holds in the real bot process.
- **Live contended acquire capture:** natural triggers depend on self-preservation firing while a skill holds the lock. Historically (`data/state-stream.jsonl`, 27,317 ticks), 206 ticks (~0.75%) have observed `mutex.queue>=1` — so contention is real and recurring, just bursty. The 2000-line tmux `history-limit` on the `mindcraft-mcgavin` session rolls past old acquires; to catch a natural `wait=` line durably, `tmux pipe-pane -t mindcraft-mcgavin 'grep --line-buffered "\[BotMutex\]" >> /tmp/bot-mutex-live.log'` is installed on gaming, streaming every future acquire line to a persistent file for later inspection. This is exactly the BT-6/BT-9/BT-10 acceptance pattern: synthetic-proven, byte-identical-uncontended confirmed live, natural contended trigger awaited without blocking progress.

**Philosophy alignment.** Principle 8 (fail / emit loudly — previously-invisible wait scale now leaves a greppable number; `grep 'wait=' tmux-buffer | sort -t= -k3 -n -r` gives instant worst-case ranking). Principle 5 (finish the migration — the mutex already had queue-depth logging, which was half the contention story; BT-bundle(a) finishes it by adding the latency half). Principle 1 (reduce LLM reliance — a human-facing tailer or postmortem reader can now answer "was the bot starved by the lock?" with a number, without having to rerun the scenario or correlate timestamps manually).

**Downstream unblock.** Pairs with BT-5 AutoRecovery stats: when recovery sprays lock acquires into an already-busy mutex, BT-5 tells us recovery fired and BT-bundle(a) tells us how much the lock queue slowed it. Also pairs with BT-6 Pathfinder telemetry: path attempts that went `timeout` or `stuck_reset` can now be cross-referenced against the mutex queue depth + wait at the moment pathfinder called `goto`, surfacing whether the slow path was pathfinder's fault or mutex-contention tax.

**What didn't ship (kept narrow on purpose).**
- No release-side / hold-duration timing. Different concern, filed implicitly for later if signal demands.
- No p50/p95/p99 aggregation. Log-only; any aggregation is a reader's job (a one-liner awk over the tmux buffer suffices).
- No `data/mutex-stream.jsonl` sink. Console-only matches existing `[BotMutex]` convention; `[StateTicker]` already structures `mutex.holder` + `mutex.queue` in `state-stream.jsonl` for structured ingestion.
- No change to the reentrant path (still suppresses all logging for nested `withBotLock` calls — which is the correct behavior; nested acquires don't wait).

**Next in the logging roadmap:** BT-bundle(b) Process exit reasons — log `cleanKill` reason + `process.on('exit', ...)` signal so session replay sees the end clearly. Then BT-bundle(c) File I/O silent-swallow audit — scan the 27 `readFileSync` + 8 async `fs.readFile/writeFile` catch branches for "logged or swallowed." BT-3b (19 adapter sweep) and BT-7b (~72 remaining skill wraps) remain trigger-gated.

### 2026-04-17 — BT-10 Entity delta stream: three inline `[Entity]` lines shipped with Map-gated despawn/death correlation ✅

Shipped `ff39088` same day on top of BT-9, completing the BT-9 + BT-10 ambient-awareness logging pair. Before BT-10, the existing `bot.on('entitySpawn')` handler in `event_pipeline.js:68` already filtered for hostile/mob within 16 blocks — but only to trigger urgent-modes-update. No log line surfaced that a threat had appeared, and mineflayer's `entityGone` and `entityDead` events had zero handlers. A log tailer reading the tmux buffer could see `nearby_threats:1` in the StateTicker pulse but had no way to know *when* a threat appeared, *when* it went away, or *whether* the bot or something else killed it. BT-10 closes that gap with three inline log points and a bounded in-process Map that correlates spawn → gone/died for the entities we flagged.

**Shipped shape — three log-point groups:**

```
[Entity] event=spawn type=<name> dist=<n.n> kind=<hostile|mob>
[Entity] event=gone type=<name>
[Entity] event=died type=<name>
```

**Mount points (all in `src/agent/event_pipeline.js`):**
- **Spawn log** sits inside the *existing* 16-block hostile/mob filter on `bot.on('entitySpawn')` — the filter was already doing the "is this entity relevant?" decision for urgent-modes-update; BT-10 adds a log line and a `_trackedEntities.set(entity.id, {name, kind})` inside the same `if` branch. Entities that didn't qualify for urgent-modes (too far, passive, no position) don't get logged and don't get tracked.
- **Gone log** is a new `bot.on('entityGone')` listener. On fire, it does `_trackedEntities.get(entity.id)`; if the Map contains the entity (i.e. we logged it on spawn), it emits `[Entity] event=gone type=<name>` and `_trackedEntities.delete(entity.id)`. If the Map doesn't contain it — an ambient passive cow, a zombie that spawned at 40 blocks and never crossed our filter — the listener silently returns.
- **Died log** is a new `bot.on('entityDead')` listener with the same Map-gated emit pattern. Emits `[Entity] event=died type=<name>` only if tracked.

**Map bookkeeping (`_trackedEntities`):** keyed by `entity.id`, stores `{name, kind}`, populated exclusively inside the 16-block filter, cleared exclusively on gone/died emit. Natural bounds — size ≤ count of hostile/mob entities that have been within 16 blocks and not yet left tracking range. Mineflayer's own lifecycle (it emits `entityGone` when it stops tracking an entity) is what cleans our Map, so there's no TTL / periodic sweep / memory leak path to worry about. Worst case if an entity dies in a way mineflayer doesn't emit `entityGone` for: the Map entry leaks until bot restart. Acceptable — entry is ~40 bytes.

**Intentional exclusions (Rule 9 simplicity):**
- **No new `observability/` module.** BT-10 is ~30 lines of in-file logic; a module boundary would cost more than the abstraction saves. Rule 9 — minimum code that solves the problem.
- **No `entityMoved` / `entitySwingArm` handlers.** Mineflayer fires both at 20 Hz per entity — with 5 nearby entities, that's 100 events/sec. Zero signal value for log tailers, guaranteed context pollution for the LLM if that stream ever got in front of it. Skipped entirely.
- **No targeting check.** The whiteboard entry originally called for `[Entity] event=targeting type=<name> dist=<n.n>` when `hostile.target === bot.entity`. Mineflayer doesn't emit a dedicated event for this — it would require polling every tracked hostile's `.target` field in the main loop and remembering the previous value to detect the edge. That's real code (new state, polling interval, edge-case correctness on disconnect/respawn) with unclear signal-vs-spam trade-off. Filed as **BT-10b** to design properly later once we have live signal on how often `spawn` actually fires in practice. Whiteboard to-do entry already flagged the targeting check as a stretch.
- **No JSONL sink.** Spawn/gone/died are low-rate events; StateTicker already publishes `nearby_entities` + `nearby_threats` per tick as the structured ingest path. A third sink would be redundant.
- **Map-gated gone/died (not "log every despawn").** The quietest possible design given the goal "tell me about threats that came and went." We don't want a `[Entity] event=gone type=chicken` line every time a passive mob wanders out of tracking range, so gone/died are silent for entities we never logged on spawn.

**Verification — synthetic-proven, live-deferred to natural trigger (same precedent as BT-6, BT-9):**
- **Synthetic:** a 32-line Node script mirroring the handler logic exercised 7 cases — 2 qualifying spawns (zombie in range 8.4, creeper in range 12.36), 2 non-qualifying spawns (skeleton at 20 → too far; cow at 5 → wrong type), 1 `gone` for tracked (zombie emits), 2 `gone` for untracked (skeleton silent, cow silent), 1 `died` for tracked (creeper emits), 1 `died` for untracked (id 99 silent), 1 re-gone for already-cleared id (silent). Final Map size: 0 (correct — tracked entries properly cleared on emit). All expected lines emitted; all silent-expected cases were silent.
- **Live post-restart:** bot relaunched on HEAD `ff39088` via `start.sh`. StateTicker 1 Hz pulses unchanged (no regression on the existing observability stream). Scrollback showed `nearby_entities:[{type:spider,dist:17-18},{type:creeper,dist:19-23}]` — two hostiles visible to StateTicker but hovering just outside the 16-block filter. They correctly generated zero `[Entity]` lines — filter behaving as designed. First natural `[Entity]` emission awaits a hostile crossing the 16-block boundary (routine occurrence during gameplay, especially night / caving / combat).

**Rule alignment.**
- Rule 5 — plan presented and approved before any edit (Map-gated design, intentional exclusions, single-file blast radius).
- Rule 7 — blast-radius audit: only `src/agent/event_pipeline.js` touched; the three new `console.log` calls + `Map` operations sit alongside existing reads (`entity.id`, `entity.name`, `entity.type`, `entity.position?.distanceTo(...)`); zero `bot.dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem|pathfinder.goto` calls added.
- Rule 9 — the ship is 29 insertions in one file. Single-file, no new module, no new infrastructure. Could not be smaller without losing the spawn/gone correlation that distinguishes "threat came and went" from raw entity spam.
- Rule 10 surgical — every changed line traces directly to the spawn-log + Map-set block inside the existing filter, the two new listeners, or the constructor Map init.

**Philosophy alignment.** Principle 8 (fail / emit loudly — previously-silent hostile lifecycle now leaves greppable structured lines). Principle 5 (finish the migration — the existing `entitySpawn` handler was half-wired; BT-10 finishes it by adding the log sink and extends it naturally to gone/died). Principle 1 (reduce LLM reliance — a log tailer or session-replay reader can now answer "did a threat show up at time T?" "did the bot actually kill it or did it despawn?" without eyeballing the full StateTicker stream).

**Downstream unblock.** BT-9 + BT-10 together complete the ambient-awareness logging tier. The bot's relationship to weather, time-of-day, dimension, and nearby hostile lifecycle is now observable in the log the same way per-action lifecycle (BT-7 Skill / Goal / BT-6 Path) and prompt construction (BT-4 MemoryRecall / BT-11 ContextBuilder) already are. The remaining gaps on the observability roadmap are small: BT-bundle (mutex wait, file-I/O silent-swallow audit, process exit reasons), plus the trigger-gated BT-3b (19 adapter sweep) and BT-7b (~72 remaining skill wraps).

**Files shipped (`ff39088`, 29 insertions, 1 file):**
- `src/agent/event_pipeline.js` — constructor adds `this._trackedEntities = new Map()`; existing `entitySpawn` filter adds log + Map.set; two new `bot.on('entityGone')` + `bot.on('entityDead')` listeners.

**Next in the logging roadmap:** BT-bundle remainder (mutex wait duration, file-I/O silent-swallow audit, process exit reasons). BT-3b and BT-7b remain trigger-gated. BT-10b (targeting check) deferred to a later design pass once live `[Entity] event=spawn` frequency gives us signal on how often a targeting edge would actually fire.

### 2026-04-17 — BT-9 World/time event emission to log: three inline `[World]` lines shipped ✅

Shipped `4433b1b` same day on top of BT-11. Before BT-9, a log tailer watching the bot was blind to three categories of ambient world state: weather transitions (existing `bot.on('rain')` handler only wrote to episodic memory), dimension/respawn transitions (existing `bot.on('respawn')` handler only invalidated caches), and time-of-day phase transitions (existing `bot.on('time')` handler only re-emitted synthetic `sunrise`/`noon`/`sunset`/`midnight` events with nothing reading them). The underlying detection was already correct in each case — the only missing piece was `console.log`. BT-9 adds exactly that, inline, with zero new listeners and zero polling.

**Shipped shape — three log-point groups:**

```
[World] event=weather_change state=raining|stopped_raining
[World] event=respawn dim=<overworld|nether|end>
[World] event=time_phase phase=<sunrise|noon|sunset|midnight> tick=<0|6000|12000|18000>
```

**Mount points (where each line lives):**
- `src/agent/event_pipeline.js` `bot.on('rain')` block — `console.log` for `weather_change` placed after the existing `episodic.addEvent` call, reading `bot.isRaining` for the state.
- `src/agent/event_pipeline.js` `bot.on('respawn')` block — `console.log` for `respawn` placed after the existing `deltaState.invalidate()`, reading `bot.game?.dimension` with `'unknown'` fallback for the pre-spawn window.
- `src/agent/agent.js` `startEvents()` `bot.on('time')` block — one `console.log` per branch (sunrise/noon/sunset/midnight), placed after each synthetic `bot.emit(...)`. The four branches got brace-wrapped from one-line `if` form to multi-line so the second statement sits cleanly inside each branch.

**Intentional exclusions (Rule 9 simplicity):**
- **No new `observability/` module.** The gap was literally `console.log` calls alongside already-correct detection. A new module with singleton state, configure hooks, throttled error paths, etc. would have been overbuilt for three one-liner emissions.
- **No polling loop for time transitions.** The whiteboard entry originally said "Time-of-day transitions (dawn/dusk) need a polled check — do it in state ticker (BT-1) or a dedicated sub-module." — but `agent.js` `startEvents()` already had the four synthetic `bot.emit('sunrise'|'noon'|'sunset'|'midnight')` calls wired on `bot.on('time')`. Reusing them was strictly simpler than adding a second detection path, and the event-driven approach avoids the 1 Hz polling cost. Acknowledged trade-off: the existing equality check (`timeOfDay == 0|6000|12000|18000`) only fires if the server's time update lands exactly on those values; it can miss transitions if the tick increment skips the boundary. That fragility pre-dates BT-9 and is not ours to fix in this ship — filing a note under BT-bundle for a later pass if the gap proves noticeable in practice.
- **No `[World]` JSONL sink.** Other observability modules ship a paired `data/*-stream.jsonl` for structured ingestion; BT-9 emits console-only. World events are low-rate (weather changes rarely, respawns rarely, 4 time phases per ~20-minute MC day) and the episodic memory + StateTicker already capture dimension/weather in structured form. A third sink would be redundant. If later needed, it's additive to add.
- **No `entityMoved` / `entitySwingArm` handlers.** Those are BT-10 territory — ship coming next as the paired partner.

**Verification — synthetic-proven, live-deferred to natural trigger (same precedent as BT-6):**
- **Synthetic:** a 16-line Node script mirroring all four time branches + both weather states + dim-present / dim-missing fallback exercised every code path. All 8 emitted the expected `[World] event=<x> ...` format.
- **Live post-restart:** bot relaunched on HEAD `4433b1b` via `start.sh` (the detached-tmux pattern that works). `[StateTicker]` 1 Hz pulses, `[Boot]` line, `[LLM]` lines all still emit unchanged — zero regression on the existing observability stream. Natural `[World]` emissions await the next cross of tick 0/6000/12000/18000 (within ~20 real-time minutes of a MC day cycle), next rain transition, and next bot death/dimension change. BT-6 set the precedent for accepting "proven synthetically, awaiting natural trigger" as shipped verification.

**Rule alignment.**
- Rule 5 — plan presented and approved before any edit (reusable fires, no polling, no new module).
- Rule 7 — grep on `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` against `src/agent/event_pipeline.js` returns zero matches; the three new `console.log` calls add zero bot mutation. `src/agent/agent.js` `startEvents()` adds four `console.log` calls alongside existing `bot.emit` calls — emits are re-emits of the bot's own events, not mutations of game state.
- Rule 9 — the ship is 4 insertions in `event_pipeline.js` (one per handler + 2 comments) and a brace-wrap refactor in `agent.js` `startEvents()` adding 4 `console.log` calls across 4 branches. 21 insertions / 8 deletions total across 2 files. No new module, no new listener, no new polling. Could not be simpler without also being silent.

**Philosophy alignment.** Principle 8 (fail / emit loudly — three previously-invisible transition classes now leave greppable structured lines). Principle 5 (finish the migration — the handlers already existed; BT-9 finishes them by adding the log sink that was missing). Principle 1 (reduce LLM reliance — a human-facing log tailer or session-replay reader can now answer "was it raining?", "did it just turn midnight?", "did it hit the nether?" without loading the JSON stream).

**Downstream unblock.** BT-9 is half of the BT-9+BT-10 logging pair. BT-10 (Entity delta stream) ships next — same session. Together they complete the "ambient awareness" logging tier that sits alongside the existing per-action lifecycle tier (BT-7 skills, Goal, BT-6 paths).

**Files shipped (`4433b1b`, 21 insertions / 8 deletions, 2 files):**
- `src/agent/event_pipeline.js` — 4 insertions (2 comments + `console.log` for weather, `console.log` for respawn).
- `src/agent/agent.js` — 17 insertions / 8 deletions (4 brace-wraps + 4 `console.log` for time_phase + 1 comment). Diff is larger than strictly required for 4 log lines because the original one-line `if` format only permitted one statement per branch; brace-wrapping each branch adds newlines and braces to accommodate the second statement. Rule 10 surgical — each changed line traces directly to adding `time_phase` logging.

**Next in the logging roadmap:** BT-10 Entity delta stream (paired ship, same session). Then BT-bundle remainder (mutex wait duration, file-I/O silent-swallow audit, process exit reasons). BT-3b (19 adapter sweep) and BT-7b (~72 remaining skill wraps) remain trigger-gated.

### 2026-04-17 — BT-11 ContextBuilder truncation decisions: inline drop/truncate log points shipped ✅

Shipped `0791276` same day on top of BT-6. ContextBuilder's existing `[ContextBuilder] 2478/6908 tokens | conv:... mem:... ex:... nb:...` summary line captured final section sizes but not the decisions that produced them. Under budget pressure, a section could be entirely dropped or substantially shrunk with no trace — the "why didn't the bot know about X" question was unanswerable from the log. BT-11 closes that gap with one log line per drop/truncate decision inside the budget-enforcement path.

**Seven log points added** in `src/memory/context_builder.js` (inline `console.log`, no new module):

- **D1** commands dropped — fires when `cmdBudget <= 200` and `params.commandDocs` was provided.
- **T1** commands truncated — fires when `_trimToFit` shrank the input under `cmdBudget`.
- **T2** conversation turn-drops — fires inside `_buildConversation` when the backward walk breaks out on budget; reports the count of older turns that didn't fit.
- **D2** memory dropped — fires when `memBudget <= 100` and episodic or long-term memory was provided.
- **T3** memory truncated — fires when `_trimToFit` shrank the combined episodic+long-term payload.
- **D3** examples dropped — fires when `exBudget <= 200` in the player-conversation path (self-prompt mode skips examples by design, not logged).
- **T4** examples truncated — fires when `_trimToFit` shrank the examples block.

**Log shapes:**

```
[ContextBuilder] dropped=commands (budget=-233)
[ContextBuilder] truncated=commands 2010→1782 chars (budget)
[ContextBuilder] truncated=conversation dropped=6 turns (budget)
[ContextBuilder] dropped=memory (budget=-192)
[ContextBuilder] truncated=memory 2400→1916 chars (budget)
[ContextBuilder] dropped=examples (budget=150)
[ContextBuilder] truncated=examples 4010→2163 chars (budget)
```

All seven share the `[ContextBuilder]` prefix (joining `[StateTicker]`, `[Boot]`, `[LLM]`, `[Damage]`, `[MemoryRecall]`, `[AutoRecovery]`, `[Skill]`, `[Goal]`, `[Path]` in the structured-prefix family) so a tailer can `grep '\[ContextBuilder\] dropped\|\[ContextBuilder\] truncated'` for budget incidents specifically.

**Intentionally excluded from scope (keeps signal-to-noise high):**

- **Mode-based examples skip** during self-prompting (`includeExamples=false` via `!isSP && ...`). This fires every single self-prompt turn — logging it would drown the actual budget incidents we care about.
- **Empty-section skips** for `state`, `action`, and `nearbyBlocks` (empty input, not budget pressure).
- **Reduced-priority inclusions.** The existing summary line already shows final section sizes; adding per-section inclusion logs would spam every prompt assembly. Rule 9 — simplicity first — prefer deferring the signal until we find it missing in practice rather than shipping it speculatively.

**Verification:**

- Synthetic smoke tests exercised 5 of 7 paths (D1 commands-drop, D2 memory-drop, T1 commands-truncate, T2 conversation turn-drop, T4 examples-truncate) — all produced the expected log shape. T3 memory-truncate and D3 examples-drop are structurally identical to their verified siblings in the same code blocks (same `_trimToFit` / same `else`-branch pattern); no divergent logic to test independently.
- Live post-restart (bot `0791276`, 2026-04-17 16:25:05): existing `[ContextBuilder] N/M tokens | conv:... cmd:... mem:... ex:... nb:...` summary line continues to fire on every prompt assembly — no regression. Drop/truncate emissions await natural budget pressure at runtime (usage currently hovers ~2000/6908 tokens with no pressure).

**Rule alignment.** Rule 5 (clean diff — 35 insertions, 1 deletion; existing logic untouched; `_trimToFit` and `_buildConversation` signatures unchanged). Rule 7 (grep on `src/memory/context_builder.js` for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches — no mutation surface added; also confirmed `_trimToFit` has exactly 3 callsites and `_buildConversation` has exactly 1 callsite, all logged). Rule 9 (drops + truncations only — mode-based skips and reduced-priority inclusions explicitly excluded). Principle 8 (fail loudly — structured prefix + actionable `from→to` / `budget=N` fields directly tell an operator what got cut and by how much).

**Downstream unblock.** BT-4 MemoryRecall told us what memory was retrieved for a prompt; BT-11 now tells us what the budget kept vs. cut. Together they close the prompt-construction loop: a log tailer can now answer both "what did memory return?" and "what did the budget drop?" for any given turn.

**Next in the logging roadmap:** BT-9 (World/time events) + BT-10 (Entity delta stream) — ship as a pair per agreed 2026-04-17 ordering. Then BT-bundle remainder (mutex wait, file-I/O silent-swallow audit, process exit reasons). BT-3b (adapter sweep) and BT-7b (remaining ~72 skill wraps) remain trigger-gated.

### 2026-04-17 — BT-6 Pathfinder telemetry: `[Path]` event stream shipped ✅

Shipped `1f4b2f2` same day. Pathfinder was the last silent core subsystem — prior to BT-6, `grep` for pathfinder-related logs returned exactly 3 lines total (all fallback paths in `skills.js`). Normal operation — goal set, route computed, replans, mid-path obstacles, target reached, timeouts, noPath — emitted nothing. BT-6 closes that gap with a per-event structured stream plus a compact running-summary field on every StateTicker pulse.

**Three surfaces, all live on the running bot 2026-04-17:**

- **Per-event `[Path]` line** — one record per pathfinder event. Five events instrumented (verified against `node_modules/mineflayer-pathfinder/index.js`): `goal_updated(goal, dynamic)`, `path_update(results)`, `path_reset(reason)`, `path_stop`, `goal_reached(goal)`. Synthetic end-to-end emission (full lifecycle, all five events):
  ```
  [Path] event=goal_updated target={"x":100,"y":64,"z":200} dynamic=false paths_started=1
  [Path] event=path_update status=success cost=42 time=120 visited_nodes=50 generated_nodes=80 path_len=5
  [Path] event=path_reset reason=stuck
  [Path] event=path_update status=timeout cost=0 time=5000 visited_nodes=200 generated_nodes=500 path_len=0
  [Path] event=path_update status=noPath ...
  [Path] event=goal_reached target={"x":100,"y":64,"z":200} elapsed_ms=2 paths_completed=1
  [Path] event=path_stop elapsed_ms=?
  ```
  Correction to the original proposal in the to-do entry: `mineflayer-pathfinder` does NOT emit `no_path` or `goal_non_reachable` as distinct events — `noPath` is a **status** inside the `path_update` payload, not its own event. The implementation treats `path_update.status` as the primary failure surface and buckets each status into its own counter.

- **JSONL sink** — `data/path-stream.jsonl`, same append-throttled-on-error pattern as every other BT module. One line per event; full structured record (target, cost, time, visited/generated nodes, path_len, elapsed_ms).

- **StateTicker integration** — per-pulse snapshot now carries a compact `path:` field verified live in `data/state-stream.jsonl`:
  ```json
  "path": {
    "started": 0, "completed": 0,
    "no_path": 0, "timeout": 0, "stuck_resets": 0,
    "current": null, "last_status": null
  }
  ```
  A reader scanning any tick can see at a glance whether pathfinding is running, whether it recently failed to find a path, and whether the bot is currently stuck-resetting.

**Live `[Path]` emission from the bot itself** is pending — gemma-4-e4b has been choosing `!digDown` in a tight loop and hasn't issued a pathfinding skill yet. The emission path is proven synthetically; it will light up the first time the LLM picks `collectBlock`/`goToNearestBlock`/`goToPosition`/etc.

**Files shipped (`1f4b2f2`, 447 insertions, 3 files):**
- `src/observability/path_telemetry.js` (new, ~400 lines) — module-level singleton (same shape as `recall_log.js` / `skill_lifecycle.js`), `hookPathTelemetry(agent)` installs listeners idempotently, `getPathStats()` exposes a shallow-clone snapshot, `configurePathTelemetry()` for settings. Hook gate: `_hookedPathfinder` reference identity prevents re-install on soft reconnect. Every handler body is try/catch-wrapped; failures route to a 10 s throttled `_throttleWarn`.
- `src/agent/agent.js` — `configurePathTelemetry(settings.path_telemetry)` + `hookPathTelemetry(this)` wired in right after the BT-1 StateTicker start block. Same post-spawn mount point, same error-isolation pattern.
- `src/observability/state_ticker.js` — import `getPathStats`; attach the compact `path:` field in `_snapshot()` alongside the existing `auto_recovery` block. Read-only, Rule-7 safe.

**Philosophy alignment.** Principle 5 (finish the migration — pathfinder was the last silent subsystem; every core component now has a structured stream). Principle 8 (fail loudly, informatively — `noPath` and `timeout` now leave timestamped greppable records; `stuck` resets surface the failure mode the bot hits most often). Principle 1 (reduce LLM reliance — closes the diagnosis loop; the LLM no longer needs to re-reason "why couldn't I reach that tree?" from a bare failed-skill record).

**Rule alignment.** Rule 5 (additive only — pure event listeners, no `pathfinder.goto`, no `bot.setControlState`). Rule 7 (grep on `path_telemetry.js` for the mutation perimeter returns zero matches; the Rule 7 audit line above now names the file explicitly). Rule 9 (simplicity — stateless emitter, no injection).

**Verification.** Synthetic end-to-end test mocked a pathfinder via `EventEmitter`, fired the full lifecycle (all five events), confirmed every counter incremented correctly, every `[Path]` console line rendered with the documented format, every event wrote to the JSONL sink, and `getPathStats()` returned the expected shape. Live StateTicker confirmed the `path:` field is present and populated on every pulse.

**Next in the logging roadmap:** BT-11 (ContextBuilder truncation), BT-9 (World/time events) + BT-10 (Entity delta stream), BT-bundle remainder, BT-3b (adapter sweep), BT-7b (remaining ~72 skill wraps).

### 2026-04-17 — BT-7 Skill lifecycle + Goal lifecycle: uniform `[Skill]` and `[Goal]` lines shipped + live-verified ✅

Shipped `40c04f3` and live-verified same day. The lifecycle layer underneath BT-5's measurement layer is now in place: every wrapped skill invocation produces one `[Skill]` line carrying name/args/ms/outcome, and every goal transition (start / queue_add / advance / end / pause) produces one uniformly-prefixed `[Goal]` line. Previously: skill behavior was 19 ad-hoc logs + silence for the other 63; goal state was `[GoalQueue]` with no duration tracking.

**Two surfaces, both verified live 2026-04-17:**

- **`[Skill]` lifecycle line** — first live emission captured at 2026-04-17T19:37:24Z:
  ```
  [Skill] name=digDown args=[10] ms=2516 outcome=abort
  ```
  And its JSONL companion in `data/skill-stream.jsonl`:
  ```json
  {"t":"2026-04-17T19:37:24.016Z","name":"digDown","args_str":"[10]",
   "ms":2516,"outcome":"abort","err_class":null,"notes":null}
  ```
  Outcome taxonomy: `success` (truthy/undefined return), `error` (throws — `err_class` captures constructor name), `abort` (literal `false` return — the mineflayer "couldn't do it" convention). The first live invocation exercised the `abort` path cleanly — the digDown impl returned false because the bot's feet were already in stone, and the wrapper classified it correctly.

- **`[Goal]` lifecycle line** — first live emission captured on bot boot:
  ```
  [Goal] event=start prompt="mine 64 ancient debris" queue_depth=0
  ```
  Events now emitted: `event=start` (on `start(prompt)`), `event=queue_add` (on `addGoal`), `event=advance` (on `advanceGoal` — with `from=` / `to=` / `ms=` / `queue_depth=`), `event=end reason=<complete|stop> ms=<elapsed>` (on `!endGoal` or `stop()`), `event=pause` (on `setPromptPaused` or `pause()`). `grep '[GoalQueue]' src/` returns zero matches — the ad-hoc prefix is retired cleanly.

**Files shipped (`40c04f3`, 292 insertions / 15 deletions, 4 files):**
- `src/observability/skill_lifecycle.js` (new, ~210 lines) — `wrapSkill(name, fn, options)` factory with module-level singleton sink state, `configureSkillLifecycle()` test hook, 80-char args cap, non-throwing emit with 10 s throttled error log (same pattern as BT-2 DamageStream).
- `src/agent/library/skills.js` — import `wrapSkill`; rename-impl pattern applied to 11 hottest exports (`collectBlock`, `craftRecipe`, `smeltItem`, `pickupNearbyItems`, `placeBlock`, `equip`, `safeToss`, `safeTossBatch`, `goToNearestBlock`, `digDown`, `digUp`). Each becomes: `async function _impl_X(...)` + `export const X = wrapSkill('X', _impl_X);`.
- `src/agent/self_prompter.js` — `_goalStartTime` / `_goalPrompt` tracker added to constructor; emits on `start` / `setPromptPaused` / `addGoal` / `advanceGoal` / `stop` / `pause`; old `[GoalQueue]` prefix replaced.
- `src/agent/commands/actions.js` — `!endGoal` emits `event=end reason=complete` when the queue drains, and pre-clears the tracker state before calling `stop()` so the downstream `reason=stop` line does not double-emit for the same goal.

**Rename-impl rationale.** ES modules disallow redefining `export async function X`. The pattern `async function _impl_X(...)` + `export const X = wrapSkill('X', _impl_X)` is the minimum-surface way to wrap without breaking call-site semantics. Internal callers within `skills.js` resolve to the wrapped export (adds one `[Skill]` line per internal call — acceptable; internal recursion is rare among the wrapped 11).

**Scope deferral.** Remaining ~71 exports in `skills.js` stay unwrapped until BT-7b — one session of live-run data on the 11 hottest should validate the taxonomy and args cap before locking them into 70+ more wraps (Rule 9 — don't wrap what we can't live-verify in one ship cycle).

**Root-cause statement (why this needed to exist).** Pre-BT-7, reading the tmux buffer could not answer: "did that skill complete or hang?" "how long did it take?" "why did it return false — I/O problem or logic no-go?" "what were the args?" For goals: no duration, no reason-for-end, inconsistent prefix between `[GoalQueue]` (queue ops) and silent prompts (start/stop). BT-7 + Goal lifecycle close both gaps at the top of the call graph.

**Philosophy alignment.** Principle 1 (mechanical wrapper, zero LLM in the loop). Principle 5 (rename-impl is the single end-state per wrapped skill; no dual codepath). Principle 8 (abort is first-class; err_class is named).

**Rule alignment.** Rule 5 (impl awaited and returned unchanged; exceptions re-throw in original order; emit path try/catch-wrapped). Rule 7 (`grep` on `skill_lifecycle.js` for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches).

**Next in the logging roadmap:** BT-11 (ContextBuilder truncation), BT-9 (World/time events) + BT-10 (Entity delta stream), BT-bundle remainder, BT-3b (adapter sweep), BT-7b (remaining ~72 skill wraps).

### 2026-04-17 — BT-5 AutoRecovery match/miss rate: three surfaces shipped + live-verified ✅

Shipped `baab2bd` (code) and live-verified same day. AutoRecovery dispatcher is now fully observable: every `checkAndRecover` call produces exactly one summary log line regardless of match, StateTicker exposes running stats, and `!recovery-stats` dumps the per-pattern table on demand. Principle 1 (the fraction of failures scaffolding caught) now has hard numbers.

**Three surfaces, all verified live 2026-04-17:**

- **Per-invocation summary line** — example captured from live session:
  ```
  [AutoRecovery] input="\nINVENTORY\n- oak_log: 120\n- diamond: 64..." tried=9 matched=none outcome=passthrough
  ```
  Outcomes: `recovered | unresolved | gave_up | error | passthrough`. Input truncated to 80 chars. Confirms the previously-invisible passthrough case is now surfaced — turned up a mystery invocation where something routed a raw inventory dump into the dispatcher (filed for a future look).

- **StateTicker integration** — per-tick snapshot includes:
  ```json
  "auto_recovery": {"invocations": 1, "matched": 0, "match_rate": 0, "recovered": 0,
                    "last": {"pattern": null, "outcome": "passthrough", "t": "2026-04-17T18:52:27.966Z"}}
  ```
  Verified on live `data/state-stream.jsonl` tick at 19:00:22Z. Field is `null` when stats are unavailable (graceful), otherwise populated every 1 Hz.

- **`!recovery-stats` debug command** — registered (`CommandDocs` count went from 62 → 63 on startup), added to the unblockable list alongside `!stop/!stats/!inventory/!goal`. Not in `ALWAYS_INCLUDE` for prompt docs — it's human-facing, and keeping it out of every LLM prompt saves tokens.

**Files shipped (`baab2bd`, 199 insertions / 2 deletions):**
- `src/agent/auto_recovery.js` — instance stats (`invocations`, `matched`, `recovered`, `unresolved`, `gaveUp`, `error`, `passthrough`, per-pattern Map, `last`), `_logInvocation()` emits the summary line, `getStats()` returns a read-only snapshot.
- `src/observability/state_ticker.js` — one new field in `_snapshot()`, try/catch around the getter so StateTicker never breaks if the agent wiring isn't there yet.
- `src/agent/commands/queries.js` — `!recovery-stats` entry with totals, match rate, per-pattern breakdown, last-invocation block.
- `src/agent/commands/index.js` — `!recovery-stats` added only to unblockable list (Rule 10 — surgical).

**Root-cause statement (why this needed to exist).** Instrumentation was written from the pattern-author's perspective (each pattern logs its own hit), not the dispatcher's. When no pattern matched, the loop just fell through silently. BT-5 flips the perspective — one line per invocation, always.

**Philosophy alignment.** Principle 1 (the scaffolding-leverage measurement). Principle 8 (observability drives decisions, not vibes).

### 2026-04-17 — BT-4 MemoryRecall: [MemoryRecall] log line per memory retrieval ✅

Shipped `src/observability/recall_log.js` (≈220 lines, module-level stateless logger
matching the `captureBootSnapshot` shape) and instrumented all three memory
subsystems. Every retrieval now emits exactly one `[MemoryRecall]` structured log
line + one JSONL record to `data/recall-stream.jsonl`. Principle 2 ("memory is
cognition") is finally observable.

**Module shape.** Module-level `logRecall({subsystem, query, k, returned, backend,
top_score, top_text, ...extras})` — no class, no per-agent state, no DI. Matches
`captureBootSnapshot`. `configureRecallLog({enabled, log_to_console, log_to_file,
file_path})` is the settings hook. `logRecall` is non-throwing (internal try/catch
with 10 s error throttling on both console and file sinks). `query` and `top_text`
truncated to 80 chars each; multi-line queries collapsed to single-line.

**Three instrumentation sites (procedural collapsed into confidence per Principle 5
+ Rule 9):**

- `src/memory/episodic_memory.js retrieve()` — 3 exits logged: empty-cache
  (`backend=none`, `returned=0`), Vectra success (`backend=vectra`, `top_score`,
  `top_text`), word-overlap fallback (`backend=word-overlap`). Vectra result hoisted
  OUT of the try/catch so the log call fires outside any path that might be
  misclassified as "Vectra query failed."
- `src/memory/long_term_memory.js recall()` — symmetric 3 exits with
  `category` / `category_top` extras so category filtering is visible.
- `src/memory/confidence_engine.js evaluate()` — **option A single-exit restructure**
  (4 returns → 1). Each of the four branches ((!entry), HIGH bypass, MEDIUM suggest,
  LOW fallthrough-with-entry) still bumps exactly one stats counter and assigns
  `{level, action, confidence, contextHash}`. One log call fires after the branch
  block, inside a try/catch defense-in-depth wrapper. Extras: `tier, threshold_high,
  threshold_med, context_hash (12-char prefix), record_count, trigger`. Procedural
  `ProceduralMemory.lookup()` has exactly one caller (confidence_engine.js:68), so
  instrumenting `evaluate()` captures 100 % of procedural reads with richer context
  — a separate procedural log line would duplicate per LLM turn.

**Record shape:**
```
[MemoryRecall] subsystem=episodic    query="mine 64 ancient debris ..." k=3 returned=3 backend=vectra top_score=0.715 top_text="System: Recent behaviors log: Fighting creeper! ..."
[MemoryRecall] subsystem=long_term   query="mine 64 ancient debris ..." k=5 returned=5 backend=vectra top_score=0.640 top_text="Never dig straight down — you can fall into lava ..." category_top="strategy"
[MemoryRecall] subsystem=confidence  query="mine 64 ancient debris" k=1 returned=1 backend=map top_score=0.722 top_text="!digDown(3)" trigger="You are self-prompting with the goal ..." tier="MEDIUM" threshold_high=0.98 threshold_med=0.5 context_hash="cfa049aac5ad" record_count=294
```

**Option A verification (post-deploy):**
1. ✅ Stats-equality invariant preserved by construction: every branch in the
   restructured `evaluate()` increments exactly one of `{bypassed, suggested,
   fullReasoning}` and every entry increments `totalDecisions` once. Branch-order
   diff hygiene preserved; node --check clean.
2. ✅ Result shape preserved: all four branches set `{level, action, confidence,
   contextHash}`. Consumer at `agent.js:856` and `buildSuggestionFromResult()`
   unaffected (grep-verified for `.level, .confidence, .action, .contextHash`).
3. ✅ Throw-safety: `logRecall` wrapped in try/catch — even if the logger throws,
   the agent's per-turn hot path continues uninterrupted.
4. ✅ Rule 7 perimeter clean: `grep -E 'bot\.(dig|placeBlock|chat|toss|setControlState|
   attack|equip|unequip|activateItem)|pathfinder\.goto'` across the new `recall_log.js`
   and the edits in `episodic_memory.js`, `long_term_memory.js`, and
   `confidence_engine.js` returns zero matches. The logger is pure log + `fs.appendFile`.
5. ✅ Procedural collapse documented in both commit body and `recall_log.js` header —
   future audits won't mistake it for a skipped instrumentation site.

**Verified live 2026-04-17.** Bot restarted via `tmux kill-session -t mindcraft-mcgavin
&& ./start.sh`; `[MemoryRecall]` lines surfaced from all three subsystems within the
first turn:
- 5 × `subsystem=confidence` (tier=LOW and tier=MEDIUM both observed; context_hash
  stable across repeated goal decisions; top_score in the 0.65–0.74 range — right on
  top of G's 0.95 threshold-drop target for HIGH bypasses)
- 5 × `subsystem=episodic` (all `backend=vectra`, top_score 0.71–0.72)
- 5 × `subsystem=long_term` (all `backend=vectra`, top_score 0.62–0.64,
  `category_top="strategy"` on one, `"fact"` on another)

`data/recall-stream.jsonl` populating correctly with valid JSONL (15 records /
5 each subsystem). 5:5:5 symmetry confirms episodic + LTM fire together once per
prompt assembly while confidence fires once per LLM turn, matching the architectural
prediction.

**Unblocks G's threshold-tuning work** — the `record_count=294` and the
0.65–0.74 top_score distribution now visible in JSONL means JP has real data to
evaluate whether dropping `highThreshold` from 0.98 → 0.95 would unlock HIGH-tier
bypasses without false positives.

**Blast radius.** Additive read-side instrumentation + one confined control-flow
restructure in `evaluate()`. Zero behavior change in any of the three subsystems.

Commits `d335327` (whiteboard pickup) + `1bcbbb6` (ship — 4 files, +362/-43).

### 2026-04-17 — BT-12 observability wiring before spawn-escape await ✅

Moved `this.startEvents()` and the `StateTicker.start()` block in the spawn handler
to BEFORE `await skills.escapeProtectedZone(this.bot)`. Surgical ordering fix —
~20 lines relocated in `src/agent/agent.js`, zero net additions.

**Problem.** Pre-BT-12 ordering placed both observability-wiring steps AFTER the
spawn-escape `await`. On in-zone spawn, that `await` blocks for ~45-60s of
`-X hop N` pathing. During that window DamageStream did not exist yet, `[Damage]`
lines never fired, the death handler's LTM source-write had nothing to read, and
`[StateTicker]` pulses did not begin. The entire zone-escape window — frequently
the only interesting thing happening immediately post-spawn — was dark to the
observability layer.

**Root cause.** Original ordering grouped all post-spawn setup together.
`startEvents()` just attaches `bot.on('health'|'error'|'end'|'death'|'kicked'|
'messagestr'|'time')` listeners to `this.bot` (which has existed since login)
and constructs DamageStream; `StateTicker.start()` reads `bot.entity.*` getters
guarded by a NaN/ChunkWait held-state fallback. Neither depends on escape
having completed. The grouping was convenience, not correctness.

**Fix.** Move `startEvents()` + the StateTicker start block BEFORE the escape
`await`. Leave `_setupEventHandlers(save_data, init_message)` AFTER escape —
that wires chat/whisper handling and kicks the init message; gating
player-interaction processing until post-escape is desirable.

**Blast radius.** Single file, 24 insertions / 11 deletions (mostly comment
reshuffling to explain the new order). `startEvents()` is idempotent across
reconnects (new bot = old listeners die). DamageStream and StateTicker
create-once guards (`if (!this.damage_stream)`, `if (!this.state_ticker)`) +
idempotent `start()` already handle re-calls correctly.

**Rule 7.** No new code; just reordering. The observability modules already
passed Rule 7 in their own commits.

**Verified live** 2026-04-17. After restart:
- Line 168 of the bot log: `ThatCoolGuyDude spawned.`
- Line 172: `[StateTicker] started: interval=1000ms console=true file=data/state-stream.jsonl`
- 4 lines between — StateTicker begins immediately after the initial post-spawn
  setup and before the escape `await`, exactly as designed.
- 37 `[StateTicker]` pulses captured in the first ~20s post-spawn. No regressions
  to StateTicker, BootSnapshot, LLM telemetry, or DamageStream.
- No `[Damage]` lines in this run (bot either spawned outside the zone or
  completed escape without hits); the dark-window gap is closed either way.

Commit `3292de3`.

### 2026-04-17 — BT-2 DamageStream: per-hit damage telemetry + inferred source ✅

Shipped `src/observability/damage_stream.js` (≈240 lines) and wired it into the existing
`bot.on('health')` and death (`messagestr` translate=`death.*`) handlers in `agent.js`.
Emits one `[Damage]` log line + one JSONL record per health-decrease event. Non-lethal
damage is no longer silent.

**Record shape:**
```
{"t":"...","amount":3.0,"health_before":14,"health_after":11,"source":"zombie",
 "source_category":"entity","pos":{"x":..,"y":..,"z":..},"dimension":"overworld",
 "food":17,"lethal":false}
```

**Source inference (priority order, Rule 1 data-driven):**
1. Nearest hostile mob within 4 blocks → `source=<mob_name>`, category=`entity`.
2. Contact-damage block at feet or head (lava, fire, cactus, magma_block,
   sweet_berry_bush, soul_fire, campfire, powder_snow, wither_rose) →
   `source=<block_name>`, category=`environment`.
3. Oxygen level < 18 → `source=drowning`, category=`environment`.
4. Strong recent downward velocity (< -0.5) → `source=fall`, category=`fall`.
5. Otherwise → `source=unknown`, category=`unknown`.

**Death hand-off.** `DamageStream.getLastDamage()` returns the most recent damage record.
The existing death handler now calls it and writes a `Died from <source> (<category>)
at x,y,z in <dimension>` entry into long-term memory via `long_term_memory.store(...,
'death', {source, source_category, coords, dimension})`. Next-session bot starts
knowing what killed it, not just where — advances Principle 4 (preserve work across
sessions) and directly reduces LLM re-derivation on respawn.

**Blast radius.** Additive only. The existing `bot.on('health')` handler still updates
`lastDamageTime` / `lastDamageTaken`; BT-2 adds one line inside the same if-decrease
branch. The death handler's LTM write is wrapped in try/catch so an LTM failure
cannot regress the pre-existing `last_death_position` bookkeeping.

**Rule 7 audit.** Invariant: DamageStream must not mutate bot state.
`grep -E "bot\.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder\.goto" src/observability/damage_stream.js`
returns zero matches. The module reads `bot.entity`, `bot.entities`, `bot.blockAt`,
`bot.oxygenLevel`, `bot.food`, `bot.game.dimension` — all getters.

**Verified live** 2026-04-17:
- Startup completed cleanly with DamageStream constructed in `startEvents()`.
- StateTicker + BootSnapshot + LLM telemetry all still firing — no regressions.
- `[Damage]` log is intentionally empty so far: the bot has spawned, escaped the zone,
  and is now pursuing `mine 64 ancient debris` without taking hits. First actual damage
  event will be the first live verification of the classifier.
- **Bonus live BT-3 proof captured in the same restart window** — chat-completion
  lines finally surfaced: `[LLM] label=LMStudio model=gemma-4-e4b elapsed_ms=19963
  prompt_tok=3009 completion_tok=61 total_tok=3070 tok_per_s=3.06 retries=0 finish=stop
  status=ok` and a second at 42.9s with 390 completion tokens (9.09 tok/s).

**Observation (not a BT-2 issue, flag for later):** `startEvents()` — including
DamageStream construction and the StateTicker start — runs AFTER
`await skills.escapeProtectedZone(...)` inside the spawn handler. If the bot spawns
inside the 250-block zone, observability does not begin emitting until escape
completes (~45-60s). Not a regression; pre-existing flow quirk worth revisiting in a
future hardening pass if startup-window visibility becomes important.

Commit `5818986`.

### 2026-04-17 — BT-3 LLM call telemetry: one [LLM] log line per LM Studio request ✅

Shipped `withLLMMetrics({label, model, extractUsage?, retryOptions?}, fn)` in `src/utils/retry.js`.
Wraps the existing `withRetry` and emits exactly one `[LLM]` structured log line per call —
success OR terminal failure after retries. Default usage extractor reads OpenAI-compatible
`response.usage.{prompt_tokens, completion_tokens, total_tokens}`, `prompt_tokens_details.cached_tokens`
(LM Studio cache-hit signal), and `response.choices[0].finish_reason`. Telemetry emission is
itself try/caught — a malformed response cannot crash the caller.

**Migration:** `src/models/lmstudio.js` now routes both call sites (`sendRequest` + `embed`) through
`withLLMMetrics` instead of `withLLMRetry`. Retry semantics are identical; the only user-visible
change is one extra `[LLM]` log line per call.

**Log line shape (success):**
```
[LLM] label=LMStudio model=gemma-4-e4b elapsed_ms=8420 prompt_tok=3435 completion_tok=14
      total_tok=3449 tok_per_s=1.66 retries=0 finish=stop cache_hit=true status=ok
```
**Terminal failure:**
```
[LLM] label=LMStudio model=gemma-4-e4b elapsed_ms=250 retries=3 status=error err_class=FetchError
```

**Principle 5 honesty.** Only `lmstudio.js` migrates in this ship. The other 19 adapters (`gpt, claude,
ollama, gemini, ...`) retain their original per-adapter error handling and do NOT emit `[LLM]`
lines. This deferral is explicit and tracked as **BT-3b** — it is NOT a partial migration being
silently left unfinished.

**Absorbs** #18 (model-provider server-side logging sweep — the per-adapter catch-block logging
concern) for the active provider. BT-3b picks up #18's residual scope for dormant adapters.

**Rule 7 audit.** Invariant: LLM telemetry must not mutate bot state.
`grep -E "bot\.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder\.goto" src/utils/retry.js`
returns zero matches. The module has zero bot references at all.

**Verified live** 2026-04-17. Eight `[LLM] label=LMStudio-Embed ...` lines fired during
`seedMemory` / `initExamples` at startup — e.g.
`elapsed_ms=244 prompt_tok=0 completion_tok=? total_tok=0 tok_per_s=? retries=0 finish=? cache_hit=? status=ok`.
(LM Studio reports `prompt_tokens:0` for embeddings — an LM Studio quirk, not a bug in the wrapper.
`tok_per_s=?` correctly reflects no rate signal.) Chat-completion lines will surface
`prompt_tok`, `completion_tok`, `tok_per_s` once JP kicks a goal.

Commits `2fd2030` (ship) + `1089363` (fix: `tok_per_s=?` instead of `0` when tokForRate is 0 — honest "no signal" mark).

### 2026-04-17 — BT-8 BootSnapshot: structured boot log line + data/boot-snapshot.json ✅

Shipped `src/observability/boot_snapshot.js` and wired `captureBootSnapshot(agent, settings)`
at the top of `Agent.start()`, right after prompter init and before name validation —
so the snapshot lands even if validation or connect fails (bug-report reproducibility).

**Emissions per boot:**
- One `[Boot] profile=... chat=... fast=... embed=... node=... mineflayer=...
  mc_version=... host=... port=... settings_hash=... features={...}` log line.
- `data/boot-snapshot.json` — full resolved settings + all structured fields.
  Overwritten per boot (current-config, not a timeline).

Feature flag table is data-driven (Rule 1): 11 flags shipping in v1
(`state_ticker, context_builder, delta_state, filtered_commands, fast_model,
adaptive_polling, load_memory, speak, chat_ingame, allow_vision,
allow_insecure_coding`). Adding one is one entry, no code branch.

**Model-ref rendering.** Profiles store chat as a string but embedding as
`{api, model, url}`; the initial log line printed the object as
`[object Object]`. Fixed in a follow-up commit with `_modelLabel()` —
collapses both shapes to `api/model` in the log, keeps the raw object
in the JSON dump.

**Rule 7 audit.** Invariant: BootSnapshot must not mutate bot state.
The function runs before `bot` exists, and `grep -E "bot\.(dig|placeBlock|
chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder\.goto"`
on the module returns zero matches.

**Verified live** 2026-04-17 14:59 UTC — full boot line renders
correctly (settings_hash `1e23d319`, node `v22.22.2`, mineflayer `4.37.0`,
mc `1.21.4`); JSON file present with full settings dump; StateTicker
still firing; no new errors. Commits `894ac44` (ship) + `26103b0` (fix).

### 2026-04-17 — BT-1 StateTicker: 1Hz structured pulse stream for observability ✅

Shipped `src/observability/state_ticker.js` and wired it from
`Agent.bot.once('spawn', ...)`. Emits one structured JSON record per
second to two sinks: `[StateTicker] {...}` console log line, and
append-only `data/state-stream.jsonl`. Record fields: `pos, vel, health,
food, dimension, goal, goal_queue, pathfinder {active, target}, mutex
{holder, queue}, inventory {count, top:3}, nearby_entities (top 3 by
dist), nearby_threats`. `last_command` and `context_tokens` surface as
`null` in v1 — BT-7 and BT-3 will wire them respectively.

**Safety.** NaN-position / ChunkWait-held windows emit a minimal
`{t, held:true, reason}` record instead of throwing. Tick-body errors
throttled at 1/10s and never propagate. File-write errors likewise.
Rule 7 invariant ("StateTicker must never mutate bot state") audited
by grep — zero mutating calls in the module.

**Verified live** 2026-04-17 14:52 UTC. `ThatCoolGuyDude` spawned at
(-301, 62, -38), ticker logging at 1Hz, `data/state-stream.jsonl`
growing with valid JSONL, no new errors or regressions in the tmux
buffer. Commit `167e495`.

Establishes the `src/observability/` module layout and the
`data/*-stream.jsonl` output convention that BT-2..BT-11 + BT-bundle
inherit.

### 2026-04-16 — createMovements factory: zone-aware pathfinder movements ✅

Commit `f2f53aa`. Pathfinder was the last unguarded path that could modify blocks inside protected zones. New `createMovements(bot)` factory replaces all 17 raw `new pf.Movements(bot)` callsites; disables `canDig` + clears `scaffoldingBlocks` when inside a zone. Closes the Rule 7 perimeter for protected zones across direct dig/place, pathfinder navigation, escape recovery, and startup.

### 2026-04-16 — safeTossBatch: single dump run for all junk items ✅

Commit `9300490`. `autoDiscard`/`autoDiscardAllJunk` were calling `safeToss` per item — N items meant N tunnels through terrain. New `safeTossBatch(bot, items)` digs one tunnel, one hole, drops all items, walks back. `safeToss` retained for single-item `!discard`.

### 2026-04-16 — autoBreakStuckPlant: movement-blocking allowlist for protected zones ✅

Commit `37b6d4c`. New `MOVEMENT_BLOCKING_PLANTS` allowlist limits protected-zone breaks to blocks that actually impede movement (`sweet_berry_bush`, `vine`, `sugar_cane`, `big_dripleaf`, mangrove_roots variants, all leaves). Passable grass/flowers/ferns left untouched. 23/23 logic tests passed.

### 2026-04-16 — Zone-aware escape logic for all protected zones ✅

Commit `1bbc0ab` + agent.js. `escapeProtectedZone` replaces `escapeSpawnZone` as primary escape — phase 1 delegates to spawn-zone logic, phase 2 walks away from village/structure zone centers via directional hops. AutoRecovery pattern renamed `ESCAPE_PROTECTED_ZONE` with `skipRetryLimit: true`. Live-verified phase 1; phase 2 awaiting natural trigger.

### 2026-04-16 — #22 ChunkWait: hold state during chunk-load / NaN-position windows ✅

Five-commit sequence (`d19476e` → `e5cf5ba` → `a5158ac` → `7f6741a` → `4107d70`) + `69306b2` viewDistance companion. Addresses stuck-loop where bot burned ~300 LLM calls over an hour cycling `!digDown`/`!goToSurface`/`!searchForBlock` against NaN `bot.entity.position`. Also closes #16.1 (guard returns recorded as ProceduralMemory successes). New `src/agent/chunk_wait.js` watchdog (500 ms tick, 180 s escalation cap, reconnect, runaway `process.exit(1)`); `handleMessage` ingress gate prevents LLM calls + `recordOutcome` writes while held; `viewDistance: 'normal'` added to mineflayer `createBot` options. Live-verified within 10 seconds of restart: ENTER/EXIT pair fired with zero LLM traffic during the 1.5s hold.

### 2026-04-15 — Mechanical audit bundle: #13, #14, #15, #16.1, #19, #20 ✅

Six-commit sweep from `/mindcraft-audit` intake: #15 `af2cec3` (9 `full_state.js` silent catches → `[FullState] ...` logs), #19 `6c613ec` (`connection_handler.js` wildcard catches → `[ServerProxy]`/`[ParseKickReason]` logs), #14 `eb73110` (5 `readFileSync` sites wrapped with graceful fallbacks), #13 `605e485` (`digUp` ProtectedZone guard + full Rule 7 `bot.placeBlock`/`bot.dig` audit in commit message), #16.1 `a2a05d5` (`digDown`/`digUp` NaN-position guards), #20 `fb35d52` (one `[ProceduralMemory] Recorded outcome ...` log line per action, unblocks #G threshold tuning).

### 2026-04-15 — Safe Movements Stage 1: stop collectBlock from digging straight shafts ✅

Commit `e59a307`. `mineflayer-collectblock` plugin created its own raw `pf.Movements(bot)`; pathfinder chose straight-down shafts as shortest path. New `installSafePathfinderDefaults(bot)` mutates `bot.collectBlock.movements` in place at startup (`maxDropDown=3`, `digCost=10`, `canSwim=true`, terrain-safe). Full Rule 7 audit deferred to #12.

### 2026-04-15 — #7 post-hoc fix: plug collectBlock ProtectedZone leak ✅

Commit `cde1329`. `collectBlock` called `bot.dig`/`bot.collectBlock.collect` directly — neither went through `breakBlockAt`, so `_isInAnyProtectedZone` was never consulted. Fix: filter candidates by zone check post-`getNearestBlocksWhere`, bumped candidate count 1 → 8. Wording tuned to match AutoRecovery regex so bot auto-escapes. Motivated Rule 7 "Complete the perimeter".

### 2026-04-15 — #7 ProtectedZone completion + village auto-detection ✅

Commits `5fbfc83` + `a73e53b` + `10d45d1`. Unified `{name, type, x, z, radius, yMin?, yMax?}` shape across three zone sources: spawn (existing, Y-agnostic), manual via `player_structures.json`, auto-detected villages (3 signals: ≥3 villagers clustered, ≥3 profession workstations clustered, any bell within 128 blocks). Periodic 30s re-scan with 50-block dedup. 51-test harness passed. Post-deploy: `village_106_83 via bell; Y[45..95]` detected within 5s of spawn.

### 2026-04-15 — #11 TIERED_ITEMS: best-tier tool/armor classification ✅

Commit `8657d9b`. New 5-step priority chain in `snapshotInventory`: **SINGLETON_KEEPS → BED_GROUP → STACK_CAPS → TIERED_ITEMS → getItemValue**. 9 roles (pickaxe/axe/shovel/hoe/sword + 4 armor slots) × 6 tiers each; only best-owned tier per role is protected, lower tiers drain as junk. 24 tiered entries removed from KEEP_ALWAYS. 29-test harness passed including core-safety best-tier-never-junk check. Caveats documented: durability + enchantments ignored.

### 2026-04-15 — `self_preservation` mutex-wait Known Issue audited and closed ✅

Code audit + log review found the Known Issues entry stale: drowning uses synchronous `setControlState` (no mutex); sand/gravel/lava/fire/low-health-flee go through `execute()` with `interrupts: ['all']` (mutex-bypass). Inner skills invoked by self_preservation don't acquire the mutex. Zero deaths attributable to mutex-delayed self_preservation across ~168 history files. Removed from Known Issues as obsolete.

### 2026-04-15 — AutoRecovery `Cannot smelt <target>` handler ✅

Commits `efec3e4` + `79d02e6`. New `cannot_smelt` FAILURE_PATTERN + `CORRECT_SMELT_TARGET` action. `ORE_SMELT_LOOKUP` classifies 19 ores into Group A (drops final item directly, tell LLM), Group B (drops raw_Y, auto-correct to `!smelt("raw_Y")`), Group C (ancient_debris, upstream heuristic gap). `FURNACE_FUELS` + `SMELT_FINAL_PRODUCTS` sets give category-specific error messages. Aligns with #9 — converts recurring LLM production-chain confusion into deterministic code responses.

### 2026-04-15 — D1 Legacy `history.memory` deprecation ✅

Commit `7ee597e`. Finished migration `018e222` started: `promptMemSaving()` wrapped in `use_context_builder` guard (skips the LLM call when CB is on); `$MEMORY` removed from coding template. Post-deploy: zero "Memory truncated" log lines; memory still injected via ContextBuilder episodic+long-term paths (`mem:1832` tokens allocated). Queued followups F + G.

### 2026-04-15 — Inventory management overhaul ✅

Four commits (`21976f3`, `50bf280`, `f141be8`, `8f722ce`). `autoDiscardAllJunk` replaces "free 5 slots" with drain-all-junk in one pass + 60s cooldown. `snapshotInventory` priority chain: SINGLETON_KEEPS → BED_GROUP → STACK_CAPS → `getItemValue` (TIERED_ITEMS added later). KEEP_ALWAYS additions: `ancient_debris`, all 17 `shulker_box` variants. Removed: `lava_bucket`, `chest` (moved to tier-1 junk). Wood-type coverage generalized via `ALL_PLANKS`/`ALL_LOGS`/`ALL_SAPLINGS` across all 10 MC 1.21 variants.

### 2026-04-15 — #4 Wrong tool for the block ✅

Commit `1c5b741`. New `_equipBestToolFor(bot, block)` using `bot.pathfinder.bestHarvestTool`. Wired into all 7 `bot.dig` callsites. Bonus: `equipHighestAttack` sort comparator was returning boolean — proper descending sort now. Verified: bot collected 2 iron_ore (impossible bare-handed).

### 2026-04-15 — #10 Bot survival hardening (Layer 1) ✅

Commit `4def1fa`. `pf.Movements.maxDropDown` set to 3 (vanilla no-damage limit) on both goToGoal movement paths. `bot.autoEat.options.startAt` bumped 14 → 19 (continuous health regen). Post-deploy: 1-hop spawn escape, 0 fall deaths.

### 2026-04-15 — Bugs A/B/C ✅

Three same-day fixes:
- **Bug A** `ec75860` — `PLANT_LIKE_PATTERN` was matching `grass_block` via bare "grass" token. Tightened regex to `(^|_)grass$`, added `SOLID_GROUND_BLOCKS` hard-exclusion list.
- **Bug B** `a4981b0` + `ad3874d` + `4def1fa` — "mysterious teleport-back" was death+respawn from fall damage; resolved by escape rewrite + survival hardening.
- **Bug C** `ec75860` — per-bot in-memory blacklist (`Map<xyz, expiry>`) prevents repeat `autoBreakStuckPlant` failures on same block for 30 s.

### 2026-04-15 — Spawn-zone escape rewrite (#0 Bug B fix) ✅

Commit `ad3874d` + followup `4201bae`. Replaced cycle-through-4-cardinals with commit-to-direction: cached exit first (90s timeout), then 8 directions sorted by drift-from-spawn, 40-block hops with 45s timeout, stuck-maneuver (back 3, sidestep 15) + autoBreakStuckPlant recovery, 5 stucks per direction max, successful exit recorded to memory.

### 2026-04-14 — #1 PartialReadError reconnect storms ✅

Commit `70d1446` + ViaBackwards 5.0.4 in server `mods/`. Mineflayer 4.37 supports MC 1.21.1+; server runs 1.21.0 base — slot-component packet drift. Fix: ViaBackwards translates 1.21.4 protocol (769) → 1.21.0 (767), bot pinned to `minecraft_version: "1.21.4"`. Before: ~4 reconnects/hr; after: 0 reconnects over multi-hour windows.

### 2026-04-14 — #5/#6 Torches ✅

Commit `436ff45`. #5 `world.shouldPlaceTorch` rewritten to require actual darkness (night via timeOfDay, underground via `pos.y < 50`, or `skyLight < 8`) plus no torch within 8 blocks. #6 `digDown` places a torch every 4 descended blocks (was 8), `goToSurface` follows the trail back up. New `placeTorchAt` helper records to `bot.placedTorches`.

### 2026-04-14 — Bot action mutex (concurrency fix) ✅

Commits `3c11948` + `d9a5f66`, merged as `6fdcff2`. Reentrant FIFO mutex (via `AsyncLocalStorage`) gates every bot-mutating path; modes use `execute()` chokepoint. Eliminated `goal was changed` / `Digging aborted` race errors. SafeToss disposal went from 100% failure to 96%+ success.

### 2026-04-14 — Spawn-zone protection design + initial escape work

Implemented `_isInSpawnZone` (`SPAWN_PROTECTION_RADIUS = 250`) blocking destructive actions inside zone. Initial `escapeSpawnZone` skill auto-walks bot 350 blocks from spawn on every spawn event. Refined later through Bugs A/B/C + the rewrite.

### Pre-2026-04-15 — #7a Replant tree saplings ✅

Already implemented in `skills.js collectBlock`. `LOG_TO_SAPLING` map for 9 tree types; tracks stump positions during multi-log collect, replants on dirt/grass/podzol/mud/rooted_dirt/coarse_dirt/mycelium/moss_block. Spawn-zone protection inherited from `placeBlock`. Discovered to already exist 2026-04-15.
