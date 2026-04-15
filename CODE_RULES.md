# mindcraft-mcgavin — Code Rules

_This document defines the rules every code change must follow. Read `DESIGN_PHILOSOPHY.md` first — every rule here derives from it._

---

## Rule 1: Code must be flexible

Code that only solves today's specific instance of a problem creates tomorrow's rewrite. Prefer structures that absorb new cases by adding **data**, not by adding code branches.

### Why

Hard-coded branches compound. Each new case becomes a new `if`/`else` — the function grows, test surface explodes, and the next contributor has to understand every prior special case before adding theirs. A lookup table, classifier, or registered handler pattern takes one entry per new case.

### What "flexible" looks like

- **Lookup tables over branch chains.** If the answer to "how do I handle X" depends on X's identity, put the mapping in a table, not in a switch.
- **Classifier functions that return structured data.** The caller reacts to the classification; the classifier can be extended without touching callers.
- **Registered handlers over monolithic methods.** If five things all need the same kind of intervention, they should register themselves with a dispatcher, not appear as five inline cases in the dispatcher's body.
- **Parameters over hard-coded constants.** If a constant might need tuning per profile, per world, or per goal — make it a parameter.

### Good example

`ORE_SMELT_LOOKUP` in `src/agent/auto_recovery.js`. Adding a new ore means adding one line to the table. No new branches, no new code paths. `recoverWrongSmeltTarget` reads the group field and dispatches cleanly.

### Bad example

A recovery handler shaped like `if (attempted === 'coal_ore') { ... } else if (attempted === 'iron_ore') { ... }`. Each new ore requires a new branch. A new *category* of smelt confusion (fuel vs. final product) requires top-level restructuring instead of new entries.

If you are about to write a hard-coded branch keyed on a specific input, ask: can this be a table entry, a classifier return value, or a registered handler instead? The answer is almost always yes.

---

## Rule 2: Code must be elegant

Elegance means **clear intent, minimum necessary machinery, no cleverness for its own sake**. A reader should be able to understand what the code does by reading top to bottom, without chasing five layers of indirection.

Elegance is not brevity. A 40-line function with obvious control flow and descriptive names beats a 10-line function that encodes behavior via implicit side effects or clever chaining.

### Why

The bot's codebase is maintained mostly solo, mostly part-time, sometimes with LLM-agent collaborators who have no prior session context. Every piece of code must be legible to a person picking it up cold six weeks later. Clever code fails that test.

### What "elegant" looks like

- **One responsibility per function.** If you can't name a function in five words or fewer, it's probably doing too much.
- **Shallow call graphs for hot paths.** The main flow of a recovery, a skill, or a memory operation should read top-to-bottom, not bounce through a dozen helpers.
- **Explicit over implicit.** No magic globals mutated from afar. No inheritance when composition works.
- **Meaningful names.** `aggregated`, `goalProtected`, `junkStacks` communicate intent; `data`, `tmp`, `x` do not.

### Good example

`snapshotInventory()` in `src/utils/inventory_utils.js`. One function, four sequential priority checks (SINGLETON_KEEPS → BED_GROUP → STACK_CAPS → default), each commented. Consistent return shape. Three callers use it with zero confusion.

### Bad example

A 300-line method that handles seven cases inline with nested try/catch, mutates `this._something` in several places, and relies on execution order of side effects in callers. It may work today. The next change will be miserable.

If code feels clever, it's probably too clever.

---

## Rule 3: Code must be properly commented

Comments explain the **why**, not the **what**. The code already shows what it does. Comments exist to convey:

