<h1 align="center">mindcraft-mcgavin</h1>

<p align="center"><b>A heavily modified <a href="https://github.com/mindcraft-bots/mindcraft">Mindcraft</a> fork optimized for local LLM inference and autonomous survival gameplay.</b></p>

<p align="center">
  Built for small context windows (Gemma 4 E4B IT / LM Studio) with custom memory systems, intelligent command routing, and a multi-goal autonomy engine.
</p>

---

## What Is This?

**mindcraft-mcgavin** started as a fork of [mindcraft](https://github.com/mindcraft-bots/mindcraft) and has diverged significantly. The upstream project is designed for cloud LLMs with large context windows. This fork is engineered to run well on **local models with limited context** (≤8K tokens), while adding systems that make the bot genuinely autonomous — not just reactive.

The bot (`McGavin`) runs on a home server against a local Minecraft world, powered by **Gemma 4 E4B IT** served via **LM Studio** on a Mac Mini.

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
- **Goal queue** — stack multiple sequential goals; `!endGoal` auto-advances to the next
- **Persistent rules** — background checks that run between every self-prompt iteration (e.g., "collect any visible diamond ore"). Smart condition detection parses rule descriptions into actual game-state checks. Rules and goals persist across restarts via `memory.json`.

### Player Interaction
- **Direct command passthrough** — `!commands` from player chat execute immediately without LLM interpretation
- **Natural language detection** — "add goal Mine 64 diamonds" or "add rule collect visible ore" parsed via regex
- **Player message queue** — messages that arrive during LLM generation are queued and drained after completion
- **Urgent command detection** — "stop", "follow me", "come here" are caught before the queue

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
              ContextBuilder ──→ LLM (Gemma 4 E4B IT) ──→ Parse & Execute
                    ▲
                    │
         ┌─────────┴─────────┐
    NearbyBlocks     Memory (episodic/LT/procedural)
    (16-block radius)
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
└── models/
    └── prompter.js            # LLM interface and prompt orchestration
```

## Credits

Forked from [mindcraft](https://github.com/mindcraft-bots/mindcraft) by [@kolbytn](https://github.com/kolbytn), [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), and the Mindcraft team.

All upstream APIs and model support are preserved — this fork adds local-LLM optimizations on top.

## License

Same as upstream Mindcraft.
