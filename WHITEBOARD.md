# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-17 (BT-7 Skill lifecycle + Goal lifecycle from BT-bundle moved to In-progress — shipping as a pair per agreed logging-roadmap ordering; uniform `[Skill]` + `[Goal]` lines at top of call graph)_

---

## Current state (live on develop)

**Deployment:**
- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft-mcgavin`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b` via LM Studio. Bot is **running** — StateTicker (BT-1), BootSnapshot (BT-8), LLM call telemetry (BT-3), DamageStream (BT-2), startup-window ordering fix (BT-12), MemoryRecall (BT-4), and AutoRecovery stats (BT-5) all verified live 2026-04-17.
- Branch: `develop` — HEAD `8897324`. Seven observability items shipped and verified live today: BT-1 StateTicker, BT-8 BootSnapshot, BT-3 LLM call telemetry (+ BT-3b filed for remaining 19 adapters), BT-2 DamageStream, BT-12 startup-window ordering fix, BT-4 MemoryRecall, and BT-5 AutoRecovery stats. Pushed to `origin/develop` 2026-04-17. **BT-7 Skill lifecycle + Goal lifecycle (from BT-bundle) are in-progress per agreed logging-roadmap ordering — shipping together as the lifecycle layer underneath BT-5's measurement layer.**
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