- Why this approach was chosen over the obvious alternative
- What invariants the code depends on (and what breaks if they're violated)
- What failure modes are expected and handled deliberately
- What upstream or architectural context the reader needs but the code can't show
- What the code is **intentionally not doing**, and why

### Why

Future-you in six weeks, or a Claude agent resuming in a fresh session, has no memory of the conversation that produced the code. The comment is the only bridge.

### Comment requirements

- **Every non-trivial function gets a docstring.** Describe contract (inputs, outputs, side effects, preconditions).
- **Every non-obvious block gets a line comment.** Especially non-obvious decisions (e.g., "skip floor check — the `remaining` cap already bounds us and a floor here was buggy for multi-stack cases").
- **Cross-reference whiteboard entries, commit hashes, or upstream issues** when context lives elsewhere.
- **Document intent alongside mechanism.** Not just "loop through items" but "drain tier-1 junk before tier-0 so bulk clears first."

### Good example

The header block on `ORE_SMELT_LOOKUP` explains what the table is, why the upstream `isSmeltable` heuristic creates the failure, what the three groups mean, and when each fires. A reader who has never seen this code before can understand and extend it.

### Bad example

```js
// loop through items
for (const item of items) {
    // check if ok
    if (check(item)) doStuff(item);
}
```

Zero context. What are items? What does `check` verify? What does `doStuff` do? Why this order? The comments are worse than no comments because they add noise without adding understanding.

Write comments for the reader who will inherit the code with zero background.

---

## Rule 4: Address the root cause, not the symptom

If a bug recurs, the fix is to understand **why** it recurs, not to paper over the symptom. Band-aids compound; root-cause fixes compose.

### Why

Every band-aid is a commitment to maintain the thing it's taped onto. Every band-aid reduces the project's conceptual clarity. Over time, a codebase full of band-aids becomes unmaintainable even when each individual patch was reasonable.

A root-cause fix eliminates an entire class of failure. A band-aid eliminates today's specific instance.

### How to find the root cause

- Ask "why" until you hit something architectural.
- "The prompt truncates" → "because it's 600 chars" → "because the LLM can't compress well" → "because we're asking it to do something it's bad at" → "because we inherited a half-finished migration and never questioned whether the call is needed." The last step is the root.
- When a fix feels like you're fighting the system, you're probably at the symptom level. Step back.

### Good example

D1 — the "Memory truncated to 500 chars" warning looked like a prompt-quality problem. Investigation revealed it was an inherited half-finished migration producing output that ContextBuilder made redundant. Fix: skip the call when ContextBuilder is on. No prompt engineering, no retry logic, no post-processor. The class of failure was eliminated.

### Bad example

The path we deliberately rejected for D1: rewrite the `saving_memory` prompt with better examples, ship, observe warning persists, add a retry loop, ship, observe warning still persists on edge cases, add a deterministic post-processor, ship, realize the call wasn't necessary in the first place. Four commits of band-aids where one root-cause fix did it.

If you are tempted to ship a fix that works around a problem rather than eliminates it, stop and ask: is the problem I'm working around actually avoidable entirely? Often yes.

---

## Rule 5: No adverse effects on other code

A change is not done when it does what it's supposed to. A change is done when it **also doesn't break anything else**.

### Pre-ship verification checklist

- **Syntax check passes.** `node --check <file>` for JS, `python3 -c "import json; json.load(open('<file>'))"` for JSON, etc.
- **Diff against live looks like what you intended.** No unrelated reformatting, no accidental deletions, no JSON round-trip damage.
- **If you touched a shared utility, every caller still works.** Trace every call site.
- **If you removed a placeholder or constant, every template/caller that referenced it still makes sense.**
- **If you added a new code path, existing paths are untouched.** No regressions hidden inside a "while I'm here" change.
- **Post-deploy verification.** After deploy + restart, confirm the change actually took effect and nothing adjacent broke. A log line absent, a warning gone, a feature firing — concrete evidence.

### Good example

D1 removed `$MEMORY` from the coding template surgically. Conversing template untouched (even though ContextBuilder bypasses it — leaves a safety net). `replaceStrings()` `$MEMORY` resolution left intact for any other path. Three files changed, each change minimal, each verified in isolation.

### Bad example

Round-tripping a JSON file through `json.load` + `json.dump` to "clean up formatting" while making a one-line functional change — the resulting 800-line whitespace diff masks the actual change and makes review impossible. (We hit this today and redid it with a surgical string replace.)

Small, targeted commits with clean diffs are a code-quality rule, not an aesthetic preference.

---

## Rule 6: Adhere to DESIGN_PHILOSOPHY.md

If a change conflicts with the design philosophy, **it does not ship** — regardless of whether it works.

### Examples of philosophy-conflicts that block a change

- A change that increases LLM reliance without a corresponding capability gain — violates Principle 1.
- A change that stores state in-process-only when it should persist across sessions — violates Principle 4.
- A change that leaves a half-finished migration — violates Principle 5.
- A change that silently swallows an error — violates Principle 8.
- A prompt rewrite where a code fix would eliminate the problem — violates Anti-philosophy.

### What to do when a change you need would violate the philosophy

Do not ship the change. Either:

1. **Redesign the change** so it aligns with the philosophy (usually possible — the philosophy was written to describe decisions that actually work).
2. **Propose amending the philosophy.** If the philosophy is genuinely wrong for this case, write up why, discuss, and update `DESIGN_PHILOSOPHY.md` before shipping the change that depends on the amendment.

Never ship a change in silent violation of the philosophy. That's how codebases rot.

---

## Rule 7: Complete the perimeter

When your change establishes an **invariant that must hold across the codebase** — e.g., "no block modification inside a protected zone," "no LLM call without the bot mutex," "no file I/O without graceful fallback" — you must audit every code path that could violate the invariant. An invariant enforced at one gate only holds if every caller routes through that gate.

### Why

Protection mechanisms fail at the edges: one forgotten callsite, one internal path that skips the guard, one sibling function that replicated logic instead of delegating. The gate works for the paths you tested. The paths you didn't think about keep doing what they always did.

Rule 5 catches breakage of **existing** code. Rule 7 catches **incomplete coverage of new** code. They're different failure modes. A protection with 95% coverage is more dangerous than no protection — it gives false confidence.

### Pre-ship checklist when introducing an invariant

1. **Name the invariant explicitly** in the plan and commit message. Example: "Every block-mutation call must consult `_isInAnyProtectedZone` before proceeding."
2. **Enumerate every path that could violate it.** Grep the codebase for the operations the invariant constrains — `bot.dig`, `bot.placeBlock`, `bot.toss`, etc. Don't trust your mental model; use the text.
3. **Verify each path.** For each callsite, confirm it either (a) routes through the central guard, or (b) has its own inline guard with equivalent effect.
4. **Document the audit** in the commit message. List the callsites you found and how each is covered. A future maintainer should be able to re-run the audit in 30 seconds.

### Good example

_To be filled once we've applied this rule successfully. Today's work is all bad examples — the rule exists because we didn't follow it._

### Bad example

The #7 ProtectedZone shipment (commit `a73e53b`) wired `_isInAnyProtectedZone` into `breakBlockAt`, `placeBlock`, `safeToss`, and `autoBreakStuckPlant`. The Rule 5 audit stopped there. `collectBlock` called `bot.dig` and `bot.collectBlock.collect` **directly** without going through `breakBlockAt`, so `!collectBlocks("grass_block", 10)` inside spawn ran without any protection check. JP observed the bot breaking `grass_block` in the spawn zone post-deploy. A single `grep 'bot\.dig\|bot\.collectBlock\.collect' src/` before shipping would have surfaced the gap. Fixed post-hoc in commit `cde1329`.

### Patch pattern when an incomplete perimeter is discovered

1. Fix the specific leak that was reported.
2. **Run the same grep across the whole codebase** — not just the one site. Often a second or third leak is waiting in adjacent code.
3. Log the audit in the fix commit so the perimeter is now known to be complete.
4. If the invariant is likely to be violated again by future additions, consider adding a test or lint rule that makes the invariant enforceable mechanically.

---

## Workflow hygiene (supports the rules above)

These aren't rules about the code itself — they're rules about how we introduce code changes, so that the rules above stay enforceable.

- **One concern per commit.** Inventory overhaul + whiteboard update + unrelated WIP in one commit is hard to review and harder to revert. Separate commits, each doing one thing.
- **Commit messages explain the why.** "Fix bug" is not a commit message. "Remove `$MEMORY` from coding template — ContextBuilder bypasses it and the legacy summary was the only consumer" is.
- **Whiteboard updates ship alongside the code they describe**, either in the same commit or an adjacent one cross-referenced by hash.
- **Verify post-deploy.** Restart the bot. Check the log. Confirm the change took effect. A commit is not "done" until it's been observed running.
- **Clean diffs only.** If your diff contains unrelated changes, split them. If your diff contains whitespace noise, remove it before committing.

---

_These rules serve the philosophy. When a rule stops serving the philosophy, update the rule._
