# mindcraft-mcgavin — Design Philosophy

_This document describes why the project exists and the principles every design decision should honor. Read this before `CODE_RULES.md`; the rules derive from the principles._

---

## What this project is

mindcraft-mcgavin is a Minecraft bot optimized for **small local LLMs**. It forked from kolbytn/mindcraft but has diverged intentionally. Upstream targets frontier cloud models (GPT-4, Claude 4, Gemini). This fork targets 4B-parameter local models — currently gemma-4-e4b-it running in LM Studio on a 16GB M1 Mac Mini.

The fork was built to make a Minecraft bot:

- **Affordable** — no cloud inference costs, ever
- **Private** — local model, no external API traffic
- **Available** — doesn't require internet, API keys, or third-party uptime
- **Useful** — a better minecraft companion for all

## What this project is not

- **Not a competitor to upstream.** Upstream is fine; it serves a different audience (users with frontier-model budgets).
- **Not a drop-in fork.** The 2000+ lines of memory subsystem additions, the ContextBuilder, the ConfidenceEngine, AutoRecovery, the goal-aware inventory classifier — none of it will merge upstream, and that's by design.
- **Not a technology demo.** The bot has to actually work, survive, and be fun to play with. Elegant code that makes a bot useless is not elegant.

Upstream compatibility is not a goal. The two projects have opposite philosophies about where intelligence should live.

---

## The core thesis

**A small model augmented with strong programmatic scaffolding can match the practical utility of a large model running bare.**

This is not aspiration — it is how the fork already works. Every architectural decision reinforces it:

- Memory is rich and layered (episodic, long-term, procedural, confidence, delta-state, seed, context-builder) — because small models forget.
- AutoRecovery handles recurring failure patterns deterministically — because small models spiral.
- Goal-aware inventory classification, pre-flight tool equipping, protected zones, mutex-serialized bot mutation — because small models make unsafe assumptions.
- ConfidenceEngine can replay high-confidence patterns without an LLM round-trip — because every LLM call is expensive and risky on a weak model.

**The fork asks more of the code so it can ask less of the model.**

---

## Principles

### 1. Reduce LLM reliance wherever possible

The LLM is good at: open-ended goal-setting, natural-language chat with players, high-level strategy, novel situations.

The LLM is not good at: mechanical rules, state transitions, routine sub-goals, consistent formatting, remembering what happened 50 turns ago, following precise numeric constraints.

Every mechanical decision the LLM is asked to make is a candidate to convert to code. Every LLM call that produces an artifact nobody reads is a candidate to delete. Every recurring confusion is a candidate for AutoRecovery.

This is the central philosophy. Everything else follows from it.

### 2. Memory is cognition

A small model has a small context window, limited reasoning depth, and a strong tendency to re-derive things it already knew.

Memory subsystems compensate. We invest in them. We keep them layered:

- **Episodic** for conversational recall (vector-embedded, semantic retrieval)
- **Long-term** for persistent facts across sessions
- **Procedural** for action-success confidence tracking
- **Seed** for bootstrapping known-good knowledge at startup
- **ContextBuilder** for token-budgeted, priority-ordered prompt assembly

We populate them aggressively and preserve them across sessions. Every stored fact is knowledge the LLM doesn't have to re-discover. A dormant memory system is a failed investment.

### 3. Goal-awareness drives adaptive behavior

The bot's current goal is not a display string — it is a classifier input.

The goal text determines:

- Which items are junk vs. valuable (`GOAL_ITEM_MAP`)
- Which failure patterns should recover vs. pass through
- Which sub-goals to auto-execute (crafting chains, gathering loops)

Code that reads the goal and adapts is preferred over code that ignores it. A bot that behaves identically regardless of goal is a bot that wastes context on irrelevant computation.

### 4. Preserve work across sessions

When the bot dies, restarts, or switches profiles, everything the LLM has "learned" during play should persist if there's a way. In-process state (plain JS maps, module-scope variables) is a last resort. Vector-indexed long-term memory is the default.

A bot that re-discovers the escape direction out of spawn every session, or re-fails at smelting coal_ore every session, is a bot whose scaffolding isn't doing its job.

