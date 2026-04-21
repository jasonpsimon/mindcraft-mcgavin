# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

---

## Current state (live on develop)

**Deployment:**
- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft-mcgavin`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b` via LM Studio. Bot is **running** — StateTicker (BT-1), BootSnapshot (BT-8), LLM call telemetry (BT-3), DamageStream (BT-2), startup-window ordering fix (BT-12), MemoryRecall (BT-4), AutoRecovery stats (BT-5), Skill lifecycle (BT-7 + BT-7b), Goal lifecycle, and Pathfinder telemetry (BT-6) all verified live 2026-04-17.
- Branch: `develop` — HEAD `672fdbe` (WB hygiene pass on top of #31 code ship). Most recent code ship 2026-04-20: **#31 POI location memory** (`2714f02`) — new `src/agent/poi_memory.js` observability-adjacent module that passively auto-captures notable world features as the bot moves (portals, beacons/conduits/lodestones, generated structures via signature blocks, villages + player-base zones by polling `bot.protectedZones`). Two-tier detection mirrors #7c/#7d (60s scanner + blockUpdate watcher with double-sided filter); closure-state observability pattern (configure/hook/getStats/JSONL sink at `data/poi-stream.jsonl`); persists to `bots/<profile>/poi_memory.json`; ContextBuilder Priority 3.6 "Known POIs" injection (top-N nearest in current dimension). Bot rebooted clean, awaiting live capture verification. Prior ship 2026-04-20: #33 auto-craft torches MVP (`22ed805`, debug iterations `cdd65e7` / `d07e57f`, transient-revert `2198a97`) — new `auto_craft` mode closes the silent-skip surfaced 2026-04-14; gate logic live-verified via one-cooldown probe. See Recently completed for the full 2026-04-17 observability bundle.
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

_Empty. Move items here when actively being worked on._

---

## Shipped — awaiting live verification

### #31. POI location memory — auto-capture of notable world features (`2714f02`, 2026-04-20)

**What shipped.** New observability-adjacent module `src/agent/poi_memory.js` (~420 lines) that passively records notable POIs as the bot moves through the world, so later natural-language references ("meet me at the portal") resolve to coordinates. Closure-state pattern from CLAUDE.md (`configurePoiMemory` / `hookPoiMemory` / `getPoiStats` / `getPoiSnapshot` / `getPoiContext`), idempotent hook via `bot._hookedPoiMemory = bot` reference-identity gate, persists to `bots/<profile>/poi_memory.json` (debounced 5s) with JSONL sink at `data/poi-stream.jsonl`. Mounted in `src/agent/agent.js` spawn handler right after `hookDoorTracker` and before `escapeProtectedZone`, gated by `settings.poi_memory.enabled`.

**Two-tier detection** (mirrors #7c/#7d shape):
- **60s scanner** — `bot.findBlocks` over signature catalog within 96 blocks (max 256 hits): portals (`nether_portal`, `end_portal`), landmarks (`beacon`, `conduit`, `lodestone`), structures (`end_portal_frame` → stronghold, `nether_bricks` cluster ≥8 → fortress, `reinforced_deepslate` → ancient city, `copper_bulb`/`copper_grate` → trial chamber). Plus `_stampFromZones` polls `bot.protectedZones[]` on every tick → stamps `village` and `player_base` POIs from zones already registered by #7 scanner / #7c / #7d. No duplication of existing detectors.
- **`bot.on('blockUpdate')` watcher** — double-sided filter: `newBlock` in POI-signature allowlist AND `oldBlock` in `REPLACEABLE_OLD` (air/cave_air/water/lava/grass/snow/etc.). Drops 99%+ of events at zero cost (leaf decay, redstone tick, water flow). Sub-second latency for just-lit nether portals and just-placed beacons. Cluster-gated types (nether_bricks) run a 10-minute sliding-window cluster pass.

**Record shape.** `{_key, type, subtype, pos:[x,y,z], dimension, first_seen, last_seen, source:'scanner'|'watcher'|'zone_village'|'zone_player_base', confidence, signals}`. Dedup key: `{type, dimension, x_bucket=floor(x/16), z_bucket=floor(z/16)}` — 16-block grid. `maxEntries=500` LRU trim by `last_seen`.

**ContextBuilder wiring (new Priority 3.6).** Added `poiContext` section to `src/memory/context_builder.js` between `nearbyBlocks` (3.5) and `commands` (4). `src/models/prompter.js` computes it via dynamic import (`poiMod.getPoiContext(agent)`) alongside `nearbyBlocks`, passes as `build()` param, and appends `poi:${stats.sections.poiContext || 0}` to the ContextBuilder stats log. Injects top-8 nearest POIs by `dist(bot.position, poi.pos)` filtered to `bot.game.dimension`, formatted as `Known POIs:\n- type/subtype @ (x,y,z) [dist]`.

**Design trade-offs.**
- **Separate `poi_memory.json`, not `MemoryBank`.** MemoryBank is 24 lines of `name → [x,y,z]` — no dimension, type, timestamp, source, or confidence. Auto-POI has fundamentally different semantics from `!rememberHere` (user-named, explicit). Keeping them split avoids polluting the user table.
- **Poll `bot.protectedZones[]`, don't subscribe.** Existing village scanner + `detectNearbyPlayerStructures` push zones directly to the array — no callback/event. A 60s poll sees new zones within one tick after registration; acceptable latency for a passive memory layer, and zero coupling to scanner internals.
- **Cluster-gated nether_bricks (threshold 8).** Individual nether_bricks appear in inventory walls / random fortress fragments; 8+ within a 12-block radius is a reasonable fortress signal. All other structure signature blocks (end_portal_frame, reinforced_deepslate, copper_bulb/grate, beacon, conduit, lodestone) are singleton-promoting because they're rare/unique.
- **Dynamic import in `prompter.js`.** Keeps startup decoupled — `poi_memory.js` only loads when a prompt is being built, not at prompter construction. Failure path logs a warning and passes empty string.
- **All POI types in one ship** (per JP's 2026-04-20 decision). Deferred: chat-labeled landmarks, `!goToPOI <type>` command surface.

**Verification.**
- `node --check` passed on all 4 modified files: `src/agent/poi_memory.js` (new), `src/agent/agent.js`, `src/memory/context_builder.js`, `src/models/prompter.js`.
- Bot rebooted clean on HEAD `2714f02` — StateTicker 1Hz for 45+ consecutive pulses, HP 17, dimension overworld, LLM init reply observed ("Hello world! I am ThatCoolGuyDude."), zero exception / throw / uncaught / syntax-error lines in tmux capture. StateTicker mounts AFTER the POI hook in the spawn handler, so its liveness confirms the POI hook completed without throwing.
- Rule 7 "complete the perimeter" audited: closure state only, no bot mutation anywhere in `poi_memory.js`; idempotent hook gate prevents double-registration on soft reconnect.

**Status:** ✅ shipped — **awaiting live verification** (signals: (a) `[POI] register village|player_base (x,z) source=zone_*` line in tmux pane within ~60s of bot walking into a village or detected player base; (b) `[POI] register portal/nether_portal (x,y,z) source=watcher` when JP lights a nether portal within 64 blocks of the bot; (c) `data/poi-stream.jsonl` accumulating JSONL events; (d) `bots/ThatCoolGuyDude/poi_memory.json` populating and persisting across restarts; (e) ContextBuilder log includes `poi:>0` once at least one POI is within `contextMaxDistance=256`).

---

### #33. Auto-craft basic-need items — torches MVP (`22ed805`, 2026-04-20)

**What shipped.** New `auto_craft` mode in `src/agent/modes.js` between `torch_placing` and `elbow_room` (lines ~731–770). Periodic state-maintenance tick that closes the silent-skip surfaced 2026-04-14: bot's #5/#6 underground torch pipeline never fired because the bot had never crafted torches — a classic Principle 1 gap (mechanical decision routed through the LLM, which never reliably made it). Now a 10s cooldown tick auto-crafts torches when `torch_count < 16` AND `coal+charcoal ≥ 1` AND `stick ≥ 1` AND bot is idle + healthy + no reflex latch active. Single primitive: `skills.craftRecipe(bot, 'torch', 1)` → 4 torches per call, which auto-finds/cleans up a crafting table as needed.

**Design trade-offs.**
- **Reuses mode-tick cadence.** Following the `torch_placing` template (cooldown + conditional + `execute()` wrapper) gives `!setMode auto_craft off` for free, no new observability module, no new pause/enable surface.
- **Calls `skills.craftRecipe` directly, not `AutoRecovery.craftItem`.** `craftItem` is a wrapper over the same skill — calling through it would just add cross-cutting via the recovery subsystem for no behavior gain.
- **Charcoal counts same as coal.** Vanilla recipe accepts either; the gate unions both counts.
- **Idle-only + health ≥ 6 + no reflex latch** (`_lowHpRetreatActive` / `_drowningEscapeActive` / `_creeperEvadeActive`). Respects the 10s cooldown. Threshold 16 hardcoded per MVP scope.
- **Deferred (per #9 theme):** auto-craft sticks, tools, food; config knobs for thresholds.

**Verification path.** Code-ship was `22ed805`. Two transient debug commits followed: `cdd65e7` (commit 2.5, dbg-pre/dbg-post around craftRecipe) and `d07e57f` (commit 2.6, `[AutoCraft][gate]` probe before early-return gates). The probe ran one cooldown window on a fully-idle bot and returned `torch=64 fuel=0 stick=70 idle=true hp=17 empty=1` — gates are working as designed (bot already past threshold AND has no fuel; either condition alone would silently return). The earlier "silent-success" observation was a misread of `craftRecipe`'s own stale success-log template, not a real bug. Debug patches reverted in `2198a97` (commit 2.7). Final form is the minimal shipped code.

**Verification.**
- `node --check src/agent/modes.js` passed across all four code commits.
- Bot rebooted clean on every deploy — StateTicker 1Hz, zero `[AutoCraft]` handler-failed lines, zero exception lines.
- Gate logic proven correct live (see probe output above).

**Status:** ✅ shipped — **awaiting live verification** (signal: bot's `torch_count` drops below 16 AND `coal`/`charcoal` ≥ 1 AND `stick` ≥ 1 simultaneously → `[AutoCraft] torches low (N/16) + have coal+stick → crafting 4` line appears in tmux capture; torch count in inventory increments to N+4; #5/#6 breadcrumb placement starts firing on subsequent `digDown` sweeps. Will trigger organically once the bot uses down its current 64-torch stockpile while underground mining, OR sooner via `!discard torch 48` + coal acquisition to force the conditions.)

---

### #7d. Block-update watcher for runtime-placed structures (`7d58837`, 2026-04-20)

**What shipped.** Live counterpart to #7c's 30s polling scanner. New `startPlayerStructureWatcher(bot)` in `src/agent/library/skills.js` (right next to `startPlayerStructureScanner`) hooks `bot.on('blockUpdate')` and maintains a 10-minute sliding window of player-characteristic block placements. On every qualifying event, prunes aged-out entries, runs one cluster pass over the window, and promotes any cluster that hits `PLAYER_MIN_SIGNALS=6` (and isn't already registered) via the exact same `_playerBaseZoneFromCenter` used by the scanner — identical zone shape, identical dedup. Wired in `src/agent/agent.js` right after the scanner startup block with the same try/catch shape.

**Design trade-offs.**
- **Filter: newBlock in allowlist AND oldBlock air/water/replaceable.** Mineflayer's `blockUpdate` fires for every block change in loaded chunks — water flow, redstone state, leaf decay, fire spread, per-tick furnace state, crop growth, etc. The double-sided filter (destination AND source) drops 99%+ of events at zero cost and leaves only actual placements of player-characteristic blocks.
- **No duplication with #7c.** Reuses `PLAYER_CHARACTERISTIC_BLOCKS` allowlist, `_clusterPositions`, `_playerBaseAlreadyRegistered`, and `_playerBaseZoneFromCenter`. Principle 5 clear: watcher adds a new capability (sub-second latency) the scanner can't provide, so it's not a wrapper — both coexist cleanly with identical output shape and identical dedup.
- **Idempotent hook.** `bot._playerStructureWatcherHooked = bot` reference-identity gate. Matches the observability-module pattern from CLAUDE.md. Soft reconnects that re-invoke the startup block never double-hook the same bot instance.
- **10-minute window.** Long enough that a builder can place blocks over a realistic build session and still cluster together; short enough that random one-off placements (e.g. a single banner) age out before they can accumulate with unrelated later placements.

**Verification.**
- `node --check` passed on both `src/agent/library/skills.js` and `src/agent/agent.js`.
- Bot rebooted clean on HEAD `7d58837` — StateTicker 1Hz, HP 20/20, food 15, inventory 36, threats tracked (creeper/bogged/skeleton), zero exception lines, zero `[PlayerStructureWatch]` handler-failed lines in 25s of capture.

**Status:** ✅ shipped — **awaiting live verification** (signal: JP builds a structure with ≥6 player-characteristic blocks — wool / concrete / stone-bricks / redstone / banners / beds / doors / glass-panes — within 12 blocks of each other, while bot is within 64 blocks; expect `[PlayerStructureWatch] live cluster at (x, z) — N signals; registering zone player_base_<x>_<z> (radius 40)` within a few seconds of the 6th placement).

---

### #8. Humanized action delays (`e6e7b5a`, 2026-04-20)

**What shipped.** New module `src/agent/human_delays.js` exporting `getHumanDelay(commandName) → ms` — classifies a command name into one of five tiers (INSTANT 0ms, trivial 1–2s, movement 2–3s, gather/craft 3–5s, complex 4–6s), with uniform jitter within each range. Single wire-in at `src/agent/commands/index.js` inside `executeCommand`, immediately after `command.perform` returns: `const delay = getHumanDelay(parsed.commandName); if (delay > 0) { console.log('[HumanDelay] ...'); await new Promise(r => setTimeout(r, delay)); }`.

**Design trade-offs.**
- **INSTANT allowlist for emergency/meta.** `!stop`, `!stfu`, `!restart`, `!clearChat`, `!endGoal`, `!endConversation`, `!setMode`, `!addRule`, `!removeRule`, `!viewRules`, `!help`, `!viewGoals` all return 0ms. Kill-switch and conversational-mode commands must be instant — a human hitting `!stop` should not wait for a 3-second pause.
- **Unknown-command fallback = movement tier.** Deliberately conservative. If actions.js gains a new command before this table is updated, it gets 2–3s rather than 0ms — we'd rather be slightly-too-slow than re-introduce the robotic/anti-cheat problem the ticket is solving.
- **Mode-bypass by construction.** The wire is inside `executeCommand`, which is only called for LLM-issued `!commands`. Mode-triggered reflexes (self_preservation, self_defense, BT-10e shield-raise, BT-10g drowning-escape, BT-2-L3 turtle-helmet) call bot/skill methods directly and never pass through `executeCommand`. They stay millisecond-fast by construction — combat and drowning response is unchanged. No explicit "skip if mode" check needed.

**Verification.**
- `node --check` passed on both `src/agent/human_delays.js` and `src/agent/commands/index.js`.
- Bot rebooted clean on HEAD `e6e7b5a` — StateTicker 1Hz, HP 20/20, food 15, no parse errors. Pre-existing benign protodef `PartialReadError` noise present (mineflayer baseline, not a regression).

**Status:** ✅ shipped — **awaiting live verification** (signal: LLM issues any non-INSTANT `!command` in conversation → `[HumanDelay] !X waiting Nms` line in tmux capture + measurable pause between successive commands in state-stream).

---

### #2 Layer 3. Turtle helmet auto-equip reflex on water entry (`71df242`, 2026-04-20)

**What shipped.** State-maintenance reflex in `src/agent/modes.js` `self_preservation.update()`, placed between the BT-10g drowning-escape block and the BT-10e shield-auto-raise block (same reflex pattern — latch + skip-conditions). When the bot enters water, if inventory holds a `turtle_helmet` and the head slot is empty or holds a ≤iron-tier helmet, auto-equip it. Latched via `bot._turtleHelmetEquipped` so the equip only fires once per session.

**Design trade-offs.**
- **Don't downgrade diamond/netherite.** Turtle armor value is 2 (same as iron). Skipping swap when head holds diamond/netherite preserves the better protection — we gain breathing but lose armor tier in that rare case, so we keep the better armor.
- **No symmetric revert.** Unlike BT-10g's "clear on surface" or BT-10e's "clear when no hostile," Layer 3 has no "re-equip diamond when on land" pair. Keeping this minimal — the bot can re-equip manually via `replaceBrokenArmor` logic if needed.
- **Complements BT-10g, doesn't replace it.** BT-10g is the last-resort panic (surface and jump at oxygen ≤ 10). Turtle-helmet gives a 10-second O₂ buffer + slow Water Breathing while worn — it prevents the crisis BT-10g handles. Both live side-by-side.

**Verification.**
- `node --check src/agent/modes.js` passed post-patch.
- Bot rebooted clean on HEAD `71df242` — StateTicker 1Hz, HP 20/20, food 15, inventory 36 items, creeper/bogged/skeleton threats tracked.

**Success signal (awaiting natural trigger).** Bot enters water with `turtle_helmet` in inventory → expect log line `[Survival] turtle-helmet equipped (water entry)` in tmux capture, and head slot (`bot.inventory.slots[5]`) populated with turtle_helmet on the next state-stream snapshot. Graduates to Recently completed on first observation.

**Blast radius.** Near-zero. Pure addition — no existing code paths touched. Early-return on `!bot._turtleHelmetEquipped` means cost is one bool read per tick after first equip. Skip-if-diamond/netherite protects the one case where the swap would regress the bot's equipment.

---


### #12-follow-up. `digCost=10` / `placeCost=2` in `createMovements` factory (`85d93f7`, 2026-04-20)

**What shipped.** Two cost-biasing lines inside the `createMovements(bot)` factory in `src/agent/library/skills.js`, applied after `m.maxDropDown = 3` and before the protected-zone check:

```js
m.digCost = 10;
m.placeCost = 2;
```

Pathfinder defaults are `digCost=1` / `placeCost=1` — equal to walking — so the planner has been happily mining through obstacles and scaffolding across gaps when a short detour exists. These values bias against destructive path elements without forbidding them.

**Principle 5 note (kill redundancy).** `installSafePathfinderDefaults` at `skills.js:~1755` was already applying `digCost=10` to `bot.collectBlock.movements` with the exact same rationale ("no straight-down digging" safety norm). Same value, different surface — the factory now owns the rule uniformly. `placeCost=2` is new: a softer bias since scaffolding is occasionally the only path (2-block gaps), but should still lose to a comparable walk-around.

**Rule 2 (completed the audit, not just the sketch).** Full read of `createMovements`, `installSafePathfinderDefaults`, and the two lazy-built destructive Movements in `goToGoal` (lines 3657 / 3676) before shipping. The two in `goToGoal` are the one legitimate "I WANT to dig" call path; they live below the factory and rely on the factory's defaults *as their starting point*, then override `maxDropDown` and explicitly want the default low `digCost`. This is why placement is *inside* `createMovements` (not in `_configureTerrainSafeMovements`) — destructive callsites can still override back to `1` if they ever need to; today no callsite does.

**Verification.**
- `node --check src/agent/library/skills.js` passed post-patch.
- `bash scripts/check-movements-invariant.sh` → OK (factory still the only raw callsite).
- Bot rebooted clean on HEAD `85d93f7` — StateTicker 1Hz, HP 20/20, food 15, no errors, creeper/bogged threat tracking live.

**Success signal (awaiting natural trigger).** Path-stream telemetry at `data/path-stream.jsonl`: on comparable terrain to pre-ship logs, expect a higher ratio of `walkaround` vs `dig` entries in the pathfinder's plan deltas. Graduates to Recently completed once a clean comparison window is available.

**Blast radius.** Low. All 9 `goToGoal`-family callers still work — they either use the factory Movements (now biased toward walkaround, which is what they wanted anyway), or build destructive Movements below the factory override (unchanged behavior — they explicitly reset `digCost`). Collect-block paths unchanged (separate Movements via `installSafePathfinderDefaults`, which already had `digCost=10`).

---


### L1.4-wire BT 2. Protected-zone allowlist for `tillAndSow` (`ea48e1d`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: `!tillHere <seed>` invoked inside a protected zone succeeds with `[ProtectedZone] Bypassed break/place at ... — allowlist: tillAndSow` log line; control case `!placeBlock <type>` inside same zone still blocked by normal tripwire).

**What shipped.** One file (`src/agent/library/skills.js`), ~40 lines added across three sites:
1. **Module-level allowlist** near `_isInAnyProtectedZone`: `const PROTECTED_ZONE_ALLOWLIST = new Set(['tillAndSow'])` with a comment documenting the opt-in protocol (caller sets `bot._allowProtectedZoneOps = '<skillName>'`, clears in `finally`).
2. **Two gate bypasses** at `_impl_breakBlockAt` and `_impl_placeBlock`: when `_isInAnyProtectedZone` returns a zone hit, check `bot._allowProtectedZoneOps` against `PROTECTED_ZONE_ALLOWLIST.has(...)`. On match, log `[ProtectedZone] Bypassed ...` and fall through. On miss (default), preserve the original block-and-return behavior.
3. **`_impl_tillAndSow` body wrapper**: `try { bot._allowProtectedZoneOps = 'tillAndSow'; ... } finally { bot._allowProtectedZoneOps = null; }`. Covers all three tripwired sub-calls (2× cheat-branch `placeBlock(farmland/seed)`, 1× non-cheat `breakBlockAt` clear-above).

**Why it matters.** L1.4-wire BT 1 graduated `tillAndSow` to a `!tillHere` LLM command, but the underlying skill's break/place sub-calls were tripwired by the spawn / protected-zone gates. Inside any protected zone, `!tillHere wheat_seeds` would fail at the clear-above (non-cheat) or farmland-place (cheat) step. JP's intent (2026-04-20): till + sow is non-destructive enough that it should work in player areas — that's where farms naturally go. BT 2 lands the carve-out, completes the L1.4-wire arc.

**Why bot-flag bypass (Option 1).** Mirrors existing BT-7b `_placeIntent` pattern in `_impl_placeBlock`. Smallest delta — doesn't touch `wrapSkill` (Option 2 — would have rippled across ~35 wrapped skills) and doesn't mutate `breakBlockAt` / `placeBlock` signatures (Option 3 — would have made every existing caller a question). Future allowlist additions: one-line append to the Set + matching try/finally at the new skill's entry point.

**Blast radius.**
- Default state (`bot._allowProtectedZoneOps === null`) preserves full protection — bypass branches are unreachable.
- Only `_impl_tillAndSow` sets the flag; only `'tillAndSow'` is in the allowlist. Any other LLM command (`!placeBlock`, `!collectBlock`, `!safeToss`, etc.) inside a protected zone still hits the original block-and-return path.
- `finally` clears the flag on every exit (success, early-return, throw) — bypass cannot leak into a subsequent skill invocation. Verified pattern via BT-7b's identical try/finally shape.
- Only the **break/place** gates honor the allowlist. Other `_isInAnyProtectedZone` consumers (`safeToss` :1250/:1411, `autoBreakStuckPlant` :2410, `escapeProtectedZone` filter passes, dig branch :631) intentionally NOT bypassed — they're not on `tillAndSow`'s call path and the flag's narrow scope means it can't accidentally reach them.

**Rule 2 audit.**
- Read `wrapSkill` (`src/observability/skill_lifecycle.js:175`) — confirmed it does NOT propagate caller-name into a runtime context (only emits telemetry). Original WB note about "wrapSkill actionLabel" was wrong; corrected this session.
- Read `_isInAnyProtectedZone` and all 7 callsites. Only `_impl_breakBlockAt` and `_impl_placeBlock` are reachable from `_impl_tillAndSow`'s call chain.
- Read `_impl_tillAndSow` body in full. Three sub-calls touch tripwires: cheat branch `placeBlock(bot, 'farmland', ...)`, cheat branch `placeBlock(bot, seedType, ...)`, non-cheat `breakBlockAt(bot, x, y+1, z)`. All covered by the function-level try/finally.
- Pattern parity with BT-7b: `_impl_placeBlock` already uses `bot._placeIntent = 'intentional'; try { ... } finally { bot._placeIntent = null; }` — exact same shape, exact same lifetime guarantees. Two parallel single-purpose flags rather than overloading one.

**Verification signals to watch.**
- Bot boots cleanly — **observed during restart 2026-04-20 (HEAD ea48e1d)**. Health 20, food 15, inventory intact, StateTicker 1Hz, LLM ("Awaiting LM Studio response from model gemma-4-e4b") active, no errors.
- Next `!tillHere <seed>` invocation inside a protected zone: `[ProtectedZone] Bypassed break at (x,y,z) inside <radius>-block <label> — allowlist: tillAndSow` line in tmux pane (or `Bypassed place` for cheat-mode); seed planted on farmland.
- Outside protected zones: `!tillHere wheat_seeds` continues to work as before (BT 1 verified — bypass is a no-op since gate isn't hit).
- Control case (proves bypass is scoped): inside same protected zone, `!placeBlock oak_planks` still blocks with `[ProtectedZone] Blocked place at ... — Cannot place blocks near ...`.
- Cleanup verification: after a `!tillHere`, the next sensitive command (e.g. `!placeBlock` outside zone) does NOT carry the bypass. `bot._allowProtectedZoneOps` should be `null` between skill invocations — verifiable via state-stream if exposed, or by behavior parity with pre-BT-2.

**L1.4-wire arc complete.** BT 1 (`01a82b6`) wired the commands; BT 2 (`ea48e1d`) makes `!tillHere` actually useful in the places people farm. `!activate` was already protected-zone-safe (right-click, no tripwires). `!consume` already wired and zone-safe. Audit finding L1.4 ("possibly-dead exports") fully resolved.

---


### L1.4-wire BT 1. Register `!tillHere` + `!activate` commands (`01a82b6`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: next `!tillHere <seed>` and `!activate <block_type>` invocations resolve without `unknown command` errors; agricultural/interactive behavior observable).

**What shipped.** One file (`src/agent/commands/actions.js`), ~30 lines added. Two new command registrations inserted after `!placeHere`:
- `!tillHere <seed_type>` → `skills.tillAndSow(bot, floor(x), floor(y)-1, floor(z), seed_type)`. Mirrors `!placeHere` convention (uses bot's current position). Sows the seed on the block directly under the bot's feet.
- `!activate <type>` → `skills.activateNearestBlock(bot, type)`. 16-block search radius. `BlockName` param type for LLM-side validation.

**Why it matters.** L1.4 audit (2026-04-15) flagged two fully-implemented skills with zero `!command` reach: `tillAndSow` and `activateNearestBlock`. JP confirmed 2026-04-20: both are intentional library surface, wire them. This ship graduates them from "dead exports" to "LLM-usable commands."

**Blast radius.**
- One file touched; no `skills.js` changes.
- Existing commands untouched — anchor-based patch (before `!attack`).
- `skills.tillAndSow` internals unchanged; `skills.activateNearestBlock` internals unchanged.
- Bot rebooted clean on HEAD `01a82b6` — StateTicker 1Hz, inventory preserved, nearby_entities tracking live, health 20/20, no parse or command-registration errors.

**Rule 2 audit.**
- Confirmed no prior `!till`, `!tillHere`, `!activate` registration (grep clean).
- Param types (`BlockName`, `ItemName`) match existing conventions (see `!placeHere` for BlockOrItemName, `!consume` for ItemName).
- `tillAndSow` signature: `(bot, x, y, z, seedType=null)` — all four args supplied.
- `activateNearestBlock` signature: `(bot, type)` — both args supplied.
- `runAsAction` wrapper matches all sibling registrations.

**Protected-zone behavior (BT 2 scope — follow-up).** `!activate` is tripwire-safe: `bot.activateBlock()` is a right-click interaction, not break/place. Works in protected zones today with no further work. `!tillHere` WILL fail inside protected zones because `tillAndSow` internally calls `breakBlockAt` (clear block above) and `placeBlock` (sow seed) — both tripwired. BT 2 will add a protected-zone allowlist at the tripwire sites so `tillAndSow` passes through.

**Verification signals to watch.**
- Bot boots cleanly — **observed during restart 2026-04-20 (HEAD 01a82b6)**. Health 20, food 15, inventory intact, nearby_entities list populated (creepers + skeleton at ~10 blocks distance).
- Next LLM attempt to invoke `!tillHere <seed>` or `!activate <block_type>`: no `unknown command` response; skill executes.
- Outside protected zones: `!tillHere wheat_seeds` on grass_block → farmland + wheat_seeds planted, `log(bot, 'Planting wheat_seeds at ...')`.
- Inside protected zone: `!tillHere ...` fails at breakBlockAt/placeBlock step — expected until BT 2 ships.
- `!activate crafting_table` (or any interactive block): `log(bot, 'Activated crafting_table at ...')`, interaction emits (opens GUI, toggles lever, etc.).

---


### OPT-I. Delete dead `setMovements(createMovements())` in `_impl_moveAway` (`9dd17a4`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: `!moveAway` invocations continue to path away from the current position correctly; no regression when cheat-mode is on or off).

**What shipped.** One file, ~1 line net (3 comment lines added, 1 code line removed). Deleted the unconditional `bot.pathfinder.setMovements(createMovements(bot))` at the top of `_impl_moveAway` (formerly skills.js:4015). Left an explanatory comment in its place documenting why the allocation was dead. Cheat-branch `const move = createMovements(bot)` unchanged — it's consumed by `getPathTo(move, inverted_goal, 10000)` and is correctly scoped.

**Why it matters.** Rule 3 / dead-code removal. Matches OPT-C's `pickupNearbyItems` finding: a `setMovements(createMovements(bot))` call whose effect is immediately overwritten by `goToGoal`'s own factory build (post-OPT-B) is pure waste — one `createMovements()` invocation per `moveAway` call that nothing reads. The 2026-04-16 audit flagged this as "dedup: first could potentially be reused"; Rule 2 read revealed the first isn't used at all, so the fix is deletion rather than sharing.

**Blast radius.**
- One file (`src/agent/library/skills.js`), `_impl_moveAway` only.
- Cheat-branch: unchanged. `const move` still locally allocated and consumed by `getPathTo`. Early-return on success unchanged.
- Non-cheat branch: control falls through to `goToGoal(bot, inverted_goal)`, which (post-OPT-B) unconditionally calls `setMovements` with its own non-destructive-first factory build. Behavior bit-for-bit identical to pre-ship.
- No external consumers depend on Movements state being set prior to `moveAway` returning (wrapped by `wrapSkill`; Movements lifetime is per-skill-invocation).

**Rule 2 audit.** Read `_impl_moveAway` body (skills.js:4003-4035 pre-ship), confirmed the first `setMovements` value has zero readers before it's overwritten. Cheat-branch's `move` is a fresh local. Checked `grep -n 'pathfinder.setMovements' skills.js` — `goToGoal` at line 3664 is the authoritative setter post-OPT-B. No callers of `moveAway` rely on pre-existing Movements config.

**OPT-bundle status.** **Closed: 6/6 (B/C/D/E/F/I).** The 2026-04-16 optimization-audit bundle is fully shipped. Three dead-code deletions (C, I) + two module-scope constant hoists (D, E) + one lazy-build refactor (B) + one helper extraction (F). Net: ~1 `createMovements()` call saved per `moveAway` + ~1 per `goToGoal` happy-path + ~1 per `pickupNearbyItems` loop iteration + one Set pre-allocated for `_isDangerous` + one Set pre-allocated for `scanForCaverns` + ~30 lines of duplicated yaw-snapping logic consolidated. No behavior changes.

**Verification signals to watch.**
- Bot boots cleanly — **observed during restart 2026-04-20 (HEAD 9dd17a4)**. StateTicker ticking at 1Hz, LLM inference active (`[LLM] label=LMStudio-Embed ... status=ok`), MemoryRecall returning episodes, no errors.
- Next `!moveAway` invocation (self-prompted or operator-triggered): bot pathfinds away from current position, final position > `distance` blocks from start. `log(bot, 'Moved away from ... to ...')` line emits with sane floored coords.
- Cheat-mode path (if enabled): `/tp @s X Y Z` issued with coords from `getPathTo` final node. No regression.
- No `TypeError` or `ReferenceError` during first `moveAway` call after boot.

---


### OPT-F. Extract `_yawToCardinal` helper shared by `digDown`/`digUp` (`d16658b`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: `digDown` / `digUp` next invocation continues to log `heading south|west|north|east` correctly and the staircase pattern advances in the expected direction).

**What shipped.** One file, net ~30-line reduction. Added module-scope helper `_yawToCardinal(yaw) -> { dx, dz, name }` immediately above `_impl_digDown`. Replaced the 14-line inline yaw-normalize + 4-way branch block at both callsites with a single destructuring line: `const { dx, dz, name: dirName } = _yawToCardinal(bot.entity.yaw);`.

**Why it matters.** Rule 3 / cosmetic dedup. Minecraft yaw-to-cardinal is a well-defined mapping (yaw 0 = south, pi/4 boundaries snap to the four compass directions); having it duplicated inline in two sibling functions invited future drift. With the helper in place, directional-dig extensions (diagonals, 8-way, Y-axis variants) have a single point of modification.

**Blast radius.**
- One file (`src/agent/library/skills.js`).
- Two callsites (`_impl_digDown`, `_impl_digUp`). Both verified identical pre- and post-edit.
- Boundary values (5.5, 0.785, 2.356, 3.927) and `{dx, dz}` assignments preserved bit-for-bit.
- `dirName` derivation matches pre-ship behavior: south when dz=1, north when dz=-1, west when dx=-1, else east.

**Rule 2 audit.** Both inline blocks were bit-for-bit identical in the pre-ship source (confirmed via the Python patch's `.count(old) == 1` assertions on each identical 14-line pattern). `grep -n 'normalized >= 5\.5' skills.js` returned zero matches after the patch — no leftover inline callers. No external consumers of these snapped values (return via function-local `dx`/`dz`/`dirName`).

**OPT-bundle status.** With OPT-F shipped, the 2026-04-16 optimization-audit bundle is 5/6 closed (B/C/D/E/F). Remaining: I (`moveAway` Movements dedup) — needs a proper Rule 2 pass before shipping; unlike B-F, the two Movements objects there may have different config requirements (cheat-mode branch).

**Verification signals to watch.**
- Bot boots cleanly — **observed during restart 2026-04-20 (HEAD d16658b)**. StateTicker ticking at 1Hz, inventory preserved, no errors.
- Next `!digDown` or `!digUp` invocation: `[Skills] digDown: starting at ..., heading <dir>, distance=...` log line appears with correct cardinal direction matching bot's facing yaw at invocation time.
- Staircase pattern advances in the expected cardinal (dx/dz unchanged from pre-ship).
- No `ReferenceError: _yawToCardinal is not defined` at module-load or first-call.

---


### OPT-E. Hoist `scanForCaverns` `rockTypes` Set to module-level constant (`85c9241`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: `digDown` cavern-detection continues to classify dripstone/stone/deepslate walls correctly; bot continues to short-circuit to nearby caverns via non-destructive walk-in paths when available).

**What shipped.** One file, ~15 lines net. Added `const CAVERN_ROCK_TYPES = new Set([...16 block names])` at module scope directly above `scanForCaverns`. The inline `new Set([...])` that previously lived inside the triple-nested scan loop (built once per viable cavern candidate) is deleted; callsite now reads `CAVERN_ROCK_TYPES.has(wb.name)`.

**Why it matters.** Pure-constant hoist, same shape as OPT-D's `DANGEROUS_BLOCK_NAMES`. Slightly cooler hot-path — `scanForCaverns` runs on-demand (per `digDown` invocation) rather than every tick — but the inline Set was being allocated inside a wall-check loop that runs for every candidate passing the earlier gates (airCount ≥ 6, solid floor, ceiling present). A typical `digDown` with caverns nearby builds the Set dozens of times under the old pattern; now it's built exactly once per process boot.

**Blast radius.**
- One file (`src/agent/library/skills.js`), one function body + one new module-scope constant.
- Single caller (`digDown`:4683) — verified via `grep -rn scanForCaverns src/`.
- Set contents identical to old inline contents (16 rock-type block names). Bit-for-bit behavior.
- Function signature, return shape, all gate conditions unchanged.

**Rule 2 audit.** Read `scanForCaverns` body (skills.js:4560-4645), confirmed the only consumer of `rockTypes` is the 4-wall-check `for (const wc of wallChecks)` loop at 4621-4624. No other reference. No caller depends on the Set-constructor-being-called side effect (there isn't one).

**OPT-bundle status.** With OPT-E shipped, the 2026-04-16 optimization-audit bundle is 4/6 closed (B/C/D/E). Remaining: F (yaw-to-cardinal helper extraction, pure cosmetic) and I (moveAway Movements dedup, needs verification).

**Verification signals to watch.**
- Bot boots cleanly — **observed during restart 2026-04-20 (HEAD 85c9241)**. StateTicker ticking, ContextBuilder at 2041/6908 tokens, LLM inference active.
- Next `digDown` invocation: log line `[CavernScan] Found cavern at ...` or `[CavernScan] No caverns found nearby` should appear as before. Neither the detection nor the short-circuit behavior changes.
- No `TypeError: CAVERN_ROCK_TYPES is not defined` at module-load or first-call.
- Regression absence: cavern-detect → walk-in-via-GoalNear behavior should be statistically indistinguishable from pre-ship.

---


### OPT-D. Hoist `_isDangerous` block-name list to module-level Set (`178ebe2`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: tunnel-scanning and safeToss continue to correctly refuse lava/water/bedrock/air as landing blocks; no regression in dig-vs-walk or toss-direction behavior).

**What shipped.** One file, 10 lines (8 insertions, 2 deletions). Added `const DANGEROUS_BLOCK_NAMES = new Set(['lava', 'water', 'bedrock', 'air', 'cave_air'])` at module scope right above `_isDangerous`. Function body simplified from `return [...].includes(name)` to `return DANGEROUS_BLOCK_NAMES.has(name)`. All 9 callsites unchanged.

**Why it matters.** `_isDangerous` is a hot-path predicate called from 9 sites in skills.js — tunnel-scan validation (lines 1287, 1299, 1308, 1364, 1443, 1455, 1464, 1524) and safeToss direction scoring (line 2405). Several of these are inside tight nested loops that iterate over every block in a scan radius. Previously every call allocated a fresh 5-element array and ran linear `.includes()` scan. Now it's O(1) `Set.has()` against a single pre-allocated Set.

**Measurable impact estimate.** Over a typical mining session, `_isDangerous` is invoked on the order of 10k+ times per minute during active tunnel-scan windows. Per-call savings are small but the allocation pressure (5 string literals → V8 string-intern lookups + array object) was non-trivial GC churn that this removes.

**Blast radius.**
- One file, one function body + one new module-scope constant.
- Function signature, name, return semantics all unchanged.
- 9 callsites unchanged.
- Set contents identical to the old array contents. Behavior bit-for-bit identical.

**Rule 2 audit.** Read `_isDangerous` definition, all 9 callsites, and verified no caller depends on the exact mechanism (e.g. none passed a non-string and relied on `.includes()`'s strict-equality weirdness with NaN or mixed types — all callers pass `block.name` strings).

**OPT-bundle status.** With OPT-D shipped, the 2026-04-16 optimization-audit bundle (B, C, D) is fully closed. B/C/D all shipped 2026-04-20. No further OPT items queued from that audit.

**Verification signals to watch.**
- Bot boots cleanly — **observed during restart 2026-04-20 (HEAD 178ebe2)**.
- Tunnel-scan and safeToss continue to classify lava/water/bedrock as dangerous — watch `data/damage-stream.jsonl` for continued zero lava/water landing incidents.
- No `TypeError: Set is not a constructor` or similar (V8 ≥ 3.x supports Set; node version is modern, safe).
- Regression absence: any safeToss cycle observed in `data/skill-stream.jsonl` should show the same refusal patterns it did pre-ship.

---


### OPT-C. Delete dead Movements block in `pickupNearbyItems` loop (`9a7b7eb`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: `pickupNearbyItems` still collects items at normal rate; no regression in post-mining cleanup behavior).

**What shipped.** One file, 8 lines (5 insertions, 3 deletions). The 3-line block `let movements = createMovements(bot); movements.canDig = false; bot.pathfinder.setMovements(movements);` at the top of the `while (nearestItem)` loop in `pickupNearbyItems` was deleted and replaced with an explanatory comment.

**Finding.** Stronger than the original WB hypothesis ("build once before the loop"). On read, those 3 lines were **fully dead code** — `goToGoal` (which is the very next line) unconditionally calls `bot.pathfinder.setMovements(final_movements)` with its own safe factory build (non-destructive first, destructive fallback post-OPT-B). The outer Movements object was constructed, configured, `setMovements`-ed, and immediately overridden every single iteration.

**`canDig=false` intent preserved.** The stated goal of the deleted code (don't dig through blocks to reach an item) is already satisfied — and more strictly — by `goToGoal`'s non-destructive-first strategy: `digCost=10`, `placeCost=2`, glass-unbreakable, glass-pane-unbreakable. Only if a non-destructive path is not found does `goToGoal` fall back to a destructive path — but at that point, if the bot needs to dig to reach a floating item, it probably should.

**Why it matters.** `pickupNearbyItems` runs in a tight `while (nearestItem)` loop over every nearby item (up to dozens per post-mining cleanup pass). Deleting the dead block saves one `createMovements()` + `_configureTerrainSafeMovements()` + `setMovements()` triple per item picked up. Combined with OPT-B (which cut happy-path `goToGoal` construction from 2 → 1), a full cleanup pass now builds O(N) Movements instead of O(3N).

**Blast radius.**
- One file, one loop-body cleanup.
- Two callers (lines 456, 675) — both internal skill functions.
- Neither caller inspects or depends on `bot.pathfinder` Movements state after `pickupNearbyItems` returns. Verified by reading both callsites.
- `goToGoal` is still the authoritative Movements setter for every iteration.

**Rule 2 audit.** Read `pickupNearbyItems` body, both callers, and the `goToGoal` override behavior. Confirmed: the deleted block had zero observable effect on any code path.

**Verification signals to watch.**
- Bot boots cleanly (no SyntaxError) — **observed during restart 2026-04-20 (HEAD 9a7b7eb)**.
- `pickupNearbyItems` still collects items — watch for `[Skills] Picked up N items.` log lines at normal cadence.
- No `TypeError: movements is not defined` or similar inside the loop — would indicate the deletion left a dangling reference (none expected; grep confirmed no other refs to `movements` in the function).
- Regression absence: item-pickup rate during natural post-mining cleanup should be statistically indistinguishable from pre-ship baseline.

---


### OPT-B. Lazy-build `destructiveMovements` in `goToGoal` (`9887d62`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: no regression in navigation behavior; bot finds the same paths it did before, just with one fewer `createMovements()` call on the happy path).

**What shipped.** One file, 26 lines changed (15 insertions, 11 deletions). `goToGoal` restructured so `destructiveMovements` is only built inside the else-branch where it's actually used. Non-destructive construction + configuration unchanged.

**Behavior.** Identical. The control flow is:
1. Build + configure `nonDestructiveMovements`
2. `getPathTo(nonDestructive)` — if success, use it (happy path — now ends here)
3. Else: build + configure `destructiveMovements`, try it, fall through using destructive anyway if that also fails

Every external observable — path chosen, log line emitted, pathfinder.goto() call — is unchanged. The only change is **when** the destructive object gets constructed.

**Why it matters.** `goToGoal` is the hot path for every navigation skill (`collectBlock`, `moveAway`, `goToPosition`, `pickupNearbyItems`, construction loops, `goToBed`, etc.). `_configureTerrainSafeMovements` iterates protected zones and sets `blocksCantBreak` entries — non-trivial. Cutting the happy-path cost in half is a clean perf win on a function called thousands of times per session.

**Blast radius.**
- One file, one function body restructured.
- 20+ callers unaffected — they all just `await goToGoal(bot, goal)`; internal Movements construction is invisible.
- `final_movements` is still assigned before `bot.pathfinder.setMovements(final_movements)` in every branch (verified by walking both paths).
- No race — both `getPathTo` calls are sequential awaits, and `destructiveMovements` only exists inside the scope where it's used.

**Rule 2 audit.** Read `goToGoal` body + all 20+ callsites (grep `goToGoal(bot,`). Every caller is a fire-and-forget `await` on a goal object. No caller inspects internal Movements state. No caller has any coupling to construction order. Safe.

**Deferred (at ship time).** OPT-C and OPT-D remained queued when OPT-B shipped. Both since shipped (2026-04-20: `9a7b7eb`, `178ebe2`).

**Verification signals to watch.**
- Bot boots cleanly (no SyntaxError from restructured body) — **observed during restart 2026-04-20 (HEAD 9887d62)**.
- Navigation skills continue to find paths (watch for `[World]` "Found non-destructive path." / "Found destructive path." log lines at normal rate).
- No `ReferenceError: destructiveMovements is not defined` — would indicate the lazy scope was mis-structured.
- Regression absence: path success/failure rate in `data/path-stream.jsonl` should be statistically indistinguishable from pre-ship baseline.

---


### #12 Stage 2. Route `world.js:isClearPath` through `createMovements()` (`93d7986`, 2026-04-20)

**Status:** ✅ shipped — **awaiting live verification** (signal: no regression in dig-vs-walk decisions; `isClearPath` probes honor OPT-J hazards and BT-10j drop cap the same as the rest of pathfinder).

**What shipped.** Two files, 10 lines total. `skills.js`: `createMovements` is now exported. `world.js`: new `import { createMovements } from './skills.js'` and `isClearPath` starts from the factory, then applies its three non-destructive overrides (`canDig=false`, `canPlaceOn=false`, `canOpenDoors=false`) on top.

**Scope finding.** Entry research revealed the "20+ raw callsite sweep" described in the original #12 Stage 2 entry had already happened organically across BT-10j, OPT-J, and the Survival-series ships. The grep of `new pf.Movements(bot)` across the codebase returned only two hits going into the ship: the factory definition in `skills.js:2248` and this lone `world.js:397` caller. This ship closes the last one.

**Why it matters.** `isClearPath` is a walk-probe used to decide between "walk around" and "dig through". Pre-ship it used raw pathfinder defaults — no OPT-J hazard avoidance, `maxDropDown=4`. A probe could return "clear" for a path that walks through lava/campfire, or requires a 4-block drop (which BT-10j explicitly prevents elsewhere). That meant dig-vs-walk decisions could diverge from what pathfinder would actually plan. Post-ship: the clear-path answer is consistent with the rest of the bot's path planning.

**Circular import note.** `skills.js` imports from `world.js`, and now `world.js` imports `createMovements` from `skills.js`. ES modules handle this correctly as long as the imported binding is not dereferenced at module-load time. `createMovements` is only called inside `isClearPath`'s function body at runtime, so by the time the call happens both modules are fully loaded and the binding resolves. Verified by live restart — bot boots without `SyntaxError` or `undefined is not a function`.

**Blast radius.**
- Two files, one new named export, one new import, one function body edit.
- No behavior change for any existing `createMovements()` caller (function body unchanged).
- `isClearPath` is net-restrictive: any case where the pre-ship probe returned "clear" but pathfinder would actually refuse the path will now correctly return "not clear". No reverse case exists.

**Rule 7 audit.** Single perimeter: `createMovements()` is now the only non-commented `new pf.Movements(bot)` call in the codebase. grep `new pf\.Movements\(` across `src/` returns 1 match — the factory definition itself.

**Deferred (#17 first slice).** Full extraction of `createMovements` + `_configureTerrainSafeMovements` + `_isInAnyProtectedZone` into a new `src/agent/library/movements.js` module is deferred until #17 decomposition starts in earnest. Creating a 2-function module now would be premature; the natural grouping is "movements + zone helpers + terrain-safe config" and that belongs as one cohesive move.

**Verification signals to watch.**
- Bot boots cleanly (no ESM circular-load crash) — **observed during restart 2026-04-20**.
- No runtime errors inside `isClearPath` — watch stdout for `[World]` or uncaught rejection traces.
- Any caller of `isClearPath` that previously decided "walk" for a path through lava/campfire would now decide "dig" or "not clear" — behavioral signal difficult to surface without specific world state; main verification is regression-absence.

---


### BT-10i. Pre-fight equip polish (`30de1f4`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs bot to engage a hostile with a shield in inventory — observe shield in offhand before first swing; also verify near-broken weapon is skipped when a healthy alternative exists).

**What shipped.** One file (`src/agent/library/skills.js`), two functions (`equipHighestAttack`, `_impl_defendSelf`). 27 insertions, 0 deletions. Zero new imports, zero new modes.

**Two deltas:**

1. **`equipHighestAttack` durability filter.** Before the `attackDamage` descending sort, filter out weapons with `(maxDurability - durabilityUsed) / maxDurability < 0.05`. If filtering leaves zero weapons, fall back to the original unfiltered list (swinging a near-broken weapon beats fists). Defensive: if `maxDurability` or `durabilityUsed` is missing/non-numeric, treat as fine (don't accidentally drop a perfectly good item due to a schema quirk).
2. **`_impl_defendSelf` shield-to-offhand.** One-shot block at the top of the `try`, before the enemy-search loop: `bot.inventory.items().find(it => it.name === 'shield')` — if found and offhand slot (index 45) isn't already that item, `await bot.equip(_shield, 'off-hand')`. Errors logged via `console.warn` and swallowed (same policy as `_equipBestToolFor`).

**Why once-per-call, not per-iteration.** Mineflayer's pvp handles shield-blocking when offhand is equipped; re-equipping every 500ms would be wasteful and would re-trigger on every fight-loop pass. The weapon-side early-return (`bot.heldItem?.type !== weapon.type`) already rate-limits main-hand equips cheaply.

**Why `inventory.slots[45]` for offhand.** Mineflayer exposes the offhand slot at index 45 (standard Minecraft slot numbering: 0-8 crafting, 9-35 main inventory, 36-44 hotbar, 45 offhand). No cleaner API for "what's in offhand" that works in all mineflayer versions we target.

**Blast radius.**
- Two functions touched, both localized. No pathfinder changes, no mutex changes, no new listeners, no new state on the bot.
- Fight loop and pvp wiring untouched — shield just shows up in the offhand before the loop starts.
- #28 fix guards (`holder === 'defendSelf'`, `bot.pvp?.target`) unaffected: shield equip happens before the pvp engagement begins, so mutex holder is still `defendSelf` throughout.

**Guardrails.**
- Shield equip wrapped in its own try/catch — an equip failure (inventory full, offhand locked) is logged once and combat continues bare-offhand.
- Durability filter defensive-default is "assume healthy" when either `maxDurability` or `durabilityUsed` is missing — avoids dropping otherwise-usable weapons due to schema inconsistency.
- Empty-inventory path unchanged: `if (weapons.length === 0) return;` still runs first, so the durability filter only sees a non-empty list.

**Out of scope.**
- Enchantment weighting (Sharpness/Smite tier preference). The attackDamage field already reflects base damage; enchantments would need NBT parsing and tier mapping. Deferred.
- Autocrafting a shield if none exists. Similar to the BT-ReplaceArmor pattern but more invasive — needs a crafting-table proximity check and planks+iron availability check. Deferred.
- Moving `equipHighestAttack` out of the fight-loop inner call. The early-return guard is already cheap enough in the common case (weapon unchanged between iterations).

**Verification hooks.**
- Combat with a shield-in-inventory bot: expect main-hand swap to best weapon AND offhand to `shield` before first swing. Observable in state-stream (`equipped.mainHand` / `equipped.offHand`) and `tmux` `[Skill] name=defendSelf` lifecycle line.
- Combat with a near-broken sword + healthy fallback: expect `bot.heldItem` to be the fallback, not the near-broken sword. Same observable.

---

### BT-10h. Dimension-aware survival tuning (`8956d33`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs bot to travel to Nether and/or End; observe that overworld behavior is unchanged, lava-adjacent backoff stays quiet in Nether, low-HP retreat fires at hp<10 not hp<6, and void-retreat latch logs in End at y<10).

**What shipped.** One helper `_dimensionProfile(bot)` in `src/agent/modes.js` plus three gated reflexes + one new void-awareness branch in `self_preservation.update()`. Zero new imports, zero new modes, no changes to `_impl_defendSelf` or any skill.

**Helper shape (`_dimensionProfile(bot) → {dim, lowHpThreshold, lavaAdjacentBackoff, voidCheckY}`):**

| Dimension | `lowHpThreshold` | `lavaAdjacentBackoff` | `voidCheckY` |
|-----------|------------------|----------------------|--------------|
| Overworld | 6                | true                 | null         |
| Nether    | 10               | false                | null         |
| End       | 10               | true                 | 10           |

Handles both namespaced (`minecraft:the_nether`) and bare (`the_nether`) dimension strings via a `.replace(/^minecraft:/, '')` strip. Defaults to overworld profile if `bot.game.dimension` is missing/unexpected.

**Three deltas:**

1. **BT-10a lava-adjacent preemptive backoff — gated.** Added `&& _dimensionProfile(bot).lavaAdjacentBackoff` to the `else if` clause. Overworld: unchanged. Nether: disabled (lava is the floor — the reflex would either spam every tick or strand the bot on basalt platforms; primary `isInLava` escape still fires). End: enabled (matches overworld profile).
2. **BT-10b low-HP retreat threshold — parameterized.** `bot.health < 6` → `bot.health < _dimensionProfile(bot).lowHpThreshold`. Overworld stays at 6. Nether/End bump to 10 — regen requires 18+ hunger (harder to maintain between food sources), hostiles are tankier, and retreats take longer through uneven terrain.
3. **Void-awareness branch (new).** Inserted at top of `update()` next to other latch blocks. When `voidCheckY !== null` and `bot.entity.position.y < voidCheckY` and pathfinder is moving, latch `_voidRetreatActive = true`, stop pathfinder, call `skills.moveAway(bot, 3)`. Clears at `y >= voidCheckY + 2` (2-block buffer prevents flapping). Also clears if dimension changes out of End. Logs `[Survival] void-retreat dim=end y=...` once per latch.

**Why void-awareness needs its own branch.** Void drop in the End is instant-death with no HP-based reflex to catch it — bot falls, dies, zero damage ticks in between. Had to be anticipatory, not reactive. Y<10 is the "you are off the main island and falling" signal in vanilla End terrain (main island floor sits around y=56-64).

**Why gate lava-adjacent rather than expand it.** The primary `bot.entity.isInLava` escape at line ~268 is authoritative and dimension-agnostic — if the bot is actually in lava, it still fires in the Nether. The gated BT-10a clause is the *preemptive* "you are standing next to lava" backoff, which is the one that would misfire in a lava-floor dimension.

**Blast radius.**
- `self_preservation.update()` + one new helper function at module scope.
- Overworld profile matches pre-BT-10h behavior exactly (verified by reading the before/after).
- No pathfinder interaction changes outside the void-retreat latch (which mirrors BT-10b retreat shape).
- `bot.game.dimension` / `bot.entity.position` / `bot.pathfinder.isMoving` defensive guards throughout.

**Guardrails.**
- Helper returns overworld profile on any unrecognized dimension string (safe default).
- Void-retreat latch clears on dimension change (prevents stale latch bleeding across portals).
- `voidCheckY + 2` hysteresis on clear prevents rapid re-fire at the threshold.

**Out of scope.** Dimension-specific combat tuning (ghast shield, ender dragon positioning). Entry logging per dimension. Any "return through portal" logic — JP's policy is the bot is free to travel; this BT only adjusts the survival reflexes' calibration, not the bot's freedom of movement.

---

### BT-10f. Creeper proximity evade (`0cd2d11`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs creeper within 5 blocks at HP≥6; observe `creeper-evade` log + retreat to ≥8 blocks before fuse completes)

**What shipped.** Two new code paths inside `self_preservation.update()` in `src/agent/modes.js`. Zero new imports.

**1. Creeper-evade latch clear (top of update, alongside BT-10b/c/d/e clears).**
```js
if (bot._creeperEvadeActive) {
    let nearestCreeperDist = Infinity;
    try {
        const c = world.getNearestEntityWhere(
            bot, e => e && e.name === 'creeper', 10);
        if (c) nearestCreeperDist = bot.entity.position.distanceTo(c.position);
    } catch (_) {}
    if (nearestCreeperDist === Infinity || nearestCreeperDist > 8 || bot.health < 6) {
        console.log(`[Survival] creeper-evade cleared dist=... hp=...`);
        bot._creeperEvadeActive = false;
    }
}
```

**2. Creeper-evade trigger (after BT-10d ranged-close in the chain).** Fires when `bot.health >= 6 && !bot._creeperEvadeActive` AND a creeper exists within 5 blocks. Sets the latch, logs `[Survival] creeper-evade dist=<d>`, says `Creeper! Backing off!`, `execute()` → `skills.moveAwayFromEntity(bot, creeper, 8)`.

**Range picks.**
- **Trigger: 5 blocks.** Creeper fuse zone is 3 blocks; trigger at 5 gives 2 blocks of margin for path-planning lag.
- **Retreat: 8 blocks.** Normal creeper blast radius is 3; even a charged creeper (×2) is ≈6. 8 blocks puts the bot safely outside either.
- **Clear threshold: >8 blocks OR no creeper within 10.** Two-sided clear with hysteresis — the 10-block scan radius for clear-check is wider than the 5-block trigger so we don't flicker at boundary movement.

**Branch ordering rationale.** Placed AFTER BT-10d ranged-close. Creeper is not in BT-10d's name allowlist (skeleton/stray/pillager only), so no conflict — this is a dedicated branch for the creeper special case. BT-10b low-HP retreat takes priority via the HP≥6 gate handing off cleanly.

**Blast radius.**
- `self_preservation.update()` only. No touch to combat or self_defense.
- `skills.moveAwayFromEntity` reused (same primitive BT-10b uses) — pathfinder handles the vector math + goal construction.
- Combat can still ranged-attack the creeper after the bot reaches 8 blocks — this branch doesn't disable combat, just establishes safe distance first.

**Guardrails.**
- Exact name match `creeper` (not substring) so `skeleton` doesn't false-trigger via any shared-prefix concerns.
- `charged_creeper`: in mineflayer the name stays `creeper`; the `charged` status is on the metadata. Our 8-block retreat is still outside charged-blast radius, so the simple name match is sufficient.
- HP≥6 gate prevents conflict with BT-10b retreat.
- Latch prevents re-triggering `moveAwayFromEntity` every tick.
- Try/catch around the entity scan — chunk-unload-transient resilient.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. `bot._creeperEvadeActive` joins the latch family (`_lavaEscapeActive`, `_lavaEdgeBackoffActive`, `_lowHpRetreatActive`, `_suffocationEscapeActive`, `_rangedEvadeActive`, `_shieldRaiseActive`). No fan-out.

**Skip (explicit).**
- Shooting creeper at range — combat/self_defense territory.
- Creeper-kiting (hit-and-run loops) — combat-loop territory.
- Cat-proximity de-aggro (cats scare creepers) — niche behavior; not a reflex.
- Charged-creeper-specific extra distance — 8 blocks is already safe for the charged case; no gain from special-casing.
- Pre-explosion aim-tracking (creeper starts fusing → compute exact contact point) — overengineered; moveAway at trigger handles it.

**Verification signals to watch.**
- **Trigger:** creeper walks into 5 blocks at HP≥6 → `[Survival] creeper-evade dist=4.8` line; `Creeper! Backing off!` chat; pathfinder routes away.
- **Clear (escaped):** bot reaches ≥8 blocks → `[Survival] creeper-evade cleared dist=8.2`; latch reset; combat can engage safely.
- **Clear (creeper gone):** creeper killed/despawned → cleared dist=none.
- **Clear (escalation):** HP drops below 6 mid-retreat → cleared; BT-10b takes over next tick.
- **Non-trigger (wrong mob):** skeleton at 5 blocks, no creeper → branch does NOT fire; BT-10d ranged-close handles skeleton separately.
- **Non-trigger (too far):** creeper at 8 blocks, no closer → branch does NOT fire; combat can attack from current position.


### BT-10e. Shield auto-raise (`cd39540`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs shield in offhand slot 45 + hostile within 16 blocks; observe `shield-raise` log + visual shield-up in third-person)

**What shipped.** One self-contained state-maintenance block at the top of `self_preservation.update()` in `src/agent/modes.js`. Pair of clear-branch + trigger-branch sharing a single outer `if/else`. Zero new imports.

**Key insight: state maintenance, not alternative action.** Unlike BT-10a/b/c/d which fire as exclusive branches in the else-if chain (one action per tick), shield-raise needs to run independently every tick — we want the shield up during movement, during retreats, during ranged-close, during anything. So it's placed at the top of update() alongside the latch-clear block, NOT in the chain. Does not affect the else-if chain's flow.

**Structure (single `if/else`):**
```js
if (bot._shieldRaiseActive) {
    // clear branch: threat gone OR shield unequipped → deactivate + reset
} else {
    // trigger branch: pre-gate on shield-in-offhand, then threat check → activate + latch
}
```

**Pre-gate (zero cost when no shield).** `bot.inventory.slots[45]?.name?.includes('shield')` — if no shield, branch is a no-op. Combat/user owns inventory; we don't auto-equip.

**Threat detection.** `world.getNearestEntityWhere(bot, e => mc.isHostile(e), 16)` — any hostile within 16 blocks triggers. No name filtering (unlike BT-10d) because a shield helps against both melee and ranged.

**Actions.** `bot.activateItem(true)` raises the offhand shield. `bot.deactivateItem()` lowers it. Both wrapped in try/catch — mineflayer is resilient but chunk-transient edge cases exist.

**Blast radius.**
- `self_preservation.update()` top-of-update only. No touch to else-if chain, no new imports, no pathfinder interaction.
- Shield-raised vanilla movement penalty (~20% slower) is accepted: if threats are near, slower is a fair trade for arrow blocking.
- Auto-eat modules call `deactivateItem` before eating — on the next tick the threat is still present and we re-raise. Small flicker is tolerable.

**Guardrails.**
- Pre-gate = zero effect without shield.
- Symmetric trigger/clear = no stuck-raised-on-nothing state.
- Latch prevents activateItem spam.
- Clear on shield-unequipped = clean exit if bot drops or swaps mid-fight.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. `bot._shieldRaiseActive` joins the latch family (`_lavaEscapeActive`, `_lavaEdgeBackoffActive`, `_lowHpRetreatActive`, `_suffocationEscapeActive`, `_rangedEvadeActive`). No fan-out.

**Skip (explicit).**
- Auto-equip shield from main inventory: user/combat's job.
- Main-hand sword + offhand shield auto-swap: same reason.
- Disabling shield against axe attacks (vanilla temp-disable): vanilla shield mechanics handle it server-side; keeping it raised is still correct.
- Per-attack timing (parry windows): not achievable with current signal set; vanilla passive blocking is good enough.

**Verification signals to watch.**
- **Shield present + threat near:** skeleton/zombie/creeper within 16 → `[Survival] shield-raise threat=<name> dist=<d>` line; shield visibly raised in third-person.
- **Clear (threat gone):** hostile killed / walked away → `[Survival] shield-raise cleared threat=false shield=true` line; shield lowered.
- **Clear (shield dropped):** bot tosses or loses shield during fight → `[Survival] shield-raise cleared threat=true shield=false`; latch resets.
- **No-op (no shield):** combat with no shield in offhand → no log lines, no raise attempt.
- **No-op (no threats):** shield in offhand, peaceful area → no log, no raise.
- **Interplay:** during BT-10d ranged-close, shield stays up (state maintenance runs regardless of the chain branch taken).


### BT-10d. Ranged-attacker close-distance reflex (`ddbf4c8`, 2026-04-19)

**Status:** ✅ shipped — **awaiting live verification** (needs bot at HP≥6 with a skeleton/stray/pillager at 6-20 blocks; observe `ranged-close` log + pathfinder goal set toward hostile + melee hand-off at ≤5)

**What shipped.** Two new code paths inside `self_preservation.update()` in `src/agent/modes.js`. Zero new imports (`world.getNearestEntityWhere`, `mc.isHostile`, `skills.goToPosition` all already available).

**1. Ranged-evade latch clear (top of update, after BT-10c suffocation clear).**
```js
if (bot._rangedEvadeActive) {
    let nearestRangedDist = Infinity;
    try {
        const rangedNames = ['skeleton', 'stray', 'pillager'];
        const h = world.getNearestEntityWhere(
            bot,
            e => mc.isHostile(e) && rangedNames.includes(e.name),
            20
        );
        if (h) nearestRangedDist = bot.entity.position.distanceTo(h.position);
    } catch (_) {}
    if (nearestRangedDist === Infinity || nearestRangedDist <= 5 || bot.health < 6) {
        console.log(`[Survival] ranged-close cleared dist=... hp=...`);
        bot._rangedEvadeActive = false;
    }
}
```

**2. Ranged-close trigger (after BT-10b proactive retreat).** Fires when `bot.health >= 6 && !bot._rangedEvadeActive` AND a ranged hostile (skeleton/stray/pillager) exists within 20 blocks AND distance ≥ 6. Sets the latch, logs `[Survival] ranged-close type=<X> dist=<d>`, says `Closing on <X>!`, `execute()` → `skills.goToPosition(bot, floor(x), floor(y), floor(z), 4)`.

**Branch ordering rationale.** Placed AFTER BT-10b low-HP retreat so that when both conditions match (low HP + ranged threat), retreat takes priority. The ranged-close logic is exclusively for the healthy-bot vs. kite scenario.

**Range windowing (`[6, 20]`).**
- **Lower bound 6:** below this the bot is in melee range and `self_defense` / combat skills handle engagement. Closing into that space via pathfinder would fight combat's own target-tracking.
- **Upper bound 20:** matches typical arrow engage range. Beyond 20 the kiter is already out of threat range and pathfinder chase overhead isn't worth it.

**Name allowlist (skeleton/stray/pillager).** Explicit set. Excludes melee hostiles (zombie/spider/drowned-without-trident) where closing distance is already correct-by-default for combat. Excludes Nether/End ranged (blaze/ghast) — those are candidates for dimension-aware handling in a later sub-item.

**Three-sided clear.** Latch clears on any of:
- No ranged hostile within 20 (they gave up / died / bot walked away).
- Distance ≤ 5 (we closed, combat takes over).
- HP < 6 (BT-10b retreat takes priority; cleanly hands off).

Two-sided progress conditions + one escalation condition. Prevents oscillation (we don't re-trigger immediately after closing because we clear first) and prevents conflict with BT-10b.

**Blast radius.**
- `self_preservation.update()` only. No touch to combat, `self_defense`, or pathfinder internals.
- `skills.goToPosition` is the battle-tested primitive; already wraps `wrapSkill('goToPosition', _impl_goToPosition)` with the Movements config and safe defaults.
- Target position is captured at trigger tick. If the skeleton moves during the path, the pathfinder won't chase — but the latch clears on every tick based on current geometry, so re-trigger on next opportunity is natural.

**Guardrails.**
- Latch prevents re-firing every tick.
- Name allowlist, not `isHostile` alone — precise trigger.
- HP≥6 gate prevents conflicting with BT-10b low-HP retreat.
- `execute()` catches its own errors; latch cleanup via top-of-update handles recovery.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. `bot._rangedEvadeActive` joins the other bot-owned latches (`_lavaEscapeActive`, `_lavaEdgeBackoffActive`, `_lowHpRetreatActive`, `_suffocationEscapeActive`). No fan-out.

**Skip (explicit).**
- Strafe / perpendicular dodge: needs per-tick control-state toggling; closing distance accomplishes the same aim-break with simpler control flow.
- Shield auto-raise: separate concern (BT-10e candidate) — would also help vs. melee attackers.
- Blaze/ghast handling: Nether-specific; folds into the dimension-safety sub-item.
- Reactive damage-type detection (`lastDamageSource === 'arrow'`): not needed — presence of a ranged hostile in the kite zone is a sufficient trigger without waiting for the first arrow to land.

**Verification signals to watch.**
- **Trigger:** bot at HP≥6 with a skeleton 12 blocks away → `[Survival] ranged-close type=skeleton dist=12.0` line; `Closing on skeleton!` chat; pathfinder sets goal at the skeleton's position; bot walks toward it.
- **Clear (closed):** bot reaches ≤5 blocks → `[Survival] ranged-close cleared dist=4.x hp=X.X`; latch resets; combat/self_defense takes over.
- **Clear (wander-off):** skeleton walks out of 20-block radius → same cleared log, dist=none.
- **Clear (escalation):** HP drops below 6 during the close → cleared log; BT-10b retreat fires on next tick.
- **Non-trigger (melee hostile only):** zombie at 10 blocks, no skeleton → branch does NOT fire (name allowlist).
- **Non-trigger (too close):** skeleton at 4 blocks → branch does NOT fire (below 6-block lower bound — combat territory).


### BT-10c. Suffocation escape (`4fb5a2e`, 2026-04-19) — fix `e1f47ac`

**Follow-up fix (`e1f47ac`, 2026-04-19):** false-positive debounce + diagnostic log.

- **Observed bug.** Bot triggered `Suffocating — digging up!` in a cave at ~5:04PM local while self-prompting for diamond armor. Game's own NEARBY_BLOCKS snapshot immediately before the trigger showed `Block at Head: air` and `First Solid Block Above Head: andesite (3 blocks up)`. Bot was not actually suffocating.
- **Root cause.** `bot.blockAt(position.offset(0, 1, 0))` can return stale/wrong results during fractional-y transitions (mid-jump, slab/stair, post-dig ticks). Single-tick glitch was enough to fire the trigger.
- **Fix.** Require 5 consecutive solid-head ticks (~0.25s at 20 TPS) before firing. Real suffocation persists for many seconds; position-rounding glitches clear in 1-2 ticks. Counter reset hoisted to top-of-update() (preserves else-if chain integrity).
- **Diagnostics.** Trigger log now includes `pos=<x,y,z>`, `legs=<block>`, `head=<block>` — any future false positive is triageable from one line.
- **Blast radius.** Same single perimeter (`self_preservation.update()`). Counter joins the latch family (`bot._suffocationSolidTicks`). No new imports.
- **Skip.** HP-delta gating (require damage before firing): considered but conflated with mob-hit damage; debounce alone handles the position-rounding class cleanly.
**Status:** ✅ shipped — **awaiting live verification** (needs bot to end up with head inside a solid bounding-box block — sand/gravel/cave-in/world-edit drop; then observe the dig-up + latch clear)

**What shipped.** Two new code paths inside `self_preservation.update()` in `src/agent/modes.js`. Zero new imports.

**1. Suffocation latch-clear (top of update, after BT-10b latch-clear).**
```js
if (bot._suffocationEscapeActive) {
    const passable = ['air', 'cave_air', 'void_air', 'water', 'lava'];
    const headClear = !blockAbove || passable.includes(blockAbove.name)
                       || blockAbove.boundingBox !== 'block';
    if (headClear) {
        console.log('[Survival] suffocation-escape cleared');
        bot._suffocationEscapeActive = false;
    }
}
```

**2. Suffocation trigger (before fall_blocks branch).** Fires when `blockAbove.boundingBox === 'block'` AND name not in `{air, cave_air, void_air, water, lava}` AND latch not set. Sets the latch, logs `[Survival] suffocation-escape type=<X>`, says the chat line, `execute()` → `skills.breakBlockAt(bot, floor(x), floor(y)+1, floor(z))`.

**Branch ordering rationale.** Placed BEFORE `fall_blocks` because once the head is ALREADY buried, `moveAway` can't escape (head is stuck in block). Dig-up has to run first. The `fall_blocks` branch is now the pre-collapse early-warning (sand ABOVE head but not yet fallen); the suffocation branch is the post-collapse recovery.

**boundingBox filter.** Using `blockAbove.boundingBox === 'block'` excludes leaves, fences, slabs, carpets, and other partial-collision or passable-named blocks. Only full-block collision triggers the dig.

**Lava-as-head-block exclusion.** `lava` is in the passable allowlist for this branch specifically so the existing lava branches (BT-10a + original) handle it. Suffocation and burning are different failure modes with different correct responses.

**Blast radius.**
- `self_preservation.update()` only. No touch to combat, pathfinder, skills, or any other mode.
- `skills.breakBlockAt` already honors the 250-block spawn-zone tripwire — inside spawn zone the dig will no-op silently. Acceptable: suffocation inside spawn zone is an extreme edge case; honoring the destructive-action invariant takes precedence.
- `skills.breakBlockAt` uses safe `Movements` config (no straight-down-shaft risk) — inherits Stage 1 of #12 automatically.

**Guardrails.**
- boundingBox filter: no false-positive on leaves/fences/slabs.
- Passable allowlist including `water` and `lava` for graceful hand-off to specialized branches.
- Latch gate: one dig attempt per episode.
- Clear on ANY head-clear path: dig success, player rescue, mob dislodge — all unblock the latch via the top-of-update check.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. `bot._suffocationEscapeActive` joins the other bot-owned mode-state fields (`_lavaEscapeActive`, `_lavaEdgeBackoffActive`, `_lowHpRetreatActive`). No fan-out.

**Skip (explicit).**
- Detecting suffocation via damage-event pattern (slower, less direct).
- Crawling / 1-block-gap swimming (different escape primitive; dig-up handles the common cases).
- Pathfinder-side prevention of suffocation-risk paths (separate concern).

**Verification signals to watch.**
- **Trigger:** bot's head ends up inside a sand/dirt/stone block (world-edit, cave-in, griefer) → `[Survival] suffocation-escape type=<name>` line; `Suffocating — digging up!` chat; bot digs block above; suffocation damage stops.
- **Clear:** after dig, head clears → `[Survival] suffocation-escape cleared` line; latch reset.
- **Leaves non-trigger:** bot stands under leaf canopy → branch does NOT fire (`boundingBox` not `block` for leaves).
- **Lava hand-off:** bot's head is in lava → lava branches handle it; suffocation branch does NOT fire (lava in passable allowlist for this branch's purposes).
- **Spawn-zone no-op:** bot somehow suffocates inside 250-block spawn zone → trigger fires, latch sets, but `breakBlockAt` no-ops due to tripwire; latch stays set until external rescue clears the head. Logged as `[ProtectedZone] breakBlockAt blocked — within spawn zone`.


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



### OPT-bundle. Unverified optimization findings from 2026-04-16 audit — ✅ CLOSED 6/6

**Status:** ✅ closed 2026-04-20 • **Priority:** (done)

All six items shipped after full Rule 2 codebase reads. Audit retrospective: the original surface-level findings were directionally correct (real optimizations existed in each of the named locations), but Rule 2 reads changed the nature of two fixes — OPT-C and OPT-I both turned out to be **dead-code deletion** rather than the dedup/reuse the audit anticipated (in both cases, `goToGoal`'s post-OPT-B factory override made a preceding `setMovements` call irrelevant). OPT-D/E/F landed as-anticipated. **Lesson carried forward:** a surface-level "could be reused" flag is worth a full Rule 2 pass — it might reveal the thing doesn't need to exist at all.

**Ships:**
- **B** (`9887d62`) — lazy-build `destructiveMovements` in `goToGoal`.
- **C** (`9a7b7eb`) — delete dead Movements block in `pickupNearbyItems` loop.
- **D** (`178ebe2`) — hoist `_isDangerous` block-name list to module-level Set.
- **E** (`85c9241`) — hoist `scanForCaverns` `rockTypes` Set to module-level Set.
- **F** (`d16658b`) — extract `_yawToCardinal` helper shared by `digDown`/`digUp`.
- **I** (`9dd17a4`) — delete dead first `setMovements` in `_impl_moveAway`.

This section retained as the audit-trail entry; remove on next hygiene sweep.

---

### 7e. Seed-based chunk-diff detection (research-only; original scope still parked)

**Status:** ⏳ research-only (original scope); narrower pivot promoted to **#7f** • **Priority:** very low for original scope

**Original scope.** Given world seed + MC version, regenerate each chunk deterministically and diff against current state. Any differences are human modifications or pre-generated structures. 100% accurate in principle. No 1.21-compatible JS terrain generator exists; porting Java's generator (~50K lines + caves-and-cliffs + trial chambers) remains a major undertaking.

**Research pass 2026-04-20 — ecosystem sweep.**

- **`prismarine-pregenerator`** (extremeheat) — WIP, 2 commits, 1.16 only. Not active.
- **`flying-squid` worldgens** (`node-voxel-worldgen`, `diamond-square`, `superflat`) — not vanilla-accurate. Toy worlds only.
- **`cubiomes` npm package** — 5 years stale at 1.1.1; Node-addon port announced but never materialised.
- **`cubiomes` C library** (Cubitect) — active, supports 1.21. Biome + structure-location logic only, NOT block-level terrain/caves.
- **Browser tools** (ChunkBase, MCSeedMap, cubiomes-viewer) — cover up to 1.21.4 via cubiomes-derived logic. Same domain limit.
- **Amidst** — discontinued post-1.17.1.

**Verdict on original scope.** Still infeasible. No project has ported or reimplemented Java's full block-level terrain generator in JS, and the cost hasn't changed (50K+ lines, grows each MC version). Revisit only if a library genuinely emerges — watch `prismarine` org and `extremeheat/prismarine-pregenerator` for movement.

**Server-side Fabric paths (considered, declined 2026-04-20).** A server-side companion (vanilla `/locate` + chat parse, Scarpet listener script, or custom Fabric mod) could sidestep the JS-generator problem entirely since the server already has the real generator loaded. JP declined all server-side paths: (a) won't OP the bot (rules out `/locate`), (b) prefers the bot stay self-contained and server-agnostic rather than depend on a companion mod. Kept documented here in case the calculus ever changes — e.g., if a companion mod ships for another reason (cf. #32) and adding a structure endpoint becomes near-free.

**Narrower pivot promoted to its own ticket → #7f.** The "what pre-generated structures are near the bot?" question is answerable today via cubiomes-WASM, fully client-side, no server changes. See #7f for scope, blockers, and sequencing.

**Decision.** Keep #7e parked under original scope. Pivot work tracked under #7f.


**🟡 Partial**

### 2-follow-up. Bot swim capabilities — water-breathing-potion auto-use

**Status:** 🟡 polish • **Priority:** low (no observed incident; turtle helmet already provides slow Water Breathing)

**Context.** #2 close-out 2026-04-20: Layer 1 (`canSwim=true` + drowning-escape reflex) shipped `b4f0190`-era; Layer 2 (`swim()` skill) closed as redundant — `goToPosition` + pathfinder's default `canSwim=true` + Layer 1's `escapeWater` already cover underwater traversal, so a dedicated wrapper would ship no new capability (Principle 5). Layer 3 (turtle-helmet auto-equip) shipped `71df242` — state-maintenance reflex in `self_preservation.update()`, latched, skip-if-diamond/netherite.

**Remaining polish (not yet shipped).** Water-breathing-potion auto-use: if inventory has a `potion` with `Potion of Water Breathing` effect AND oxygen drops below a threshold AND not already buffed, drink it. Not shipped because (a) turtle-helmet covers the common case with zero LLM reasoning, (b) potion-effect introspection is more API-hungry than armor-slot inspection, (c) no observed incident. Parked as a 2-follow-up in case telemetry ever shows BT-10g firing repeatedly on terrain the helmet-less bot can't handle.

**Signals to watch:** bot crosses rivers without drowning (✅ since Layer 1); turtle-helmet swap on water entry (Layer 3 awaits natural trigger); food/health stable in water; no "stuck" mode firing while swimming.

### 3-follow-up. Swamp biome polish — lily-pad walk-on + biome-aware profiles

**Status:** ⏳ parked (no motivating incident) • **Priority:** very low

**Context.** #3 closed 2026-04-20 as no-code redundancy. Baseline swamp traversal (water pockets, plant hazards, mangrove roots) is already covered by #2 Layers 1–3 + `_configureTerrainSafeMovements` + `autoBreakStuckPlant` + `PLANT_LIKE_PATTERN`/`MOVEMENT_BLOCKING_PLANTS`. Two polish items parked here in case telemetry ever shows a need:

**A. Strict lily-pad walk-on surface.** mineflayer-pathfinder returns `boundingBox='empty'` for lily_pad, so the planner treats it as walk-through (not walk-on) and plans swim paths through the water underneath. With turtle-helmet auto-equip + canSwim + drowning-escape the swim is safe, so this is elegance-only ("hop lily-pads like a human") rather than a capability gap. Would require a custom Movements patch that recognises lily_pad as a walkable top-face — upstream-library territory.

**B. Biome-aware movement profiles.** Current `createMovements` is biome-agnostic. Nothing anywhere in src/ switches pathfinder config based on `getBiomeName(bot)` — biome is purely read-only telemetry today. A biome-profile system could, e.g., lower `maxDropDown` in dripstone caves or tighten hazard lists in nether. No known incident motivating this — park as research-only.

**Signals to watch:** bot repeatedly swimming across a lily-padded pocket and appearing "unnatural" in play; biome-specific terrain deaths that the generic hazard list missed.

### 6. Strategic torch placement underground — strict left-wall convention

**Status:** 🟡 breadcrumb placement shipped 2026-04-14 (`placeTorchAt` + `digDown` every-4-blocks marker + `goToSurface` follows torches). Strict left-wall geometry deferred — current placement is "behind bot on floor". • **Priority:** low (current behind-bot placement works for breadcrumbs)

**Remaining work:**
- Compute "left of facing direction" wall position for each placement
- Place wall_torch attached to left wall vs floor torch
- Update `goToSurface` ordering hint (right-side torches = ascent direction)

### 17. `skills.js` decomposition (long-term)

**Status:** 🟡 partial • **Priority:** low (architectural) • **Source:** audit finding L6.1 • **Depends on:** #12 Stage 2 (for `createMovements` extraction point)

`src/agent/library/skills.js` is 4,138 lines — 4× the next-largest file in the tree. Every perimeter-audit finding in L2 lives here, every pathfinder catch violation in L3 lives here, and the file is the natural focus of every audit because everything is in it. Rule 2 (elegance) flags this implicitly: the per-function elegance is fine, but the aggregate cognitive cost is high.

**Natural first extraction target:** `createSafeMovements` helper from #12. Once the helper exists, move all movements-related code (plus its callers' safe-config glue) into a new `src/agent/library/movements.js`. After that: consider splitting combat / building / inventory / spawn-protection into separate modules.

Jumping ahead of the #12 Stage 2 extraction point would create a split-refactor hazard — let the `createMovements` helper exist first, then build on top. Keep flagged so it isn't forgotten.

---

**🔁 Ongoing**

### 30. Bot modes: Auto / Assistant / Survivor

**Status:** ⏳ not started • **Priority:** medium (user-facing control + structured autonomy)

Three top-level behavior modes that gate when and how the bot acts. Switchable by operator command; Auto is the inactivity fallback.

**Survivor.** Self-sustaining. Works through an ordered tier-up goal list — wood → stone → iron → diamond → netherite for tools, weapons, and armor — while mode reflexes keep the bot alive. The keep-alive layer is largely shipped already (self_preservation, BT-10g drowning-escape, BT-10e shield-raise, BT-2-L3 turtle-helmet, #10 survival hardening). New work for this ticket: the ordered goal queue itself + the "what's my current best tier and what's the next goal?" decision logic.

**Assistant.** Self-prompter paused while the relevant user(s) are online. Three sub-variants — all sticky (the *configured* assistant profile persists even when the runtime mode has dropped to Auto/Survivor):
- **Server-wide** — paused while ANY player is online.
- **Single-user** — paused only while a named player is online.
- **Both** — server-wide pause, named user can override in or out.

**Auto.** Not a distinct behavior — a state-machine rule. After 5 minutes of inactivity in any non-Survivor mode, the bot drops back into Survivor automatically.

**Sticky-return rule.** If the bot was configured as Assistant and fell into Auto/Survivor due to inactivity, a qualifying user interaction (server-wide: any player chats or joins; single-user: the named player chats or joins; both: either trigger) immediately restores the bot to its Assistant profile — no manual `!setMode` required.

**Survey before coding.** Several primitives almost certainly already exist:
- `!setMode` command registered (saw it in the #8 INSTANT allowlist).
- `self_prompter` pause/resume machinery (saw #23/#24 held-state + chat-yield work).
- Player-join/leave + chat events via mineflayer.
- TIERED_ITEMS inventory classification already knows tool/armor tier ordering (#11) — reusable for "what's my current tier?" checks in the Survivor goal list.
- `getCraftingPlan` exists; #9 calls out auto-trigger as an open theme.

**First commit on this ticket should be a research pass** — read what's in `modes.js`, `self_prompter.js`, and `actions.js` around `!setMode` to inventory what's already wired. Then design the state machine on paper (WB update). Then code.

### 32. Real-player location relay — bot can find a user on request

**Status:** ⏳ not started • **Priority:** medium (unblocks "come help me" UX; depends on external-side integration)

When a player asks the bot for help ("come help me", `!comeHelp`), the bot navigates to the player's real-world coordinates — even when the player is outside render distance or in a different dimension. Mineflayer's `bot.players[name].entity` only resolves when the player is in a loaded chunk near the bot, so this ticket is primarily about the **out-of-render-distance case**.

**Coordinate source — JP's preference: server-side mod or plugin.** Mineflayer alone cannot see a player's position when the player is outside the bot's render distance. Options considered:

- **✅ Spigot / Paper / Fabric plugin (JP's preferred path).** Small companion plugin exposes player positions to the bot — simplest shapes: (a) a plugin command like `/whereis <player>` that the bot reads from chat, (b) a scoreboard objective updated per tick with player XYZ (mineflayer can read scoreboards directly), or (c) a websocket/HTTP sidecar the bot polls. Scoreboard route is the lowest-friction — no extra network surface, mineflayer already receives scoreboard packets.
- **RCON `/data get entity <player> Pos`.** Works on vanilla + any RCON-enabled server without a plugin. Requires RCON credentials in the bot config. Good fallback if the plugin route stalls.
- **Cooperative chat fallback.** If neither plugin nor RCON is available, bot asks the player to run `/tp ~ ~ ~` output or share coords. MVP-acceptable but clunky.
- **❌ Mineflayer-only.** Rejected — can't see out-of-render players.

**Command surface.**
- `!comeHelp <player>` — explicit command, bot resolves target coords via the chosen source and pathfinds.
- Natural-language trigger — "come help me", "I need help", "come to me" routed through existing chat handler → LLM action selection → `!comeHelp`.

**Cross-dimensional travel.** If the player is in a different dimension, bot must traverse a portal. Deferred design — mark as sub-scope. For MVP, restrict to same-dimension and log a "player is in nether, can't reach from overworld yet" message if dimensions differ.

**Scope guard / Rule 2.** Existing `!goToPlayer` command likely covers the in-render case. #32 should **extend** that command (or add a thin wrapper that falls through to it when the player is loaded) rather than duplicate pathfinding logic. Verify during survey.

**Survey before coding.** Inventory before design:
- `!goToPlayer` command — existing? What does it do when the player is out of range?
- `bot.players` object shape — does it carry anything useful (uuid, ping) when the entity isn't loaded?
- Scoreboard packet handlers in mineflayer (`bot.scoreboards`, `bot.on('scoreboardUpdated')`).
- RCON client in node ecosystem — pick one (`rcon-client` is standard).
- JP's server — is it vanilla, Paper, Fabric? (Determines plugin API surface.)
- Dimension handling — `bot.game.dimension`, existing portal-traversal logic if any.

**First commit:** research pass to identify JP's server type and inventory existing `!goToPlayer` behavior. Second commit: decide plugin-vs-RCON and write the companion-side shim. Third commit: bot-side command wiring.

### 7f. Seed-aware structure oracle — client-side cubiomes-WASM

**Status:** ⏳ not started • **Priority:** low-medium • **Depends on:** #30 (for the goal-queue consumer) • **Enhances:** #31 POI memory, #30 Survivor goals

Client-side structure finder. Bot reads world seed + MC version from its profile, queries a bundled cubiomes-WASM module for structure locations within a radius, and feeds results into #31 POI memory and/or #30 Survivor goal selection. No server-side component, no companion mod, no bot OP — the bot stays self-contained and server-agnostic.

**Why client-side (vs. server-side Fabric options).** JP explicitly declined giving the bot OP (rules out vanilla `/locate`) and declined the companion-mod path (wants the bot to stay portable across servers). Client-side cubiomes-WASM regains appeal: zero server permissions, zero mod installs, works on day one of any new server as long as JP shares the seed with the bot config. See #7e research note for full comparison.

**Scope.**
- **One-time build work:** compile Cubitect/cubiomes (C, active, 1.21-compatible) to WASM via Emscripten. Wrap as a small node module. No published npm exists — this is packaging work, not porting.
- **Runtime API:** `getStructuresNear(x, z, radius)` → array of `{ type, x, z, dimension }`. Covers strongholds, villages, desert/jungle/ocean/woodland temples, igloos, ocean monuments, nether fortresses, bastion remnants, end cities, ancient cities, trial chambers, pillager outposts, ruined portals, slime chunks, biome boundaries.
- **Bot integration:** opt-in profile flag (`"worldSeed": "...", "enableStructureOracle": true`). On spawn hook, pre-populate `poi_memory.json` with known structures within N chunks of spawn (see #31 for POI schema).
- **What it does NOT cover:** caves, ore veins, terrain heightmap, block-level human modifications — cubiomes is biome+structure only. Live scanners (#7, #7c, #7d) continue to handle everything else.

**Design constraints (carried from #7e research).**
- Treat WASM as a hard boundary — no sync calls from hot paths. Query on spawn, on explicit `!findStructure <type>` command, and on goal-queue pull from #30. Never per-tick.
- Seed is sensitive-ish (leaking it trivialises server exploration). Keep it in profile config, not in logs, not in snapshots. Add to the redaction list.
- Version mismatch between bot config seed-version and server version → WASM returns wrong structure positions. Validate `bot.version` against configured seed-version on hook; log a loud warning if they diverge and disable the oracle for the session.

**Blockers / open questions.**
- (a) Emscripten build of cubiomes not yet verified. May need small C patches for WASM compat.
- (b) No runtime evidence yet of a JP-impact miss that the oracle would've caught — live scanners + #7c/#7d + #31 POI memory are already covering villages and player bases. Oracle is purely additive; risk is building it speculatively. Mitigation: wait for #30 Survivor to surface a concrete "goal queue needs stronghold coords" moment, then build.
- (c) Future MC-version drift: each new vanilla version may need a new cubiomes release + rebuild. Accept as maintenance overhead; pin version in profile config.

**Downstream ties.**
- **#31 POI memory** — on hook, oracle populates POI store with nearby structures so the bot "knows" about a stronghold at (x,z) before ever seeing the chunk. Opt-in.
- **#30 Survivor mode** — goal queue can target known stronghold/fortress/monument coords when tier-up requires them, instead of random exploration.

**First commit on this ticket:** survey pass — read #31's POI schema and #30's goal-queue shape (once it exists), then design the oracle module interface to slot in cleanly. Second commit: WASM build + node wrapper. Third commit: bot-side integration (profile config + hook wiring + redaction).

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
- **Auto-craft basic-need items** — torches when coal+stick available, sticks when oak_planks low, tools (best tier inventory supports). _(Surfaced 2026-04-14: bot's #5/#6 torch features silent-skipped because bot hadn't crafted any torches. **Torches shipped as #33 2026-04-20 (`22ed805`)** — awaiting live verification; sticks/tools follow-ups deferred.)_

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

### #3. Swamp biome traversal — closed as redundant (no code, 2026-04-20)

**Decision.** #3 closed without shipping new code. Research pass after #2 Layers 1–3 shipped confirmed the original "water + lily-pad + biome-aware profile" scope is already covered by existing primitives, or is elegance-only with no motivating incident.

**What was already in place:**
- **Water pockets** — `canSwim=true` (pathfinder default, carried through `createMovements`) + #2 Layer 1 drowning-escape reflex + #2 Layer 3 turtle-helmet auto-equip. Bot swims safely across shallow swamp water with 10s O₂ buffer and last-resort surface-and-jump.
- **lily_pad** — in `PLANT_LIKE_PATTERN` (eligible for `autoBreakStuckPlant`) and explicitly NOT in `MOVEMENT_BLOCKING_PLANTS` (treated as passable / walk-through, per the allowlist comment at `skills.js:~2354`). Walking "on top of" a lily_pad is a mineflayer-pathfinder library limitation (empty boundingBox), not a mindcraft-mcgavin gap — and with safe swim it's equivalent outcomes.
- **Swamp plants + hazards** — sweet_berry_bush, cactus, magma_block, lava, pointed_dripstone all in `_configureTerrainSafeMovements.blocksToAvoid`. Mangrove roots handled by `autoBreakStuckPlant` (`PLANT_LIKE_PATTERN`), allowed-to-break outside protected zones per the tree-part exclusion (mangrove intentionally NOT in `TREE_PART_PATTERN` — comment calls this out).
- **Plant-side ship (2026-04-14)** — `autoBreakStuckPlant` + terrain-safe movements + plant-vs-tree split + leaves-allowed-in-spawn rule.

**Why logged.** Second Principle-5 no-code close-out this session (first was #2 Layer 2). The original #3 scope was written before #2 Layers 1–3 and assumed "bot can't survive water pockets" as baseline — that baseline moved. Capturing the decision so future readers see why there's no swamp-specific code shipped for this ticket.

**Follow-up.** Two very-low-priority polish items parked as #3-follow-up in the to-do queue: strict lily-pad walk-on surface (upstream pathfinder change), biome-aware movement profiles (research-only). Neither has a motivating incident.

---


### #2 Layer 2. `swim(bot, targetPos)` skill — closed as redundant (no code, 2026-04-20)

**Decision.** Layer 2 of the original #2 spec — a dedicated `swim(bot, targetPos)` skill for the LLM — closed without shipping. Research pass during #2 Layer 3 work showed the capability is already covered by existing primitives: `goToPosition(x, y, z)` routes through `createMovements(bot)` which inherits pathfinder's default `canSwim = true`, and Layer 1's drowning-escape reflex (BT-10g shipped 2026-04-19) handles the oxygen-crisis edge case. A `swim()` wrapper would have been a rename of `goToPosition` with no new behavior.

**Why logged.** Principle 5 win — prevented a redundant skill surface area addition. The "just ship the spec" impulse was the wrong move; reading the existing pathfinder config and Layer 1 reflex before writing new code revealed the layer was already there. Captured here so future "why isn't there a dedicated swim skill?" questions have a pointer.

**Follow-up.** Water-breathing-potion auto-use parked as 2-follow-up in the to-do queue (low priority; turtle-helmet Layer 3 already covers the common case).

---


### #27. D1 migration close-out — `$MEMORY` pipeline torn down (`5663aa2`, 2026-04-20)

**Three-surface fix.** D1 (`7ee597e`, 2026-04-15) was a producer-side skip only — `storeMemories` no-ops the legacy 500-char summary under CB, but the consumer side and the persistence side still exercised the dead pipeline. This commit completes the perimeter (Rule 7) across all three surfaces, gated on `settings.use_context_builder` so the non-CB legacy path is preserved verbatim.

**Reframing credit.** Initial proposals were symptom-treatments (just clear on load, or just edit the profile). JP pushed back — "none of your suggestions feel like they are addressing the underlying root issue" — which forced a deeper Rule 2 audit and revealed a quiet **double-injection bug**: under CB, `_buildContextPrompt` injects episodic memory at priority 6 via the context builder, but `replaceStrings` (still called from `promptConvoFast` and the CB error fallback) was *also* hitting `getFormattedMemories` for the same `$MEMORY` token. Same content, two paths, no one had noticed because the legacy summary text was empty enough to look harmless. Principle 5 violation hiding a real bug.

**What shipped (3 files, 41 insertions / 22 deletions).**
- **`src/agent/history.js`** — load path now `this.memory = settings.use_context_builder ? '' : (data.memory || '');`. Next `save()` writes `memory: ''` to disk, wiping legacy residue across one restart cycle.
- **`src/models/prompter.js`** — `$MEMORY` branch now `if (settings.use_context_builder) { prompt = prompt.replaceAll('$MEMORY', ''); } else { ...legacy combined episodic+summary path... }`. Kills the double-inject under CB; non-CB legacy-profile users still get the full original behavior.
- **`ThatCoolGuyDude.json`** — `Summarized memory:'$MEMORY'` line stripped from `conversing` template. The short-circuit above is defense-in-depth for any legacy-shaped profile that still references the token; this is the primary fix so the token doesn't appear in CB prompts at all.

**Verification.**
- `node --check` passed on both modified .js files.
- `python3 -c 'import json; json.load(open("ThatCoolGuyDude.json"))'` — JSON valid; `$MEMORY` no longer present in `conversing`.
- Bot rebooted clean on HEAD `5663aa2` — StateTicker 1Hz, HP 20/20, food 15, no parse errors, zero exception lines in 30s of capture.
- **Primary success signal hit:** `bots/ThatCoolGuyDude/memory.json` `memory` field reads `''` post-restart. Disk is clean.

**Inline rationale.** Each of the three patch sites carries a comment block pointing back to D1 + this commit (`#27 (2026-04-20): Finish D1...`) so the next person (me, in 6 months) doesn't undo the gate without understanding why. The non-CB else-branch in prompter.js retains its `// #21 L1.4 context (pre-#27):` annotation explaining what the original combined path was for.

---


### #10. Bot survival hardening — close-out (WB-only, 2026-04-20)

**Pure WB cleanup; no code.** All six original #10 sub-items shipped across the BT-10 arc on 2026-04-19. This entry graduates #10 to Recently completed and records the mapping for future-me.

**Sub-item → ship map.**
- **Lava avoidance** → `BT-10a` (`3c31b78`) — ✅ Recently completed, live-verified 2026-04-20.
- **Mob retreat (HP<6)** → `BT-10b` (`e633301`) — ✅ Recently completed, live-verified 2026-04-20.
- **Ranged-attacker positioning** → `BT-10d` (`ddbf4c8`) close-distance reflex + `BT-10e` (`cd39540`) shield auto-raise — awaiting verif.
- **Pre-fight equip** → `BT-10i` (`30de1f4`) — awaiting verif.
- **Suffocation escape** → `BT-10c` (`4fb5a2e`) + follow-up fix `e1f47ac` debounce — awaiting verif.
- **Dimension safety** → `BT-10h` (`8956d33`) dimension-aware survival tuning — awaiting verif.

**Bonus items beyond the original #10 bullet list** (same arc, same motivation — every avoidable death is a respawn-loop):
- `BT-10f` (`0cd2d11`) creeper proximity evade — awaiting verif.
- `BT-10g` (`5324782`) drowning escape — ✅ Recently completed, live-verified 2026-04-20.
- `BT-10j` (`b0b874e`) pathfinder fall-damage prevention — ✅ Recently completed, live-verified 2026-04-20.

**Open loop.** Six BT-10 items still awaiting natural-event triggers for live verification (c/d/e/f/h/i). Each graduates individually as its signal fires; they do not gate #10's close-out — shipment is complete, and the survival-reflex surface in `self_preservation.update()` is now substantially more robust than pre-arc.

**Also included in this commit.** Dedup of the duplicate `BT-10c. Suffocation escape` entry in the Shipped-awaiting-verification section. The follow-up fix (`e1f47ac`, false-positive debounce + diagnostic log) is now folded into the main BT-10c entry as a leading subsection rather than a standalone duplicate header.

---


### #12. Movements safety audit close-out (`b4f0190`, 2026-04-20)

**Docs + lint sweep.** Rule 7 perimeter closure for pathfinder Movements is now machine-checkable. Graduated direct to Recently completed per CLAUDE.md ("Recently completed for pure refactors/docs/mechanical sweeps").

**What shipped.** Two files, 39 insertions:
- **`src/agent/library/skills.js`** — 4-line **Invariant** block added to `createMovements` JSDoc, naming the lint script and recording audit date: "no raw `new pf.Movements(bot)` anywhere in mindcraft-mcgavin outside this factory. Enforced by `scripts/check-movements-invariant.sh`. Audit #12 (2026-04-20) confirmed zero raw callsites in `src/`."
- **`scripts/check-movements-invariant.sh`** — new 35-line bash script. `grep -rn 'new pf\.Movements' src/`, filters out comment lines (leading `*` or `//`) and the single factory line, non-zero exits on violation with remediation hint.

**Stale-WB correction.** The pre-close-out to-do entry claimed ~20 raw callsites across `skills.js` and `world.js`. Current grep shows **zero** raw callsites outside the factory — all were migrated earlier (`93d7986` #12 Stage 2 routed `world.js:isClearPath` through the factory; BT-10j follow-ups consolidated the `skills.js` sites). The audit was functionally complete; only the invariant documentation + lint enforcement were missing. This close-out ships those.

**Verification.**
- `node --check src/agent/library/skills.js` passed post-patch.
- `bash scripts/check-movements-invariant.sh` → `OK: no raw 'new pf.Movements' callsites outside createMovements factory.` (first run caught the new JSDoc comment line as a false-positive; script filter was tightened to skip leading-`*`/`//` comment lines before ship.)
- No tmux restart needed — docs/tooling only, no runtime change.

**Follow-up captured.** `digCost` / `placeCost` tuning from the original #12 fix sketch moved to low-priority to-do item "12-follow-up. Movements cost tuning" so it isn't lost. Values from the original plan (`digCost=10`, `placeCost=2`, intent: discourage mining-through) preserved verbatim.

---


### #21. L1 cleanup bundle — 4 comment upgrades (`e49c75c`, 2026-04-20)

**Docs-only sweep.** Four comment upgrades across three files, zero behavior change. Graduated direct to Recently completed per CLAUDE.md ("Recently completed for pure refactors/docs/mechanical sweeps").

**What shipped.**
- **L1.1 `src/agent/modes.js:67`** — replaced `// hacky fix when blocks are not loaded` with a 4-line block explaining that treating missing blocks as `'air'` is the correct defensive fallback. `bot.blockAt()` returns null during spawn/teleport when chunks haven't loaded yet; 'air' short-circuits the sand/gravel fall-block detector to "no hazard," which is the safe default.
- **L1.2 `src/models/prompter.js:573`** — replaced bare `// deprecated` on `promptGoalSetting` with a 3-line block noting it is NOT deprecated — still called from `npc/controller.js:100` for the NPC goal-setting path. Retained for NPC use only; main agent loop does not hit this. Prevents future readers from deleting a live callsite.
- **L1.3 `src/agent/history.js:66`** — added a one-line pointer comment: `// #21 L1.3: use_context_builder default lives at settings.js:100 (true).` next to the `if (!settings.use_context_builder)` branch. Existing comment block above was already thorough about *why* the branch exists — this adds the missing *where the toggle lives*.
- **L1.4 `src/models/prompter.js:258`** — clarified `$MEMORY` branch gating: only runs when the prompt template literally contains `$MEMORY`; CB default profiles no longer include it post-D1 (2026-04-15), so this path is effectively dead for mcgavin defaults. Retained for non-CB / legacy-profile use.

**Verification.** `node --check` passed on all three modified files. No tmux restart needed — comment-only changes don't affect runtime.

**Rule 2 audit.** Every claim in the new comments was grep-verified: `blockAt` null-behavior (modes.js context), `promptGoalSetting` callers (`grep -rn promptGoalSetting src/` → npc/controller.js:100), `use_context_builder` default location (settings.js:100), `$MEMORY` template usage (absent from CB default profiles post-D1).

**Scope reminder.** This was part of the layered audit cleanup queue. The bundle name "L1" comes from the audit's risk-classification ladder — L1 = docs/comment-only, no runtime change. Future L2/L3 sweeps (if any) would be dead-code deletions and small refactors respectively.

---


### BT-10j. Pathfinder fall-damage prevention (`b0b874e`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — zero `source=fall` events in damage-stream across 22h post-ship window. Pathfinder honoring 3-block cap.**

**What shipped.** Six-line insertion (comment + one statement) in `createMovements()` at `src/agent/library/skills.js:2247`. Adds `m.maxDropDown = 3;` right after `_configureTerrainSafeMovements(bot, m);` and before the protected-zone guard.

**The finding.** `maxDropDown=3` was already applied in three spots:

- `installSafePathfinderDefaults` for `bot.collectBlock.movements` (line 1730) — covers the collect-block plugin path.
- Two local mining-movement instantiations (lines ~3618, ~3623) — cover the mining staircase paths.

But the general `createMovements()` factory — used by every other pathfinder caller in the codebase (defendSelf, attackEntity, goToNearestBlock, moveAway, and dozens more via direct invocation) — left `maxDropDown` at the pathfinder default of 4. That's 4 blocks of plan-time drop tolerance, which exceeds the vanilla Minecraft 3.5-block no-fall-damage threshold. Pathfinder could schedule a legal-to-it 4-block drop that produced ~1 HP of damage on landing.

**Why a factory-level fix.** Single perimeter (Rule 7): all callsites that go through `createMovements()` now inherit the cap in one place instead of each caller needing to remember to set it. The two explicit `=3` lines at 3618/3623 become redundant but were left intact as documentation — removing them would create silent coupling ("why is this safe? because the factory does it" is harder to audit than an explicit redundant assignment).

**Why preventive, not reactive.** The reactive version of BT-10j (velocity-based mid-fall reflex, water-bucket placement, slow-falling auto-drink) is much more invasive — needs new latches in `self_preservation`, new item-inventory checks, and a 20-tick-window classifier to distinguish pathfinder-intended drops from actual emergencies. Preventing the plan is cheaper and closes the common case; reactive handling can come later if live data shows damage-causing drops still happen (e.g. bot walked off a cliff during self-prompter exploration, not via pathfinder).

**Blast radius.**
- One factory function; every pathfinder-initiated movement via `createMovements()` gets the cap automatically.
- No changes to mutex, no new state on the bot, no new listeners, no skill-lifecycle changes.
- Existing callers that already explicitly set `maxDropDown = 3` are bit-identical after the change (factory default now matches their override).
- Callers that wanted a larger drop would need to override upward post-factory — grep of `src/agent/library/skills.js` shows zero callsites that currently do this, so the change is net-restrictive (safer) without breaking anything.

**Guardrails.**
- Factory-level cap is a floor for safety, not a ceiling — callers can still opt into larger drops by setting `m.maxDropDown = N` after `createMovements()` returns if a specific workflow needs it.
- Doesn't touch `scaffoldingBlocks` or `allow1by1towers` — pathfinder's scaffold-up / tower-down behaviors are unchanged (they're how the bot gets back out of legitimate drops).

**Out of scope.**
- Reactive mid-fall handling (velocity threshold, water-bucket place-at-feet, slow-falling potion auto-drink). Deferred; revisit if damage-stream shows fall hits that originated from non-pathfinder movement (e.g. parkour command, self-prompter wander).
- Cliff-edge observability (e.g. log a warning when `bot.entity.onGround === false` and velocity.y < -0.5 for N ticks). Pure-observation feature, not on critical path.
- Fall-damage attribution in damage-stream (already covered by existing classifier).

**Verification hooks.**
- `damage-stream.jsonl` already classifies fall-damage hits. If BT-10j works, pathfinder-driven fall-damage counts should go to zero. Non-pathfinder-driven (LLM walked off a cliff) would still show up — that's the next reactive delta if it becomes a real pattern.

---

### BT-10g. Drowning escape (`5324782`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — drowning damage dropped from 18 events on 4/18 to 2 events total across 4/19–20.**

**What shipped.** One self-contained state-maintenance block at the top of `self_preservation.update()` in `src/agent/modes.js`. Pair of clear + trigger sharing a single `if/else`. Zero new imports.

**Structure (single `if/else`, mirrors BT-10e shield shape):**
```js
if (bot._drowningEscapeActive) {
    // clear: !isInWater OR oxygen>=18 → drop jump+forward, reset latch
} else {
    // trigger: isInWater && oxygen<=10 → set jump+forward, set latch
}
```

**Why control-state not execute.** Vanilla Minecraft "jump while in water" = swim up. We just need to hold that key until the head breaks surface. `execute()` would be overkill (and would block the mode). Per-tick control-state toggling is the right primitive — same pattern BT-10a uses for lava escape.

**Trigger threshold (oxygen≤10).** Oxygen bar is 20 (10 bubbles). At 10 = half bar consumed = ~5s of air left. Gives ~5s buffer before damage starts at oxygen=0. Not tighter because pathfinder rerouting can eat a second or two; looser would be wasteful (swim-up on every shallow dip).

**Clear thresholds (¬ isInWater OR oxygen≥18).**
- **Primary clear: !isInWater.** Once the head breaks surface, `bot.entity.isInWater` returns false — clean exit.
- **Edge-case clear: oxygen≥18.** Covers Respiration III / Water Breathing potion / conduit power — if oxygen is regenerating for some other reason, no need to keep swimming up.

**Blast radius.**
- `self_preservation.update()` top-of-update only. No touch to else-if chain below, no new imports, no pathfinder interaction.
- Control-state conflict with pathfinder during the reflex: accepted (same policy as BT-10a lava escape) — drowning is survival-critical. Pathfinder resumes cleanly once latch clears.
- `bot.oxygenLevel` defensive guard: if undefined for any reason (version mismatch, chunk transient) we default to 20 so the reflex doesn't false-fire.
- `bot.entity.isInWater`: mineflayer built-in. Fast, authoritative.

**Guardrails.**
- Oxygen default 20 prevents false-fire on undefined.
- Try/catch around every setControlState — resilient against transient disconnects.
- Symmetric clear drops BOTH jump and forward — no sticky-control bugs.
- Latch prevents re-setting control states every tick once already set.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. `bot._drowningEscapeActive` joins the latch family. No fan-out.

**Skip (explicit).**
- Pathfinder-side surface-seek goal: requires column scanning + goal construction; out of scope for a reflex.
- Boat/raft construction as an escape path: goal-level behavior, not a reflex.
- Elder Guardian mining-fatigue coping: situational, would need deeper system changes.
- Respiration detection: naturally handled by the oxygen≥10 gate (high-Respiration bots rarely drop that low).

**Verification signals to watch.**
- **Trigger:** bot's head submerges and oxygen drops to ≤10 → `[Survival] drowning-escape oxygen=8` line; `Drowning — surfacing!` chat; bot swims upward.
- **Clear (surfaced):** head breaks water → `[Survival] drowning-escape cleared oxygen=X in_water=false`; jump+forward controls drop.
- **Clear (respiration):** oxygen regenerates to ≥18 while still underwater → same cleared log, in_water=true but oxygen high.
- **Non-trigger (shallow dip):** dive into water with full oxygen, surface before oxygen drops to 10 → branch does NOT fire.
- **Non-trigger (land):** bot on land → branch does NOT fire; no log.


### BT-10b. Proactive low-HP mob retreat (`e633301`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — chat history confirms exact say() text "Low HP — retreating from creeper!" firing on natural low-HP encounter.**

**What shipped.** Two new code paths inside `self_preservation.update()` in `src/agent/modes.js`. Zero new imports (`mc.isHostile`, `world.getNearestEntityWhere`, `skills.moveAwayFromEntity` already available).

**1. Latch-clear (top of update).** Runs before any other branch:
```js
if (bot._lowHpRetreatActive) {
    const h = world.getNearestEntityWhere(bot, e => mc.isHostile(e), 12);
    if (bot.health >= 14 || !h) {
        console.log(`[Survival] low-hp-retreat cleared hp=${bot.health.toFixed(1)}`);
        bot._lowHpRetreatActive = false;
    }
}
```

**2. Retreat trigger (after existing damage-based branch).** Fires when `bot.health < 6 && !bot._lowHpRetreatActive` AND a hostile is within 12 blocks. Sets the latch, logs `[Survival] low-hp-retreat hp=X hostile=<type> dist=Y`, says a retreat line in-chat, then `execute()` → `skills.moveAwayFromEntity(bot, target, 16)`.

**Hysteresis design.**
- **Set** at HP<6 (3 hearts) to catch pre-damage chase scenarios.
- **Clear** at HP≥14 (7 hearts) OR no hostile in 12-block radius. Two-sided clear prevents oscillation: if we retreat and regen finishes the job, we exit cleanly; if hostiles give up the chase and wander off, we also exit even if HP hasn't fully regenerated.
- Latch lives on the bot (`bot._lowHpRetreatActive`) and is owned solely by this mode.

**Attribution.** `world.getNearestEntityWhere(bot, e => mc.isHostile(e), 12)` gives the closest hostile. `mc.isHostile` excludes iron_golem / snow_golem (allied). `skills.moveAwayFromEntity` computes the vector and hands it to pathfinder — so the bot retreats in a direction AWAY FROM the mob, not a random `moveAway` direction.

**Blast radius.**
- `self_preservation.update()` only. No touch to `self_defense`, combat skills, pathfinder, or any other mode.
- `interrupts:['all']` already set on the mode; high-HP combat yields to the retreat path automatically when HP crosses the threshold.
- Existing damage-based branch (`lastDamageTime < 3000 && health < 5`) preserved verbatim — it still fires under its original narrow conditions, and this new branch covers the pre-damage-chase and damage-cooldown-elapsed gaps.

**Guardrails.**
- Latch-gated: only one `execute()` retreat fires per episode.
- Hostile captured at trigger tick (target-of-retreat frozen) — no mid-flight re-target.
- `moveAwayFromEntity` catches its own errors; latch stays set so the top-of-update clear handles exit.
- Try/catch around `world.getNearestEntityWhere` in both paths — world lookups are resilient to chunk-unload transients.

**Rule 7 audit.** Single perimeter: `self_preservation.update()`. No new module, no new export, no cross-file state. Two new branches added to one function that already owns all related state (`lastDamageTime`, `lastDamageTaken`, `_lavaEscapeActive`, `_lavaEdgeBackoffActive` — now `_lowHpRetreatActive` joins that list).

**Skip (explicit).**
- Finding cover / hiding in a structure (long-term #10 safe-pathing sub-item; needs memory + heuristics).
- Eating food mid-retreat (auto-eat already shipped separately).
- Ranged-attacker special case (strafe + shield + close-distance vs arrows) — that's BT-10c candidate.

**Verification signals to watch.**
- **Trigger:** bot at HP<6 with a zombie within 12 blocks → `[Survival] low-hp-retreat hp=4.0 hostile=zombie dist=7.2` line appears; bot says "Low HP — retreating from zombie!"; pathfinder sets goal 16 blocks away from zombie.
- **Hysteresis clear:** after retreating and regenerating to HP≥14 → `[Survival] low-hp-retreat cleared hp=14.0`; latch cleared; bot resumes normal work.
- **Wander-off clear:** hostile gives up and walks away (12-block check fails) → same cleared log fires even if HP is still below 14.
- **Non-trigger:** HP drops below 6 while mining alone (no hostiles) → branch does NOT fire. No log, no retreat.
- **Existing branch preserved:** bot takes a heavy hit at HP<5 → original `I'm dying!` line + `moveAway(20)` still fires (different log line, different code path).


### BT-10a. Lava avoidance reflex (`3c31b78`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — zero lava damage 4/19–20 (vs. 1 event 4/18). Compounds with OPT-J pathfinder hazards.**

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


### 29. `autoBreakStuckPlant` vertical-scan extension — dy=-1 and dy=2 added (`a6a3e9b`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — 5,212 invocations total, 1,015 today alone, all clean. Vertical-scan extension firing on stuck plants without errors.**

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


### 22b. `escapeProtectedZone` current-position suffocation — NaN-position recovery (`d921016`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — 231 NaN-position records today, all recovered. Bot survived; zero NaN-pos-related lethal events.**

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


### 28. Mid-session in-zone re-fire on `forcedMove` (`f3bee88`, 2026-04-19) — fix `b57a097`

**Follow-up fix (`b57a097`, 2026-04-19):** combat preemption guard.

- **Observed bug (UTC 2026-04-20T01:17:03 = CDT 20:17).** Bot self-prompting for diamond armor near spawn. Burning zombie closed to 2.5 blocks, hit bot once (1.68 HP, zombie source). defendSelf swung `bot.pvp.attack` once — then combat stopped. 12 seconds of fire-tick damage (HP 20 → 2.17) while pathfinder walked the bot to x=224 (35 blocks past the zone). Zombie burned to death before catching up. JP's report: "hit it once and then did not hit it again."
- **Evidence.** state-stream mutex.holder flipped from `None` (01:17:03) to `escapeProtectedZone` by 01:17:30, pathfinder target (224, 22, -53). 26-second `bot.entity=null` state-stream blackout during the combat-escape transition window (damage-stream kept firing with `pos:null`). After escape completed (01:18:04) bot returned to origin with HP=2.17.
- **Root cause.** `skills.js` `forcedMove` handler (#28 original ship) re-fires `_impl_escapeProtectedZone` after 500ms debounce when the bot lands in the protected zone. Zombie knockback fires `forcedMove`. Existing guards bail on NaN pos, death, outside-zone, already-escape-holder, 30s cooldown — but had no combat guard. So: knockback → forcedMove → in-zone → re-fire → `withBotLock('escapeProtectedZone')` takes mutex → defendSelf preempted via `interrupts:['all']`.
- **Fix.** Two new bail conditions in the deferred callback, next to the escape-holder check:
  - `holder === 'defendSelf'` — active combat, don't preempt.
  - `bot.pvp?.target` truthy — pvp engagement live between attack cycles (mutex may briefly release during the `setTimeout` await).
- **Rationale.** Spawn protection exists to stop *destructive* actions and stranding; defensive combat against a hostile that's actively attacking is neither. Combat wins the tiebreak; the zone is still there after the fight, and any post-combat NaN / low-HP state will route through self_preservation.
- **Blast radius.** The 500ms deferred callback only. No changes to `_impl_defendSelf`, no changes to escape paths, no new state. Rule 7: single perimeter — all re-fire bail conditions live in this one callback.
- **Skip.** Pausing escapeProtectedZone from within defendSelf (like defendSelf does for self_defense + cowardice): considered but more invasive and couples two unrelated modules. The re-fire handler is the right place — it owns the "should I preempt?" decision.

---

### 28. Mid-session in-zone re-fire on `forcedMove` (`f3bee88`, 2026-04-19)

**Status:** ✅ completed — **Live verified 2026-04-20 — 9 invocations today, 2 successes (00:55, 01:00 UTC) on natural mid-session triggers.**

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

**Status:** ✅ completed — **Live verified 2026-04-20 — 40 escapeProtectedZone invocations total since ship; 0 suffocation deaths in window. Pre-move passability guard holding.**

**Change.** Two helpers (`_isTargetPassable`, `_findPassableY`) + a guard block at the top of `_escapeTryPath` in `src/agent/library/skills.js`. Before committing `GoalNear`, check feet+head blocks at the target; if both known-solid, try Y offsets `[0, -1, +1, -2, +2, -3, +3]`. If nothing passable in ±3, log `[EscapeZone] <label>: target ... rejected` and return so the caller's stuck/next-direction logic fires. Unknown (unloaded-chunk) blocks return `null` and defer to pathfinder — we only reject KNOWN-solid targets, preserving all currently-working paths.

**Rule 7 perimeter.** One guard, four callers: cached-exit (`_impl_escapeSpawnZone`), dir-hop (`_commitToDirection`), stuck-back + stuck-sidestep (`_executeStuckManeuver`). `grep -nE '_escapeTryPath' src/agent/library/skills.js` → 4 callers, all covered.

**Evidence that motivated the fix.** 5 lethal unknown-source 2-dmg/tick suffocation sequences on 2026-04-19 between 15:35:49–15:44:58Z. At 15:44:57–58Z: `held:true reason:chunk_wait` → next tick `mutex.holder:"escapeProtectedZone"` heading `(-34.5, 91, -35.5)` → `(-7, 91, -64)`. Y=91 hop through uneven terrain deposited the hitbox inside solid material.

**Verification signal to watch.** After next natural escape event: `[EscapeZone]` log lines in tmux, zero `source:"unknown"` lethal sequences in `data/damage-stream.jsonl`. Guard currently idle because bot spawned outside the protected zone.


Feature-level entries that have landed on `develop` but haven't yet been observed working in live play. Graduate to **Recently completed** once the "how we verify" checklist is ticked. Pure refactors, docs, and mechanical sweeps skip this section and go straight to Recently completed — this bucket is specifically for behaviors that need world-side confirmation.


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
