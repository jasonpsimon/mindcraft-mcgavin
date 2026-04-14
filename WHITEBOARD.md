# mindcraft-mcgavin — Project Whiteboard

Digital workspace for mindcraft-mcgavin bot development. Holds current state, active work, to-do queue, recent history, and known-but-deferred issues. Update freely as work lands — this is meant to be edited, not preserved.

_Last updated: 2026-04-14_

---

## Current state (live on develop)

- Running on gaming server (`/RAID/mindcraft-mcgavin`) in tmux session `mindcraft`, profile `ThatCoolGuyDude.json`, LLM `gemma-4-e4b-it` via LM Studio.
- Branch: `develop` — merge commit `6fdcff2` includes the bot action mutex fix.

---

## In-progress

- **Post-merge stability check** — scheduled task `mindcraft-mutex-stability-check` fires at 1:15 PM CDT 2026-04-14 to verify bot_mutex behavior over ~2 hours of runtime. Will report scoreboard + recommendation (stable / needs follow-up).

---

## 1. Wrong tool for the block

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

## 2. No torches when dark

**Status:** not started • **Priority:** medium

The `torch_placing` mode exists in `src/agent/modes.js` (~line 222) but either isn't firing or has the wrong trigger. Bot routinely operates in pitch black.

**Expected behavior:**
Mimic real human gameplay — if `bot.time.timeOfDay` indicates night OR the bot is in a dark area (light level < ~7), place or hold a torch.

**Fix sketch:**
1. Inspect current `torch_placing` mode trigger conditions; they probably only fire when "no torches nearby" without checking actual darkness.
2. Extend trigger to: `(light_level < 7 OR is_night) AND has_torch_in_inventory AND not_in_spawn_zone`.
3. Optionally equip torch in off-hand (`bot.equip(torch, 'off-hand')`) while active so monsters are deterred during movement.

---

## 3. Strategic torch placement underground (left-wall convention)

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

## 4. Humanized action delays

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

## 5. Reduce LLM reliance through programmatic enhancements

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

- Items 2 and 3 will interact — the torch inventory check in #2 + placement convention in #3 should share a common helper.
- Item 1 is the biggest latent performance bug and should probably go first. The current tool races and dig timeouts may silently resolve once the bot is actually using pickaxes on stone.
- Item 4 should be last — don't add delays on top of a broken bot. Fix behavior first, then slow it down.
- Item 5 is a philosophy that shapes how we approach 1–4 and everything beyond. As we implement 1–4, we should be thinking "is this programmatic or LLM-reliant?" and pushing toward programmatic wherever it makes sense.

---

## Recently completed

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

## Known issues (deferred — out of scope for items 1–5)

- **PartialReadError spam on `SlotComponent` parsing.** Minecraft server is on 1.21 (base); mineflayer 4.33.0 supports up to 1.21.11. Protocol drift on slot-component packet format introduced in 1.20.5+. Bot connects and runs anyway, but inventory state may be subtly wrong. Fix path: bump mineflayer, or pin server to a supported patch version.
- **Memory compression exceeding 500-char limit.** LLM repeatedly truncates its own memory summaries with "Memory truncated to 500 chars. Compress it more next time." Compression prompt isn't strict enough. Fix lives in the memory summarization prompt template.
- **`self_preservation` mode now waits on the bot mutex.** In rare cases (bot drowning during a long SafeToss), emergency response could be delayed by several seconds. Trade-off accepted for now vs. the constant disposal failure the race was causing. Can carve a priority-mutex exception later if it becomes a problem.