### 5. Finish migrations, kill redundancy

Partial refactors accumulate cost. When we start a migration (e.g., "episodic replaces lossy summary"), we finish it. Either we complete the new path and remove the old, or we decide the old path stays and rationalize the coexistence explicitly.

Half-finished migrations leave dead weight that costs tokens, adds confusion, and misleads future contributors. We don't ship them and we don't inherit them quietly — we finish them.

### 6. Upstream compatibility is not a goal

The fork has already diverged substantially, and that divergence is the point. We will not accept a change that makes the fork "closer to upstream" if it means weakening the scaffolding philosophy that justifies the fork's existence.

We may still cherry-pick upstream fixes when they address shared bugs we care about. That is opportunism, not commitment. We do not maintain merge-readiness, and we do not defer design decisions because upstream might pick them up.

### 7. Whiteboard-driven development

Every non-trivial change is tracked on `WHITEBOARD.md` — before, during, and after. The whiteboard is the source of truth about:

- What's currently active (**In-progress**)
- What's next (**To-do**, grouped by status and severity)
- What's deferred (**Known issues**)
- What's been done (**Recently completed**)

No silent work. If it's not on the whiteboard, don't know about it. If it's on the whiteboard and is decided it should be abandoned, we say so and mark it as abandoned, rather than letting it linger.

### 8. Fail loudly, fail informatively

When the bot fails, the failure must be actionable.

Log lines carry structured prefixes (`[AutoRecovery]`, `[SafeToss]`, `[ContextBuilder]`, `[EpisodicMemory]`) so humans and agents can trace a behavior to a code path. Error messages are directive — they tell the LLM (or the human operator) what to do differently, not just what went wrong.

Unknown failure paths pass through. We do not silently swallow them. If we don't know how to recover, we say so clearly and let the next layer (the LLM, or the user) decide.

A caught-and-ignored exception is worse than an uncaught crash. The crash at least tells you something is wrong.

---

## When to engage the LLM

**Engage the LLM when:**

- The decision is open-ended and requires natural-language reasoning
- There is no deterministic rule that captures the right answer
- The action is reversible, or the consequences benefit from judgment
- The input is genuinely novel — not a case we've seen a dozen times before

**Code around the LLM when:**

- The decision is rule-based (e.g., "what tool to equip for this block type")
- The input is one of a fixed set of cases (e.g., "which category does this ore fall into")
- The LLM consistently gets it wrong in ways that more prompt tweaking won't fix
- Speed matters more than nuance (ConfidenceEngine bypass territory)

If you find yourself writing a prompt to make the LLM comply with a rule, stop and consider whether the rule could just be code. Usually it can.

---

## Anti-philosophy — what we don't do

**We don't prompt-engineer around model weakness.** When gemma-4 can't reliably compress a 500-char memory summary, we don't rewrite the prompt with better examples and tighter constraints. We ask whether we need the summary at all, and delete it if we don't. Prompt tweaking is a band-aid; the root issue is usually that the LLM was asked to do something it isn't good at.

**We don't let the LLM re-derive every turn.** If the bot solved a problem last session (found a vein, learned a mob danger, figured out an escape direction), next session should start from that knowledge. Memory subsystems exist specifically so this works. Gaps where they don't are bugs, not acceptable behavior.

**We don't add aspirational upstream-merge compatibility.** The fork's value comes from its divergence. Features that improve small-model utility are worth shipping even if they'd never land upstream. Don't weaken a fork-specific improvement to preserve a merge that will never happen.

**We don't leave half-migrated code.** If a new path supersedes an old one, commit to the full migration. Coexistence of both costs tokens, adds confusion, and erodes the codebase's clarity. Ship the migration, or ship a clear explanation of why both stay.

**We don't silence errors.** A caught exception that isn't logged, a swallowed failure that isn't surfaced to the LLM, a command that fails without explanation — all degrade the bot's ability to self-correct. Loud failures are cheaper than silent ones.

---

_When the philosophy and a proposed change conflict, the philosophy wins. When the philosophy itself feels wrong for a change, propose amending the philosophy — do not ship against it._