**Protected zones (#7 shipped today):**
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

**Observability (7 modules live — BT-1, BT-2, BT-3, BT-4, BT-5, BT-8, BT-12):**
- `src/observability/` module tree introduced; `data/*-stream.jsonl` is the output convention BT-2..BT-11 inherit.
- **StateTicker** (BT-1): 1 Hz structured pulse — `[StateTicker] {json}` log line + append to `data/state-stream.jsonl`. Fields: `pos, vel, health, food, dimension, goal, goal_queue, pathfinder, mutex, inventory{count,top:3}, nearby_entities, nearby_threats, last_command, context_tokens`. NaN-position / ChunkWait-held windows emit `{t, held:true, reason}` instead of throwing. Tick + file-write errors throttled at 1/10s. Survives soft reconnects; idempotent `start()`.
- **BootSnapshot** (BT-8): one `[Boot]` structured log line per agent init + `data/boot-snapshot.json` (overwritten per boot) with full resolved settings, model refs, runtime versions, MC target, settings hash, and feature flags. Runs before `bot` exists (zero mutation risk) and before name validation so the snapshot lands even on failed starts.
- **withLLMMetrics** (BT-3): one `[LLM]` structured log line per LM Studio round-trip (chat + embed). Fields: `label, model, elapsed_ms, prompt_tok, completion_tok, total_tok, tok_per_s, retries, finish, cache_hit, status`. Terminal errors emit `status=error err_class=...`. Only `lmstudio.js` migrates today — remaining 19 adapters tracked as BT-3b.
- **DamageStream** (BT-2): one `[Damage]` log line + JSONL record per health-decrease event. Source inferred via priority classifier (nearest hostile mob → contact block → drowning oxygen → fall velocity → unknown). On death, attaches inferred source to long-term memory so the bot starts next session knowing what killed it.
- **MemoryRecall** (BT-4): one `[MemoryRecall]` structured log line per memory retrieval (episodic + long-term + confidence/procedural) + append to `data/recall-stream.jsonl`. Fields: `subsystem, query, k, returned, backend, top_score, top_text` plus subsystem-specific extras (`category_top` for LTM; `tier, threshold_high, threshold_med, context_hash, record_count, trigger` for confidence). Backend values: `vectra`, `word-overlap`, `map`, `none`. Procedural lookups collapsed into confidence per Principle 5 (single caller — no duplicate log).
- **Startup-window visibility (BT-12):** `startEvents()` + `StateTicker.start()` now run BEFORE `await skills.escapeProtectedZone(this.bot)` in the spawn handler, so damage / state / path decisions during the 45-60s zone-escape window are captured. `_setupEventHandlers` stays after escape so chat/whisper + init-message processing remains gated.
- All seven observability modules audited for Rule 7: grep for `bot.(dig|placeBlock|chat|toss|setControlState|attack|equip|unequip|activateItem)|pathfinder.goto` returns zero matches across `state_ticker.js`, `boot_snapshot.js`, `damage_stream.js`, `recall_log.js`, `auto_recovery_stats.js`, and `retry.js`. (BT-12 is an ordering fix in `agent.js`, no new module.)

**Open behaviors / active monitoring:**
- Bot respawned after goal cycle and is now self-prompting toward `mine 64 ancient debris` (resumed from saved memory). Position ~(-310, 62, -28) after spawn-zone escape; diamond/coal/stick stack still in inventory. Live [LLM] and [StateTicker] telemetry confirms the full observability layer is active during this run.
- No known crashes, no silent failures, all error paths log with structured prefixes.
- Known issues section on the whiteboard is **empty** (self_preservation mutex stale entry audited out; memory compression closed by D1; Cannot-smelt closed by handler; mob-combat-ranged folded into #10 Layer 2).

---

## In-progress

### BT-7. Skill lifecycle standardization

**Status:** 🟡 in-progress 2026-04-17 • **Priority:** medium-high • **Ships paired with:** Goal lifecycle (below)

Lifts the "what skill just ran, with what args, for how long, and did it work" question out of grep archaeology. BT-5 is the measurement layer; BT-7 is the lifecycle layer that produces what BT-5 measures against.

**Plan (agreed with JP 2026-04-17):**
- New `src/observability/skill_lifecycle.js` exports `wrapSkill(name, fn, argSelector?)`.
- Emit format: `[Skill] name=<name> args=<json> ms=<int> outcome=<success|error|abort> notes=<optional>` + append to `data/skill-stream.jsonl`.
- Outcome taxonomy: `success` (returns truthy/undefined), `error` (throws — includes `err_class`), `abort` (returns `false` — mineflayer "I couldn't" convention).
- Per-skill `argSelector` allowlist so we stringify `{itemName, num}` not `bot`/entity/metadata objects (~80-char cap).
- Apply to 10 hottest: `collectBlocks`, `searchForBlock`, `goToNearestBlock`, `pickupNearbyItems`, `smeltItem`, `craftRecipe`, `digDown`, `digUp`, `placeBlock`, `safeToss` (+ `safeTossBatch` since batch is the live disposal path).
- BT-7b will be filed post-ship for remaining 72 skills (Principle 5 — finish migrations).

**Files.** New `src/observability/skill_lifecycle.js`; targeted `export async function X = wrapSkill(...)` shim at the top of each of the 11 wrapped functions in `src/agent/library/skills.js`.

**Blast radius.** Additive wrapper. No destructive ops added inside `skill_lifecycle.js` (Rule 7 self-check: grep for `bot.(dig|placeBlock|chat|toss|setControlState|attack)` in the new module returns zero). Existing `[Skills]` ad-hoc logs inside wrapped functions stay for now — Principle 5 cleanup in a follow-up once uniform `[Skill]` lines are live.

**Success signal.**
- `[Skill]` fires on at least one of the 11 wrapped skills within the first minute of live play after restart.
- `outcome` is correctly classified on success + error + abort paths (at least one of each captured in `data/skill-stream.jsonl`).
- No `node --check` regressions on touched files.
- State ticker's `last_command` field unaffected.

### Goal lifecycle (lifted from BT-bundle)

**Status:** 🟡 in-progress 2026-04-17 • **Priority:** medium • **Ships paired with:** BT-7 above

Retires ad-hoc `[GoalQueue]` logs (and the no-log paths in `start()` / `setPromptPaused()` / `stop()`) in favor of a unified `[Goal]` prefix with event semantics and duration.

**Plan:**
- `src/agent/self_prompter.js`:
  - `start(prompt)` → `[Goal] event=set prompt="..." source=<fresh|resume>` (+ capture `this.goalStartedAt = Date.now()`).
  - `setPromptPaused(prompt)` → `[Goal] event=set_paused prompt="..."`.
  - `addGoal(goalText)` → `[Goal] event=queued prompt="..." queue_depth=N` (replaces existing `[GoalQueue] Added goal:` line).
  - `advanceGoal()` → `[Goal] event=advanced from="..." to="..." queue_depth=N` (replaces existing `[GoalQueue] Advancing to next goal:` line; resets `goalStartedAt`).
  - `stop()` loop-exit → `[Goal] event=stopped reason=<auto|manual|interrupt> prompt="..." duration_ms=<elapsed>`.
- `src/agent/commands/actions.js` `!endGoal.perform` → `[Goal] event=completed prompt="..." duration_ms=<elapsed>` before `advanceGoal()`.
- `this.goalStartedAt` is in-process only — no memory.json serialization change.

**Blast radius.** Six logging touch points, all in `self_prompter.js` + `actions.js`. No existing callers read the `[GoalQueue]` prefix. StateTicker's `goal` field reads `self_prompter.prompt` — unaffected. Persistence (`self_prompt` / `self_prompting_state` in memory.json) unaffected.

**Success signal.**
- `[Goal] event=set` fires on `!goal` chat command and on restart-resume.
- `[Goal] event=queued` fires on `!addGoal`.
- `[Goal] event=completed duration_ms=<int>` fires on `!endGoal`, with duration plausibly matching wall-clock time since goal-set.
- `grep '\[GoalQueue\]' src/` returns zero matches (prefix retired cleanly).

## Shipped — awaiting live verification

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

### 22. `escapeProtectedZone` suffocation trap

**Status:** ⏳ not started • **Priority:** high (direct death cause — 2026-04-17 forensic incident)

**Problem.** On 2026-04-17 at ~16:40:44Z, `escapeProtectedZone` recovery pathed the bot into a non-air block and the bot suffocated out over ~60 s. `data/damage-stream.jsonl` shows the signature clearly: repeated 1.18 damage/tick from `source=unknown`, `position=null`, `food=17` (not starvation), culminating in a lethal event at 16:41:45.040Z. StateTicker's last good position (16:40:44.075Z) has pathfinder active and `mutex=autoRecovery:inside_protected_zone` — one tick later, NaN position + ChunkWait hold. The escape goal itself succeeded in the "bot is no longer in the protected zone" sense, but the chosen step landed the bot's hitbox inside terrain.

**Root cause.** `escapeProtectedZone` picks directional hops to walk the bot away from the zone center but does not validate that the target block at feet/head level is air before committing the pathfinder goal. No pre-move collision check. Bot happily steps into a block, its head is in solid material, suffocation fires every tick, and because the damage source is "inside a block" there's no hostile for `self_defense` to flee from.

**Solution sketch.** In `escapeProtectedZone` (and the helper that picks the directional hop), before calling `pathfinder.setGoal` on the candidate target, read the two blocks at `(x, y, z)` and `(x, y+1, z)` via `bot.blockAt(...)`. If either is non-passable, reject the candidate and try the next direction. Secondary guard: if `self_preservation`'s head-in-block detector (#10 suffocation-escape, currently in the Partial bucket) ships first, it would also save us here — these two fixes are redundant in a good way.

**Files.**
- `src/agent/library/skills.js` — `escapeProtectedZone` and its phase-2 directional-hop helper.
- Possibly `self_preservation.js` if we take the secondary-guard route.

**Blast radius.** Localized to `escapeProtectedZone` and its call site in the spawn-event hook / AutoRecovery `inside_protected_zone` handler. Additive collision check; no change to existing success paths.

**Success signal.** A replay of the 2026-04-17 scenario (bot entering the same chunk from the same approach angle) either (a) picks a different direction or (b) skips the unsafe step, and the bot does not take suffocation damage during escape. Look for a new `[SkillGuard]` / `[EscapeZone]` log line showing the rejected-candidate reason.

**Philosophy alignment.** Rule 7 (complete the perimeter — every pathfinder commit point needs the same safety invariant). Principle 1 (mechanical decision; don't ask the LLM to notice it's suffocating).

### 23. Self-prompter ignores held state during ChunkWait/NaN windows

**Status:** ⏳ not started • **Priority:** high (goal-loss + wasted LLM calls + spurious auto-stop)

**Problem.** On 2026-04-17, during the 60 s ChunkWait hold triggered by the suffocation incident, `SelfPrompter.startLoop` (src/agent/self_prompter.js:141+) kept inviting LLM responses. The bot was dying, position was NaN, state-stream was emitting `{held: true, reason}` stubs, but the prompt loop neither noticed nor backed off. It cycled `handleMessage` 3+ times, got 3 consecutive no-command responses, hit the auto-stop at line 187 (`Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`), set `state = STOPPED`, and sent "Stopping auto-prompting" to chat. The next `history.save()` serialized `self_prompt: null`, `self_prompting_state: 0`. On next restart, the bot loaded null — the "mine 64 ancient debris" goal was gone. This is not a persistence bug (persistence worked exactly as designed — the goal was already STOPPED at save-time); it's an upstream loop-awareness bug that made persistence serialize an incorrect terminal state.

**Root cause.** `startLoop`'s guard is `while (!this.interrupt)` — it has no signal for "the world is frozen, don't waste an LLM round-trip." It doesn't consult `chunk_wait.isHeld()` / StateTicker's held flag / any equivalent. Every 2 s (base cooldown) it fires another `handleMessage`, and when the LLM keeps returning empty (because there's nothing actionable to say during a chunk hold), the no-command counter ticks toward the auto-stop.

**Solution sketch.** Before the `handleMessage` call inside the loop, check whether the bot is in a held state. Rough shape:

```js
// at top of while-loop body, before the self-prompt message build
if (this.agent?.chunk_wait?.isHeld?.() || !isPositionValid(this.agent?.bot?.entity?.position)) {
    // wait a tick, don't invite the LLM, don't increment no_command_count
    await new Promise(r => setTimeout(r, 1000));
    continue;
}
```

The `continue` is the key behavior change — held ticks are no-ops, not LLM-round-trips and not auto-stop fuel. `no_command_count` does not advance while held.

**Files.**
- `src/agent/self_prompter.js` — add held check at top of `startLoop`'s while-body; expose a small helper if `chunk_wait` doesn't already have `isHeld()`.
- Verify against `src/agent/chunk_wait.js` (need to read it — see Rule 2) to confirm the right predicate.

**Blast radius.** Local to `self_prompter.js`'s main loop. Does not touch `handleMessage`, the stop path, or persistence. Additive guard — existing behavior preserved in the non-held case.

**Success signal.** Replay scenario: trigger a ChunkWait hold (NaN position) with self-prompting active. `self_prompter` does not emit `handleMessage` calls during the hold, `no_command_count` does not advance, `state` stays `ACTIVE`, and once the hold clears the loop resumes normally. Memory.json save during a hold still reflects the active goal.

**Philosophy alignment.** Principle 1 (don't ask the LLM for decisions when the world isn't in a decidable state). Principle 8 (instrumentation we just shipped — StateTicker's held flag — should drive control flow, not just logs).

### 24. Self-prompter doesn't interrupt stuck loops for player chat

**Status:** ⏳ not started • **Priority:** high (observed live 2026-04-17; player chat effectively invisible to a stuck bot)

**Problem.** Observed live 2026-04-17 ~19:00Z. The bot was deep in a repeating `!digDown(10)` → "dangerous drop ahead, 0 blocks dug" loop against an unreachable cavern. JP sent two chat messages via `Bones_McGavin`:

1. "Set a goal to mine 64 ancient debris" — processed (goal set via `!goal`, bot then pattern-completed into the dig-loop).
2. "add a new rule, if any part of your diamond armor breaks, make a replacement corresponding diamond armor and equip it" — RECEIVED (seen in tmux: `ThatCoolGuyDude received message from Bones_McGavin : ...`) but NEVER acted on. Zero `[PersistentRule]` logs in 5000+ lines of tmux; zero `!addRule` in the rotated history file; `memory.json persistent_rules: []` after the save that covered this window.

The LLM's next response after the rule chat stayed in the dig-down pattern. The chat joined the conversation turns but did not break the loop. From the player's perspective, the message was ignored.

**Root cause.** Two contributing patterns:

1. `SelfPrompter.startLoop` treats player-chat drainage as secondary — the `_playerMsgQueue` drain runs AFTER the LLM has already generated a response to its own self-prompt (`self_prompter.js:168-177`). So if a player message arrives mid-generation, it's drained as a new `handleMessage` call but the LLM that just responded has no visibility into what the player said relative to what it was already doing. No mechanism to interrupt or reset the pattern.
2. When the LLM has been issuing `!digDown` repeatedly and a new chat arrives, nothing in the prompt says "a player just interrupted you — reconsider." The self-prompt message at `self_prompter.js:159` is still `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command...`. Pattern-matching continues.

**Solution sketch.**

- **Interrupt-on-chat:** when a `Bones_McGavin`/player-authored message arrives, call `self_prompter.stopLoop()` (or a softer version that doesn't set `state=STOPPED`) so the current self-prompt cycle exits cleanly, then route the player message through `handleMessage` outside the loop, then resume. This preserves the goal but gives the player message undivided attention.
- **Chat-aware prompt prefix:** if `_playerMsgQueue` had messages drained during the last turn, prepend the prompt with `A player just said: "<message>". Address it before continuing.` so the LLM can't pattern-complete past it.
- **Stuck-loop detection:** secondary — if the last N commands were identical (same name + args), the self-prompt should say `You have repeated !digDown(10) 4 times with no progress. Try a different approach.` Extends BT-5's measurement instinct.

Option 1 is the surgical fix; 2 is the defense-in-depth; 3 is the root cause of the dig-loop itself and probably belongs with #10 survival hardening.

**Files.**
- `src/agent/self_prompter.js` — interrupt + prompt-prefix logic.
- `src/agent/agent.js` — `handleMessage` may need to signal "this was a player, not a self-prompt" to the prompter.

**Blast radius.** Changes control flow inside the loop. Medium risk — must verify interrupts don't cascade into the auto-stop counter or goal-loss path from #23. Ship #23 first.

**Success signal.** Replay scenario: put the bot in a repeating failing command (`!digDown` against unreachable cavern), send a chat message, the bot's very next response addresses the chat — not another `!digDown`. Confirm via the rotated history file that `!addRule` / `!goal` / whatever the chat demanded actually appears.

**Philosophy alignment.** Principle 1 (the player is the human-in-the-loop; never let the LLM's self-prompting drown them out). Rule 7 (complete the perimeter — every loop that talks to the LLM needs a chat-interrupt path, not just the top-level handler).

### 25. `!addRule` has no armor/durability pattern

**Status:** ⏳ not started • **Priority:** medium (would unlock the class of rules JP actually requested 2026-04-17)

**Problem.** `!addRule` at `src/agent/commands/actions.js:419` uses hardcoded description-matching to pick a `conditionFn` and `action`. Current cases (2026-04-17): diamond ore, iron ore, inventory full / clean inventory, low health / heal, generic "ore + collect", plus a default for ore/coal/gold/inventory-full/low-health actions. **No armor or durability trigger.**

JP's 2026-04-17 chat "add a new rule, if any part of your diamond armor breaks, make a replacement corresponding diamond armor and equip it" describes exactly this class. Even if the LLM had responded with `!addRule(...)`, the description would fall through to `conditionFn = () => true` (fires every tick forever) and `action = '!searchForBlock("diamond_ore", 64)'` — completely wrong. Rule would spam and never do the right thing.

**Root cause.** The pattern dictionary in `!addRule.perform` was seeded from early-development examples (ore / inventory / health) and hasn't kept up with the equipment-management category. Equipment durability isn't a first-class concept in the current rules dispatch.

**Solution sketch.** Add a case:

```js
} else if (descLower.includes('armor') || descLower.includes('armour') || descLower.includes('broken') || descLower.includes('durability')) {
    conditionFn = (agent) => {
        try {
            const slots = agent.bot.inventory.slots;
            // equipment slots in mineflayer: 5 (helmet), 6 (chest), 7 (leggings), 8 (boots)
            for (const slotIdx of [5, 6, 7, 8]) {
                const item = slots[slotIdx];
                if (!item) continue;
                const maxDur = item.maxDurability || 0;
                const dur = maxDur - (item.durabilityUsed || 0);
                if (maxDur > 0 && dur / maxDur < 0.2) return true; // <20% durability
            }
            return false;
        } catch { return false; }
    };
    // action: auto-craft and equip best-tier replacement
    action = '!craftRecipe("diamond_chestplate", 1)'; // default — see note
}
```

Note: the action for this rule is harder than the condition. "Make a replacement corresponding diamond armor and equip it" requires figuring out WHICH slot is broken, checking whether a replacement of the matching tier exists in inventory, crafting it if not, then equipping. That's multi-step and probably needs a new `!replaceBrokenArmor` skill or a chain of commands. For the minimum viable rule, action `!equipBestArmor` (if that exists) or `!craftRecipe("diamond_chestplate", 1)` as a placeholder until a real replacement skill exists.

Broader question surfaced by this: `!addRule`'s one-line-action model is too narrow for "detect X, do multi-step Y." Either (a) allow compound actions (array of commands), (b) allow rule action to be a skill-function name rather than a command string, or (c) accept this limitation and scope rules to single-command responses only.

**Files.**
- `src/agent/commands/actions.js` — new case in `!addRule.perform`.
- Possibly `src/agent/library/skills.js` — new `replaceBrokenArmor(bot)` skill if we go the multi-step route.

**Blast radius.** Additive case in the if/else chain. Low risk unless we expand the action model (which would touch everywhere rules are fired).

**Success signal.** JP's original chat — "add a new rule, if any part of your diamond armor breaks..." — results in a registered rule with a condition that correctly fires when any equipped armor piece drops below 20% durability, and an action that's at least plausibly corrective.

**Philosophy alignment.** Principle 1 (durability is a mechanical signal — don't ask the LLM to notice). Rule 9 (minimum code — start with one case in the chain; don't redesign the whole rules API until there's a second real use case).

### BT-3b. LLM telemetry — migrate remaining 19 model adapters through withLLMMetrics

**Status:** ⏳ not started • **Priority:** low (no user-facing impact today; touches dormant code paths)

**Scope.** BT-3 shipped `withLLMMetrics` and migrated `src/models/lmstudio.js`. The other 19 adapters (`azure, cerebras, claude, deepseek, gemini, glhf, gpt, grok, groq, huggingface, hyperbolic, mercury, mistral, novita, ollama, openrouter, qwen, replicate, vllm`) retain their original per-adapter error handling and do NOT emit `[LLM]` lines. This entry tracks the remaining sweep so Principle 5 (Finish migrations, kill redundancy) is explicitly satisfied when a new provider becomes active.

**Why deferred.** Each adapter has a distinct response shape (`Anthropic` uses `resp.content.find(...)`, `gpt.js` branches between `responses` and `chat.completions`, `ollama` streams, etc.). Migrating all 19 without real credentials to test each risks shipping broken error paths to code JP does not exercise. The honest state is: we have not done this yet, and we know it.

**Trigger.** Ship BT-3b when any of the following is true:
- JP configures a second active provider in a profile (`chat_model`, `fast_model`, `code_model`, `vision_model`, or `embedding` referencing a non-lmstudio adapter).
- A credible credential set becomes available for at least one other adapter, enabling live verification.
- A reader of this whiteboard decides the dormant-code migration is worth the risk regardless.

**Implementation sketch (per adapter).**
1. `import { withLLMMetrics } from '../utils/retry.js';`
2. Identify the single API-call site inside `sendRequest` (and `embed` if present).
3. Wrap it in `withLLMMetrics({ label: 'AdapterName', model }, () => ...)`.
4. For non-OpenAI-shaped responses, write an `extractUsage` callback that maps the adapter's `usage` block into `{prompt_tokens, completion_tokens, total_tokens, finish_reason, cache_hit}`.
5. Remove now-redundant per-adapter retry logic if present, or leave it in if it carries adapter-specific policy.
6. Manual smoke test against the adapter's API.

**Blast radius (per adapter).** Localized to that one file. `withLLMMetrics` is already shipped and proven by lmstudio.

**Effort.** Small-per-adapter (~15 min each) × 19 = ~4 hours once credentials exist.

### BT-6. Pathfinder telemetry

**Status:** ⏳ not started • **Priority:** medium-high (biggest "bot got stuck" debugging surface)

**Problem.** Grep of pathfinder-related logs returns **3 lines total**, all fallback paths in `skills.js`: `[CreateMovements]` (:1852), digDown fallback (:4122), digUp fallback (:4356). Normal pathfinder operation — goal set, route computed, replans, mid-path obstacles, target reached, timeouts — emits nothing.

**Proposed solution.** Hook into `mineflayer-pathfinder` events: `goal_reached`, `path_update`, `path_reset`, `goal_updated`, `no_path`. One `[Path]` log line per event with goal target, path length, replan count, cost. Plus a session counter (`paths_started`, `paths_completed`, `paths_timed_out`, `replans_total`) consumable by state ticker.

**Implementation plan.** Single listener registration in `init_agent.js` after bot spawn, module at `src/observability/path_telemetry.js`. Purely additive; zero mutation.

**Blast radius.** Additive only.

**Effort.** Small — ~70 lines.

**Deferred.** Path visualization (top-down 2D) — separate work, consumes this stream.

### BT-9. World/time event emission to log

**Status:** ⏳ not started • **Priority:** medium (already tracked internally — just needs to surface)

**Problem.** `full_state.js` already reads weather, `timeOfDay`, dimension (`:47-51, :117`). `event_pipeline.js:96` handles weather change, but the only sink is `agent.history.episodic.addEvent` (text for episodic memory). Nothing goes to console log. A log tailer sees no weather transitions, no dawn/dusk, no dimension changes.

**Proposed solution.** EventPipeline weather/respawn/dimension handlers already fire — add a `console.log('[World] ...')` alongside the episodic write. Time-of-day transitions (dawn/dusk) need a polled check — do it in state ticker (BT-1) or a dedicated sub-module.

**Effort.** Trivial — ~10 lines in `event_pipeline.js` + ~20 lines for time transitions.

### BT-10. Entity delta stream

**Status:** ⏳ not started • **Priority:** medium (currently only `entitySpawn` half-handled; despawn silent; targeting silent)

**Problem.** `event_pipeline.js:68` listens for `entitySpawn` but only uses it to trigger urgent modes update — no structured log. Mineflayer also emits `entityGone`, `entityMoved`, `entitySwingArm` — none handled. Bot's relationship to nearby entities (mob started targeting me, mob left range, mob died) is invisible except via periodic prompt snapshots.

**Proposed solution.** Handlers for `entityGone`, a targeting check (when any hostile's `target` becomes `bot.entity`), entity death via `bot.on('entityDead', ...)` if exposed. Emit `[Entity]` log lines:

```
[Entity] event=acquired type=zombie dist=14.2 pos={...}
[Entity] event=targeting type=zombie dist=8.1
[Entity] event=died type=zombie killed_by=bot
```

**Blast radius.** Additive in `event_pipeline.js`.

**Effort.** Small — ~60 lines.

### BT-11. ContextBuilder truncation decisions

**Status:** ⏳ not started • **Priority:** medium (ContextBuilder is load-bearing; its decisions should be auditable)

**Problem.** ContextBuilder emits a stats line with totals (`prompter.js`: `[ContextBuilder] 2478/6908 tokens | conv:... mem:... ex:... nb:...`) — good summary. Drop/truncate decisions are not logged. When the token budget forces a section to be shortened or skipped, we see only the post-truncation counts, not the decision process. For a small-context model, this is where "why didn't the bot know about X" answers live.

**Proposed solution.** Inside ContextBuilder's budget-enforcement code path, log one `[ContextBuilder] dropped=examples (budget=0)` or `[ContextBuilder] truncated=memory 2400→1916 tokens (budget)` line per decision.

**Effort.** Small — ~20 lines in `prompter.js`.

### BT-bundle. Observability minor items

**Status:** ⏳ not started • **Priority:** mixed (small, standalone; ship any/all as convenient) • **Source:** 2026-04-16 observability audit

_Goal lifecycle bullet lifted out 2026-04-17 — shipping paired with BT-7 (see In-progress). Remainder:_

- **Mutex wait duration.** `bot_mutex.js:82` logs queue depth on acquire; add elapsed-wait-ms when acquire follows a queued wait. ~3 lines.
- **File I/O silent-swallow scan.** 27 `readFileSync` + 8 async `fs.readFile/writeFile` calls. Audit each `catch` branch for "logged or swallowed." Already noted in L3 audit (April 15). Risk: silent memory-save failures. Extends #15 (`full_state.js` sweep, shipped) to the whole codebase.
- **Process exit reasons.** `agent.js cleanKill` + `process.on('exit', ...)` — log the exit reason as a structured line so session replay sees the end clearly.

### F. Long-term memory population audit

**Status:** ⏳ not started • **Priority:** **HIGH — promoted 2026-04-15 after audit confirmed subsystem is frozen** (biggest leverage for "gemma-4 punches above its weight")

**Audit update 2026-04-15 (L5.3 + L4):** the investigation this item called for was done during `/mindcraft-audit` and confirmed the suspicion. Static grep across `src/`: zero `long_term_memory.store` / `longTermMemory.store` / `.add()` callsites outside `src/memory/seed_memory.js:237`. Runtime log tail (500 lines of active play): zero `[LongTermMemory] Stored` lines. Index file entry count: ~39, matching the seed count exactly. LongTermMemory is frozen at seed; the fork's cross-session learning story is currently aspirational. Status moved from "investigation needed" to "integration needed" — first concrete migration target (spawn-escape path) remains the right starting point, see below.

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

### OPT-A. Delete safeToss — complete the safeTossBatch migration

**Status:** ⏳ not started • **Priority:** high (Principle 5 — kill redundancy; ~150 lines of duplicated disposal logic)

**Root cause:** `safeTossBatch` was built to solve the N-tunnels-for-N-items problem. `safeToss` is the old single-item path that should have been removed when batch landed. It wasn't — an unfinished migration. Both functions share nearly identical tunnel validation, direction checking, walk-dig loops, surface hole logic, and fallback patterns.

`withBotLock` is reentrant (uses `AsyncLocalStorage` — nested calls detect the held token and run directly), so there is no deadlock barrier to consolidation. The lock was never a reason to keep both.

**Fix:** Delete `safeToss` entirely. Update every callsite to use `safeTossBatch` with a single-item array. Check whether any caller passes meaningful `metadata` — if so, add metadata support to `safeTossBatch`. This also resolves Finding G (`discard` calling `safeToss` per stack) — once `safeToss` is gone, `discard` naturally routes through batch.

**Blast radius (to verify at implementation time):** grep every `safeToss` callsite in `src/`, confirm each can be converted to the `safeTossBatch` `{type, count, name}` shape. Verify `discard` function in skills.js, `autoDiscard` and `autoDiscardAllJunk` in inventory_utils.js.

### G. Procedural memory / ConfidenceEngine activation audit

**Status:** ⏳ not started • **Priority:** medium-high (complementary to F; actionable in one line of config once BT-4 + #20 instrumentation are both in place)

**Scope narrowed 2026-04-16:** G's original audit step 1 (adding `ConfidenceEngine.evaluate()` logging) was absorbed into BT-4 (Memory retrieval visibility). G is now a pure threshold-tuning item that runs once BT-4 has shipped the evaluation logs. Re-numbered steps below reflect this.

**Audit update 2026-04-15 (L4.1 + L5.2):** live data now available. `ConfidenceEngine` is firing 24× in 500 log lines — every repeat command comes back at **92-93% confidence**. `highThreshold` in `src/memory/confidence_engine.js` is `0.98`. Gap is 3-5 percentage points. The engine is ready to bypass; the threshold is miscalibrated. Static `procedural_memory.json` inspection shows max stored confidence of 0.68, so the 0.98 threshold has never fired historically either. **Quick win: lower `highThreshold` to 0.95 and monitor for false-positive bypasses** — should unlock HIGH-tier bypasses on established patterns immediately. If none appear in a week of play, consider 0.90. Depends on #20 (write-side, shipped) + BT-4 (read-side, pending) for the full distribution picture.

`ProceduralMemory` tracks action-context pairs with Wilson-score confidence. `ConfidenceEngine.evaluate()` decides HIGH (≥0.85, bypass LLM) / MEDIUM (0.5-0.84, suggest) / LOW (<0.5, full reasoning). The audit question: what's the actual distribution? If the engine always falls through to LOW (cold-start with no data), procedural memory is collecting metrics nobody reads and the entire bypass mechanism is inert.

**Prerequisite:** BT-4 ships `[MemoryRecall]` + ConfidenceEngine evaluation logs, giving the distribution data this tuning needs.

**Audit steps (post-BT-4):**
1. Analyze: confidence distribution across commands, bypass hit rate, how many unique contexts seen.
2. If cold-start dominates: consider seeding `procedural_memory.json` with hand-curated high-confidence patterns (e.g., `"equip pickaxe before mine stone" → confidence 1.0`).
3. If already firing at reasonable rate: adjust thresholds if false positives / false negatives appear.

**Success signal:** measurable fraction of commands bypass the LLM via HIGH confidence — speeds up the bot and reduces hallucination risk. Procedural memory grows session-over-session.

**Why this matters for #9:** bypassing the LLM entirely for routine actions is the purest expression of "let the LLM do what it's good at, program everything else."

### 7c. Heuristic auto-detection of player-built structures

**Status:** ⏳ not started • **Priority:** medium (complements the #7 village detector; catches player bases)

Current state (post-#7): the bot protects user-managed zones from `player_structures.json` and auto-detects vanilla villages via villager/workstation/bell signals. It does NOT auto-detect player-built bases.

**Approach**: scan chunks for clusters of "strongly player-characteristic" blocks — stone_bricks + polished stones, doors, glass panes, wool, concrete, redstone components, banners, item frames, beds (outside villages), crafted stairs/slabs. ≥5 clustered within ~10 blocks → propose a protected zone with type='player_base'. False-positive mitigation: list curated to exclude ambiguous blocks (torches, crafting_tables, chests, furnaces — these cluster in villages too and the village detector already handles those).

**Deferred decisions:** exact threshold (5? 8?), cluster radius (10? 16?), block list tuning. Start conservative, tune from observed false-positives.

### 7b. Self-cleanup of incidental block placements

**Status:** ⏳ not started • **Priority:** medium (world-stewardship behavior)

JP observed the bot placing vertical/horizontal columns of resource blocks (cobblestone, dirt) for unclear reasons — pathfinder scaffolding / LLM confusion. Bot should track its placements and clean them up.

**Fix sketch:**
1. Track every block via `bot.placedBlocks = [{x, y, z, type, placedAt, purpose}]` (similar to `bot.placedTorches`).
2. Categorize purpose: `pathfinder-scaffold`, `spawn-block`, `unknown-llm` (cleanup-eligible) vs `intentional`/`torch`/`functional` (excluded).
3. New low-priority `cleanup_blocks` mode in `modes.js`, fires when idle: walks through eligible entries; if bot is now >5 blocks away AND block still exists, break it and remove from list.
4. Cap list size (200, FIFO). Clear on bot death/respawn.

### OPT-H. Verify sugar_cane in MOVEMENT_BLOCKING_PLANTS — possible regression

**Status:** ⏳ not started • **Priority:** medium (correctness — sugar_cane has no collision box in Minecraft)

Earlier session work explicitly removed `sugar_cane` from `MOVEMENT_BLOCKING_PLANTS` because it has no collision box and the bot walks through it. Current code (line ~1909 in skills.js) still lists it. Either the removal was never committed or a later change reintroduced it.

**Fix:** Check git log for the removal. If it was removed and reintroduced, revert. If it was never committed, remove it. Sugar cane does not impede movement — it should not be in a movement-blocking allowlist.

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

- **Audited 2026-04-15** — first run of the `/mindcraft-audit` skill (v1.1). Full reports in `mindcraft-mcgavin-audit/2026-04-15/` (workspace-local, not committed): `L1-mechanical-dead-code.md`, `L2-perimeter.md`, `L3-error-handling.md`, `L4-subsystem-activation.md`, `L5-partial-migrations.md`, `L6-rules-vs-code.md`, `AUDIT_SUMMARY.md`. Verdict: codebase in good shape; 9 new entries (#13–#21 + L1.4) added to the to-do queue above. Biggest single Principle-1 lever: G threshold drop (0.98 → 0.95). Mechanical bundle shipped 2026-04-15: #13, #14, #15, #16.1, #19, #20 — Principle-8 sweeps complete across `full_state.js`, `connection_handler.js`, and `procedural_memory.js`; Rule 7 digUp leak closed; startup hardening in place.
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

**Principle 5 honesty.** Only `lmstudio.js` migrates today. The other 19 adapters (`gpt, claude,
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

### 2026-04-16 — createMovements factory: zone-aware pathfinder movements (Rule 7 perimeter closure) ✅

Commit `f2f53aa`. The pathfinder was the last unguarded path that could modify blocks inside protected zones. Every `goToGoal`, `followPlayer`, `defendSelf`, `moveAway`, etc. created raw `pf.Movements` with full dig/scaffold enabled — the pathfinder would tunnel through terrain and place cobblestone scaffolds inside spawn/village/structure zones. JP observed this live: after respawn, the bot was punching holes in the ground and placing cobblestone during spawn escape.

New `createMovements(bot)` factory replaces all 17 raw `new pf.Movements(bot)` callsites. When the bot is inside a protected zone, the factory disables `canDig` and clears `scaffoldingBlocks`. Outside zones, returns a normal Movements object with terrain-safe hazard avoidance applied via `_configureTerrainSafeMovements`.

This completes the Rule 7 perimeter for protected zones. The invariant — "no block modification inside a protected zone" — is now enforced at every layer:
- **Direct dig/place:** `breakBlockAt`, `placeBlock`, `collectBlock`, `safeToss`, `autoBreakStuckPlant` all check `_isInAnyProtectedZone`
- **Pathfinder navigation:** `createMovements` factory disables dig/scaffold inside zones
- **Escape recovery:** `escapeProtectedZone` walks out using non-destructive pathfinding
- **Startup:** `bot.collectBlock.movements` configured via `_configureSafeMovements`

Callsites replaced: `defendSelf` (2x), `collectBlock`, `pickupNearbyItems`, `breakBlockAt`, `placeBlock` (2x), `goToGoal` (2x), `followPlayer`, `moveAway` (2x), `moveAwayFromEntity`, `avoidEnemies`, `tillAndSow`, `activateNearestBlock`, `digDown`. `world.js:isClearPath` left unchanged (already `canDig=false`).

### 2026-04-16 — safeTossBatch: single dump run for all junk items ✅

Commit `9300490`. `autoDiscard` and `autoDiscardAllJunk` were calling `safeToss` per item type — each call independently dug its own 8-block tunnel underground. A 4-item discard meant 4 tunnels carved through the cave, exposing lava and creating fall hazards. Massive terrain destruction for no reason.

New `safeTossBatch(bot, items)` function: collects all items to discard first, digs ONE tunnel, digs ONE hole at the end, drops ALL items into that single hole, walks back. Both `autoDiscard` and `autoDiscardAllJunk` refactored to build a batch and call `safeTossBatch` once. `safeToss` remains unchanged for single-item use (`!discard` command).

### 2026-04-16 — autoBreakStuckPlant: movement-blocking allowlist for protected zones ✅

Commit `37b6d4c`. Tightened which blocks `autoBreakStuckPlant` is allowed to break inside protected zones. Previously any plant-like block (grass, flowers, ferns, lily pads, etc.) could be broken — most of these are passable and the bot walks right through them.

New `MOVEMENT_BLOCKING_PLANTS` allowlist limits protected-zone breaks to blocks that actually impede movement: `sweet_berry_bush`, `vine`, `sugar_cane`, `big_dripleaf`, `mangrove_roots`, `muddy_mangrove_roots`, and all leaf types. Passable blocks (short_grass, flowers, ferns, dead_bush, glow_lichen, kelp, seagrass, sea_pickle, lily_pad, pitcher_plant, torchflower, spore_blossom, nether_sprouts, small_dripleaf) are now left untouched.

Also moved `mangrove_roots` / `muddy_mangrove_roots` out of `TREE_PART_PATTERN` — they block movement and should be breakable, not protected as tree structure. Entry gate updated to include `MOVEMENT_BLOCKING_PLANTS` so these blocks still get considered by the function.

23/23 logic tests passed covering all block types.

### 2026-04-16 — Zone-aware escape logic for all protected zones ✅

Commit `1bbc0ab` + agent.js update. `escapeProtectedZone` replaces `escapeSpawnZone` as the primary escape function. When the bot tries to modify blocks inside ANY protected zone (spawn, village, or manual structure), the new escape logic walks it away from the offending zone's center. AutoRecovery pattern updated from `ESCAPE_SPAWN_ZONE` to `ESCAPE_PROTECTED_ZONE` with `skipRetryLimit: true` (no 3-retry cap — bot keeps trying until clear). `agent.js` spawn-event hook updated to call `escapeProtectedZone` (handles respawn inside village zones too).

**What landed:**
- `escapeProtectedZone()` in skills.js — phase 1 delegates to `escapeSpawnZone` for spawn zones, phase 2 handles village/structure zones by walking away from zone center using directional hops
- AutoRecovery: `ESCAPE_SPAWN_ZONE` → `ESCAPE_PROTECTED_ZONE` with `skipRetryLimit: true`
- `agent.js` spawn-event hook: `escapeSpawnZone` → `escapeProtectedZone`
- Escape buffer: 50% of zone radius (spawn 250 → 375, village r=100 → 150)
- `SPAWN_ESCAPE_DISTANCE` updated from 350 to 375 for consistency

**Live verification (2026-04-16):**
- [x] Spawn-zone escape via phase 1 delegation: `collectBlocks("oak_wood", 10)` → all 8 blocks filtered as inside spawn protection zone → AutoRecovery matched `inside_protected_zone` → `ESCAPE_PROTECTED_ZONE` fired → `[ProtectedZoneEscape] Inside spawn zone — delegating to escapeSpawnZone` → bot hopped -Z direction, 8 hops with stuck maneuver recovery, arrived at (-43, 62, -284) = 251.9 blocks from spawn → AutoRecovery retried `collectBlocks`
- [x] `skipRetryLimit` working: AutoRecovery did not cap at 3 retries, continued escaping
- [x] No regression: spawn-zone escape mechanics (directional hopping, stuck maneuvers, 45s hop timeout) all functioning correctly
- [ ] Village-zone escape (phase 2): village `village_250_138` detected via bell, but bot hasn't attempted to modify blocks inside it yet. Awaiting natural trigger.
- [ ] Overlapping zone escape: not yet observed

**Philosophy/rules adherence:**
- Principle 1 (reduce LLM reliance): escape is purely mechanical — no LLM involvement in zone detection or pathfinding away from zones
- Principle 4 (preserve work across sessions): escape direction caching via `bot.escapeMemory` preserved
- Rule 4 (root cause not symptom): the original issue was `escapeSpawnZone` only knowing about spawn distance; fix makes escape aware of ALL protected zone types
- Rule 7 (complete the perimeter): `agent.js` spawn-event hook updated; `grep` confirmed no remaining `escapeSpawnZone` callsites outside the delegation path

### 2026-04-16 — #22 ChunkWait: hold state during chunk-load / NaN-position windows ✅

Five-commit sequence (`d19476e` → `e5cf5ba` → `a5158ac` → `7f6741a` → `4107d70`) plus the `69306b2` viewDistance companion. Addresses the 2026-04-16 stuck-loop observation where the bot burned ~300 LLM calls over an hour cycling `!digDown` / `!goToSurface` / `!searchForBlock` against a NaN `bot.entity.position`. Also folds in the #16.1 guard-message-evading-keyword-list regression (guard returns were being recorded as ProceduralMemory successes).

**What landed:**

- **B1 `d19476e`** — pure refactor: extracted `_connectBot(save_data, init_message, count_id, load_mem)` from `Agent.start()`. Guards `AutoRecoveryEngine` + `initModes` + `_villageScanInterval` so they are idempotent across re-entry. Behavior-preserving on the first-connect path; prerequisite for B2.
- **B2 `e5cf5ba`** — `reconnect()` method on Agent + `_softReconnect` flag + `onDisconnect` gating. When the flag is set, a disconnect triggers a 2s wait and a fresh `_connectBot()` call with stashed args (`null` init_message, `load_mem=true`) instead of `process.exit(1)`. Agent-level state (memory, task, AutoRecovery, ConfidenceEngine, prompter, history) is preserved across the bounce; only the mineflayer client + bot-tied bindings are recycled. Idempotent + tolerant of a missing bot handle.
- **B3 `a5158ac`** — new `src/agent/chunk_wait.js` module. 500 ms watchdog on `bot.entity.position` finiteness with `enter()` / `exit()` state transitions. 180 s escalation cap sends the escalation chat message then calls `agent.reconnect()`. Runaway protection: > 2 reconnects in 5 min → `process.exit(1)` (principle #8 fail loudly, don't token-burn in a loop). Tunables (cadence, cap, whitelist, messages, runaway window) are all constructor options — Rule 1 flexibility. Agent hook in `start()` instantiates and starts the watchdog once, before `_connectBot()`, so the watchdog survives reconnects attached to the Agent rather than any bot.
- **C `7f6741a`** — agent.js wiring. `handleMessage` now consults `chunk_wait.isHeld()` at ingress: player messages run through `shouldGate()` and, if non-whitelisted, get the polite throttled hold message via `notifyPlayerMessage(source)` and return without an LLM call; self-prompt / system / other-bot messages return silently (self_prompter resumes naturally once `exit()` fires). Both `recordOutcome` sites (hallucinated-command branch + post-execute branch) now skip when held — fixes the #16.1 false-positive class at source rather than by extending the keyword list.
- **D `4107d70`** — skills.js + agent.js closure. `_connectBot` sets `this.bot.agent = this` after `initBot()` (refreshed every reconnect) so skill code has a backref to Agent subsystems. `digDown` + `digUp` NaN-position guards no longer emit `log(bot, 'Could not start digDown — my position is not loaded yet.')` user-facing; they call `bot.agent?.chunk_wait?.enter(reason)` instead. Silent `return false` + `console.warn` stay as Rule 5 defense-in-depth against a race where the skill guard fires before the watchdog tick.
- **viewDistance companion `69306b2`** — added `viewDistance: 'normal'` to mineflayer `createBot` options in `src/utils/mcdata.js`. Mineflayer defaults to `'far'` when absent, which puts the highest server-side chunk-send pressure and is the leading cause of the kicks #22 recovers from. Addresses the root cause at the protocol layer so ChunkWait has fewer windows to manage.

**Rule 7 perimeter audit (documented here so the invariant is checkable after future edits):**

The new invariant is: _"no command execution and no procedural memory write while ChunkWait is held, except for whitelisted commands."_ Call-site enumeration:

| Entry point | Location | Gated? | Mechanism |
|---|---|---|---|
| Player chat / command ingress | `agent.js handleMessage` top | Yes | `chunk_wait.isHeld()` + `shouldGate(message)` + `notifyPlayerMessage` |
| Self-prompt / system / inter-bot ingress | `agent.js handleMessage` top | Yes | same branch, silent return |
| Forced user command (`!newAction`-class) | `agent.js handleMessage` forced-command branch | Yes | runs after the ingress gate; only whitelisted commands reach it while held |
| `executeCommand` inside LLM loop | `agent.js handleMessage` LLM loop | Yes | loop body never runs when ingress gate returns false |
| `recordOutcome` — hallucinated command | `agent.js handleMessage` line ~862 | Yes | `!this.chunk_wait?.isHeld()` added |
| `recordOutcome` — post-execute | `agent.js handleMessage` line ~905 | Yes | `!this.chunk_wait?.isHeld()` added |
| AutoRecovery retry executeCommand | `agent.js handleMessage` recovery block | Indirect | only reached when an execute_res was produced, which itself required the ingress gate |
| `digDown` NaN-position guard | `skills.js:3528` | Yes | delegates to `chunk_wait.enter(reason)`, `return false` |
| `digUp` NaN-position guard | `skills.js:3753` | Yes | delegates to `chunk_wait.enter(reason)`, `return false` |
| Watchdog self-entry on NaN | `chunk_wait.js _tick` | — | the source |
| `onDisconnect` hard-exit path | `agent.js _connectBot` | Preserved | soft path only triggers when `_softReconnect=true`; default is still `process.exit(1)` so a real crash still surfaces in tmux |

**Philosophy/rules adherence:**
- Principle 1 (reduce LLM reliance): the entire purpose — zero LLM calls during a NaN window, purely programmatic gating.
- Principle 2 (memory is cognition): skipping `recordOutcome` under hold protects procedural memory from false-positive success entries — more valuable than the pollution "average-out" would have been.
- Principle 4 (preserve work across sessions): soft-reconnect preserves Agent-level state; the bounce is at the mineflayer-client layer.
- Principle 8 (fail loudly): every state transition logs with `[ChunkWait]` / `[Reconnect]` prefix; runaway condition is a `process.exit(1)` so humans see it instead of an infinite token loop.
- Rule 1 (flexibility): timeouts, whitelist, messages, runaway window, throttle all live as constructor options on `ChunkWait`.
- Rule 5 (no adverse effects): B1 extracted first as a pure refactor so B2 + B3 had a clean diff surface; all `setInterval` / `setTimeout` sites are cleared before being re-armed; `start()` / `stop()` / `enter()` / `exit()` are idempotent; reconnect is a no-op if already in flight.
- Rule 7 (complete the perimeter): audit above.

**Works for anyone who clones the repo:** the fix lives entirely inside `src/agent/` + one line in `src/utils/mcdata.js`. No external tmux wrapper, no systemd unit, no per-machine scripts. JP's "I want to fix the issue for all people, not just me" requirement satisfied.

**Live verification 2026-04-16:** On first restart after shipping, all three core checkpoints fired within 10 seconds: (1) `[ChunkWait] Watchdog started (500ms tick, 180s escalation cap).` appeared once after memory load, before login. (2) `[ChunkWait] ENTER held state — reason: watchdog: bot.entity.position NaN or missing` fired immediately on login. (3) `[ChunkWait] EXIT held state after 1.5s — reason: watchdog: position finite` fired once chunks loaded. Zero LLM traffic during the 1.5s hold. Bot proceeded cleanly through spawn escape and self-prompting. Escalation path (checkpoint 4) and procedural-memory guard (checkpoint 5) not yet observed — will arise organically during longer stalls.

### 2026-04-15 — Mechanical audit bundle: #13, #14, #15, #16.1, #19, #20 ✅

Six-commit sweep following the `/mindcraft-audit` intake. Each shipped as a one-concern commit per Rule 5, node --check clean, bot stayed running through the work — changes take effect on next restart.

- **#15 full_state.js error-logging sweep** (commit `af2cec3`) — 9 `catch (e) { /* use default */ }` sites in `src/agent/library/full_state.js` replaced with `console.warn('[FullState] <op> read failed, using default:', e.message)`. Operators can now distinguish healthy reads from silently-degraded reads (position NaN, biome lookup fail, inventory read fail, etc.). Pure Principle 8 sweep, additive only.
- **#19 connection_handler.js silent-catch logging** (commit `6c613ec`) — two wildcard `catch (_) {}` sites in `src/agent/connection_handler.js` replaced with named catches that log `[ServerProxy] Send failed: …` and `[ParseKickReason] JSON parse failed, using raw fallback: …`. Connection issues no longer undebuggable.
- **#14 readFileSync startup hardening** (commit `eb73110`) — 5 readFileSync sites across `coder.js` (exec/lint templates), `prompter.js` (_default.json + base profile), and `mindserver.js` (settings_spec.json) wrapped in try/catch with graceful fallbacks. A missing or malformed file no longer crashes the bot at startup — operator sees `[<Subsystem>] <file> load failed, using <fallback>` and can repair without a restart-loop. Individual profiles that fully specify their fields still boot cleanly.
- **#13 digUp ProtectedZone guard + Rule 7 audit** (commit `605e485`) — `digUp` placed staircase floor blocks via `bot.placeBlock` directly, bypassing the zone-gated skill-level `placeBlock()`. Added the missing `_isInAnyProtectedZone(nextX, nextY-1, nextZ)` check with wording that matches the AutoRecovery `inside_protected_zone` regex so the bot auto-escapes. Commit message records the full Rule 7 grep audit: every `bot.placeBlock` / `bot.dig(` callsite in `src/` enumerated and shown guarded — perimeter now closed across the whole codebase.
- **#16.1 digDown/digUp NaN position guard** (commit `a2a05d5`) — live play observed `digDown` starting at `(NaN, 56, NaN)` because `bot.entity.position` wasn't populated yet. Top-of-function guards in both staircase skills bail with a directive log (`my position is not loaded yet. Wait a moment and try again.`) instead of propagating NaN into blockAt lookups. Remaining position-reading callsites documented in commit for a later bundle.
- **#20 ProceduralMemory instrumentation** (commit `fb35d52`) — one log line at end of `recordAction`: `[ProceduralMemory] Recorded outcome <cmd>: <success|fail> (confidence now X.XXX, NS/MF, K total records)`. Unblocks #G threshold tuning — now we can see the confidence distribution evolve in real play instead of tuning blind. Wrapped in try/catch so a logging bug can never break the record path.

**Philosophy/rules adherence across the bundle:**
- Principle 8 applied three times (#15, #19, #20) — biggest single visibility gain per minute of work.
- Principle 4 (root cause, not band-aid): #13 is the real perimeter fix, not a downstream filter.
- Rule 7 explicitly followed and documented for #13 — the audit record lives in the commit message itself.
- Rule 5: every commit has a clean diff (no whitespace damage, no unrelated changes), every file passes `node --check`, zero call-site changes for #15/#19/#20, targeted additions for #13/#14/#16.1.

**Post-deploy verification**: bot is still running the pre-bundle code; changes take effect on next restart. Expected log lines after restart to confirm: `[FullState] …` (only on actual failures), `[ServerProxy] Send failed …` (on socket hiccups), `[ProceduralMemory] Recorded outcome …` (once per LLM turn with trained commands).

### 2026-04-15 — Safe Movements Stage 1: stop collectBlock from digging straight shafts ✅

Commit `e59a307`. JP observed the bot digging a straight vertical shaft during `!collectBlocks`. Traced to the `mineflayer-collectblock` plugin: it creates its own `pf.Movements(bot)` at plugin init with raw pathfinder defaults (`maxDropDown=4`, `digCost=1`, `canDig=true`, no terrain safety). When a target ore was buried, pathfinder chose the shortest path — a straight-down shaft — because digging straight down is N single-block costs vs a staircase's 2N.

**Fix:** new `installSafePathfinderDefaults(bot)` in `skills.js` that mutates `bot.collectBlock.movements` in place at agent startup: `maxDropDown=3`, `digCost=10`, `canSwim=true`, `_configureTerrainSafeMovements` applied. Plugin resets `dontMineUnderFallingBlock` and `dontCreateFlow` on each `collect()` call but those don't affect vertical digging. Our config survives.

**Perimeter audit (Rule 7)** run as part of planning:
- `goToGoal` — SAFE (already applies safer config to both its nonDestructive + destructive movements)
- `bot.collectBlock.movements` — SAFE (fixed by this commit)
- 20+ other `new pf.Movements(bot)` sites in `skills.js` — still raw defaults. Short-lived paths (breakBlockAt approach, defendSelf follow, unstuck) carry lower straight-shaft risk because targets are usually at bot height. Long-running destructive pathfinding (collectBlock plugin) was the real hazard and is now fixed.

**Full audit deferred to whiteboard #12** — establish a shared `createSafeMovements(bot, opts)` helper and route every `new pf.Movements(bot)` through it, with an optional lint-style grep-check to prevent regressions.

**Post-deploy verification:** bot restarted, startup log shows `[SafeMovements] bot.collectBlock.movements configured: maxDropDown=3, digCost=10, canSwim=true, terrain-safe`. No straight-down shafts since.

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
