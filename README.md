<h1 align="center">mindcraft-mcgavin</h1>

<p align="center"><b>A heavily modified <a href="https://github.com/mindcraft-bots/mindcraft">Mindcraft</a> fork optimized for local LLM inference and autonomous survival gameplay. No more expensive cloud LLMs or large heavy local LLMs that need god-tier hardware. This is designed to run on small, local LLMs and inexpensive hardware.</b></p>

<p align="center">
  Designed to run (and is currently running) on a 16GB M1 Mac Mini. Built for small context windows (gemma-4-e4b-it / LM Studio) with custom memory sub-systems to help take the weight off of the LLMs (think: "save tokens" and "quicker responses"), intelligent command routing, and a multi-goal autonomy engine.
</p>

---

## What Is This?

**mindcraft-mcgavin** started as a fork of [mindcraft](https://github.com/mindcraft-bots/mindcraft) and has diverged significantly. The upstream project is designed for cloud LLMs with large context windows. This fork is engineered to run well on **local models with limited context** (≤8K tokens), while adding systems that make the bot genuinely autonomous — not just reactive.

The bot (`McGavin`) runs on a home server against a local Minecraft world, powered by **gemma-4-e4b-it** served via **LM Studio** on a M1 Mac Mini with only 16GB of RAM. It is currently utilizing 80% of the 16GB of RAM.

## Key Differences from Upstream

| Area | Upstream Mindcraft | mindcraft-mcgavin |
|---|---|---|
| **LLM Target** | Cloud APIs (GPT-4, Claude, Gemini) | Local models via LM Studio/Ollama |
| **Context Budget** | Large (32K+ tokens) | Tight (~6.9K tokens) |
| **Prompt Assembly** | Template-based (`$STATS` placeholders) | Token-budgeted `ContextBuilder` with priority sections |
| **Memory** | Basic conversation history | Multi-tier: episodic, long-term, procedural, seed, confidence engine |
| **Goal System** | Single goal | Goal queue with auto-advance, persistent rules, compound goals |
| **Player Interaction** | LLM interprets all chat | Direct command passthrough + natural language detection |
| **Block Awareness** | `$STATS` placeholder injection | Full `!nearbyBlocks` (16-block radius) injected every prompt |
| **Ore Handling** | Basic block names | Bidirectional variant mapping (regular ↔ deepslate ↔ nether) |
| **Command Routing** | All through LLM | Confidence engine caches patterns; direct commands bypass LLM entirely |
| **Error Recovery** | LLM must interpret failures | Auto-recovery engine resolves common failures (wrong tool, full inventory, missing crafting table) without LLM involvement |
| **Inventory Mgmt** | Manual | Goal-aware auto-discard with tiered item scoring, cooldown protection |

## Custom Systems

### ContextBuilder (Token-Budgeted Prompts)
Every prompt is assembled within a strict character budget. Sections are prioritized: conversation history → command docs → memory → examples → nearby blocks. The builder tracks and logs token usage per section so you can tune the balance.

### Confidence Engine
Caches successful command patterns and replays them for high-confidence matches (≥0.98 threshold). Context key hashes the current goal, trigger, biome, time, health, and hunger. Context-dependent commands (mining, pathfinding, combat) are on a `neverBypass` list so they always go through the LLM.

### Multi-Tier Memory
- **Episodic Memory** — recent events stored in Vectra for similarity search
- **Long-Term Memory** — persistent facts and learned behaviors
- **Procedural Memory** — command usage patterns
- **Seed Memory** — bootstrapped knowledge for new sessions
- **Summarized Memory** — compressed conversation history (500 char limit)

### Goal Queue & Persistent Rules
- **Goal queue** — stack multiple sequential goals; `!endGoal` auto-advances to the next. Goal names are surfaced in the LLM system prompt so the bot knows its full roadmap
- **Persistent rules** — background checks that run between every self-prompt iteration (e.g., "collect any visible diamond ore"). Smart condition detection parses rule descriptions into actual game-state checks. Rules and goals persist across restarts via `memory.json`.

### Player Interaction
- **Direct command passthrough** — `!commands` from player chat execute immediately without LLM interpretation
- **Natural language detection** — "add goal Mine 64 diamonds" or "add rule collect visible ore" parsed via regex
- **Player message queue** — messages that arrive during LLM generation are queued and drained after completion
- **Urgent command detection** — "stop", "follow me", "come here" are caught before the queue

### GenerationLock (Concurrency Control)
A priority-aware mutex that serializes all LLM calls through a single lock, preventing concurrent requests from overwhelming the single-threaded LM Studio backend.

- **Three priority tiers** — `PLAYER` (highest) → `SELF` (self-prompt cycles) → `MEMORY` (summarization). When multiple callers are waiting, the highest-priority one runs next.
- **Eliminates response discards** — the old `most_recent_msg_time` race condition is fully removed. No more wasted LLM cycles from overlapping generations.
- **Deferred memory summarization** — `promptMemSaving` runs at `MEMORY` priority in the background, so it never competes with active player chat or self-prompt generation.
- **Error-safe** — the lock releases in a `finally` block, so a failed generation never deadlocks the bot.

### Auto-Recovery Engine (GOAP-Inspired)
The auto-recovery engine intercepts failed commands and resolves common failure chains automatically — no LLM round-trip required. Inspired by Goal-Oriented Action Planning (GOAP), it recursively resolves prerequisites up to 8 levels deep.

- **Pattern matching** — 7 built-in failure patterns (inventory full, wrong tool, missing crafting table, missing furnace, bedrock hit, pathfinding timeout, block not found) with runtime-extensible registry
- **Recursive dependency resolution** — "need pickaxe" → "need crafting table" → "need planks" → "collect logs" → resolved
- **Tool tier awareness** — queries both a hardcoded fast-path map and minecraft-data `harvestTools` dynamically to determine minimum tool tier. Distinguishes pickaxe vs axe operations
- **Inventory-aware** — checks empty slots before crafting, pre-validates discard suggestions, respects the 60-second discard cooldown
- **Snapshot caching** — single inventory enumeration per recovery pass, invalidated after mutations (craft, collect, discard)
- **Repeated failure detection** — gives up after 3 identical failures within 60 seconds, advising the LLM to try a different approach
- **Clean retry** — extracts the parsed command (e.g., `!collectBlocks("oak_log", 4)`) for retry instead of re-sending the full LLM response

### Inventory Management
- **Goal-aware auto-discard** — 5-tier item scoring system that protects goal-relevant items (diamond ore when goal is "craft diamond tools") and always keeps essential items (tools, food, crafting tables)
- **Discard cooldown** — 60-second cooldown prevents the bot from picking up items it just threw away
- **Pre-flight checks** — before crafting or recovery actions, the engine validates whether inventory can be cleared and bails early if not

### Mining & Pathfinding
- **Ore variant mapping** — searching for "diamond_ore" also finds `deepslate_diamond_ore`; searching for "gold" also finds `nether_gold_ore`. Bidirectional.
- **`!digDown`** — safe staircase descent with lava/water/void detection
- **`!digUp`** — safe staircase ascent with floor placement, bedrock/surface detection
- **Tuned pathfinding** — `thinkTimeout: 10s`, `tickTimeout: 80ms`, `pathfind_timeout: 4s` for underground navigation

## Architecture

```
Player Chat ──→ Direct Command?  ──yes──→ Execute immediately
                    │ no
                    ▼
              Natural Language? ──yes──→ Parse goal/rule, execute
                    │ no
                    ▼
              Confidence Engine ──high──→ Replay cached command
                    │ miss
                    ▼
            ┌─ GenerationLock ─┐
            │  PLAYER > SELF   │
            │    > MEMORY      │
            └───────┬──────────┘
                    ▼
              ContextBuilder ──→ LLM (Gemma 4 E4B IT) ──→ Parse & Execute
                    ▲                                          │
                    │                                     Command fails?
         ┌─────────┴─────────┐                                 │
    NearbyBlocks     Memory (episodic/LT/procedural)           ▼
    (16-block radius)                                 Auto-Recovery Engine
                                                      (resolve → retry)
```

## Setup

### Requirements
- Node.js v18 or v20
- Minecraft Java Edition (up to v1.21.6)
- A local LLM server ([LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/), or any OpenAI-compatible API)

### Quick Start

```bash
git clone https://github.com/jasonpsimon/mindcraft-mcgavin.git
cd mindcraft-mcgavin
npm install
```

Configure your bot profile (e.g., `McGavin.json`):
```json
{
    "name": "YourBotName",
    "model": "lmstudio/your-model-name",
    "url": "http://your-lm-studio-host:1234/v1",
    "embedding": {
        "model": "lmstudio/text-embedding-nomic-embed-text-v1.5",
        "url": "http://your-lm-studio-host:1234/v1"
    }
}
```

Update `settings.js` with your server IP and profile path, then:
```bash
node main.js
```

### In-Game Commands

Talk to the bot in Minecraft chat. Commands can be issued directly:

```
!goal("Mine 64 diamonds and build a house")
!addGoal("Craft diamond armor")
!addRule("Collect any visible diamond ore")
!viewGoals
!viewRules
!stop
```

Or use natural language:
```
add goal Mine 64 iron
add rule collect visible ore
show goals
remove rule 1
```

## Project Structure

```
src/
├── agent/
│   ├── agent.js              # Main agent — message handling, command routing
│   ├── self_prompter.js       # Goal queue, persistent rules, self-prompt loop
│   ├── auto_recovery.js        # GOAP-inspired failure recovery engine
│   ├── generation_lock.js     # Priority-aware LLM serialization (PLAYER > SELF > MEMORY)
│   ├── commands/
│   │   ├── actions.js         # !goal, !addGoal, !addRule, !digDown, !digUp, etc.
│   │   ├── queries.js         # !nearbyBlocks, !stats, !inventory, !viewRules
│   │   └── index.js           # Command parser and executor
│   └── library/
│       └── skills.js          # Pathfinding, mining, building, combat skills
├── memory/
│   ├── confidence_engine.js   # Pattern caching and replay
│   ├── context_builder.js     # Token-budgeted prompt assembly
│   ├── episodic_memory.js     # Recent event storage (Vectra)
│   ├── long_term_memory.js    # Persistent facts (Vectra)
│   ├── procedural_memory.js   # Command usage patterns
│   └── seed_memory.js         # Bootstrap knowledge
├── utils/
│   └── inventory_utils.js     # Goal-aware auto-discard and inventory scoring
└── models/
    └── prompter.js            # LLM interface and prompt orchestration
```
## Why I Forked This Project

If you made it this far, I owe you an explanation. This project was forked for a very personal reason: my children.

My daughter has always loved playing Minecraft and often wanted to play with me. But like many parents, I couldn't always be there. Sometimes I had to travel for work, and other times there were responsibilities at home that needed my attention. That being said, no one really wants to play alone. They want someone to share the experience with. To interact with.

Forking this project gave me a way to create that interaction, even when I couldn't be physically present. It allowed me to build something that could keep her company in the game world and make Minecraft feel more alive and social.

There was another important motivation as well. My youngest child, my son, has been working to improve his reading comprehension in school. Because interacting with the bot involves reading and responding to text, I saw an opportunity to turn playtime into gentle, natural practice. Instead of worksheets or drills, he can learn through conversation and exploration in a game he already enjoys.

And finally, this project simply makes Minecraft more fun for our whole family. It turns the game into a shared experience, encourages creativity, and creates moments of connection, even when life gets busy.

This fork exists because technology can be more than code. It can be a way to show up for the people you love.

If you like what I have done and it has benefit you in some way, any way, please feel free, not obligated, to send me a tip at https://ko-fi.com/jpsimon

## Credits

Forked from [mindcraft](https://github.com/mindcraft-bots/mindcraft) by [@kolbytn](https://github.com/kolbytn), [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), and the Mindcraft team.

All upstream APIs and model support are preserved — this fork adds local-LLM optimizations on top.

## License

Same as upstream Mindcraft.

