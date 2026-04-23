/**
 * Humanized post-command delays (whiteboard item #8).
 *
 * Adds a per-command artificial delay after `executeCommand` runs, so the bot
 * doesn't fire commands back-to-back at LLM-and-mineflayer wire speed. Two
 * goals:
 *
 *   1. **Anti-cheat resilience.** Many public Minecraft servers flag accounts
 *      that mine / place / interact faster than a human could physically
 *      click. Even on JP's private server this keeps the bot habitable if
 *      the profile is ever used elsewhere.
 *
 *   2. **Less robotic feel.** The bot's "think-then-act" loop is already
 *      gated by LLM latency, but the action burst after the LLM replies
 *      still looks programmatic. A 1–6s jittered post-command pause reads
 *      as "the bot paused to see what it did, then moved on."
 *
 * **Scope.** Applied only inside `executeCommand` at
 * `src/agent/commands/index.js`. Mode-triggered reflexes (self_preservation,
 * self_defense, drowning-escape BT-10g, shield-auto-raise BT-10e, turtle-
 * helmet auto-equip BT-2-L3) call bot/skill methods directly and never pass
 * through `executeCommand` — they stay instant by construction, which is
 * correct: combat and drowning need millisecond response.
 *
 * **Instant allowlist.** Emergency and meta commands return 0 ms regardless
 * of category — `!stop` and `!stfu` especially, because humans (or the
 * LLM's own safety loop) may need to abort the bot mid-action and expect
 * no artificial delay on the kill-switch.
 *
 * **Unknown-command fallback.** If a command name isn't in any category
 * (for example, a newly registered command that hasn't been classified
 * here yet), the default range is the movement tier (2000–3000 ms). This
 * is deliberate: it means the module degrades gracefully if the actions.js
 * registry drifts out of sync with this table.
 */

// Emergency / meta commands — instant response. These either abort the bot,
// change conversational mode, or just answer a question with no world-side
// effect. A human typing !stop in chat should not wait 3 seconds.
const INSTANT = new Set([
    '!stop',
    '!stfu',
    '!restart',
    '!clearChat',
    '!endGoal',
    '!endConversation',
    '!setMode',
    '!botMode',
    '!addRule',
    '!removeRule',
    '!viewRules',
    '!help',
    '!viewGoals',
]);

// Trivial — read-only world / state queries. 1–2s reads as "bot looked,
// then answered" rather than instant polling.
const TRIVIAL = new Set([
    '!stats',
    '!inventory',
    '!nearbyBlocks',
    '!entities',
    '!craftable',
    '!savedPlaces',
    '!checkBlueprintLevel',
    '!checkBlueprint',
    '!getBlueprint',
    '!getBlueprintLevel',
    '!getCraftingPlan',
    '!viewChest',
    '!showVillagerTrades',
    '!lookAtPlayer',
    '!lookAtPosition',
    '!rememberHere',
    '!goal',
    '!addGoal',
    '!autoDiscard',
    '!stay',
]);

// Movement — bot physically travels to or away from something.
// 2–3s reads as "one beat of hesitation before moving."
const MOVEMENT = new Set([
    '!goToPlayer',
    '!followPlayer',
    '!goToCoordinates',
    '!goToRememberedPlace',
    '!moveAway',
    '!searchForBlock',
    '!searchForEntity',
    '!goToBed',
    '!goToSurface',
]);

// Gather / craft / manipulate — physical interaction with the world.
// 3–5s covers the anti-cheat case (too-fast mining / placing is the classic
// trigger pattern on public servers).
const GATHER_CRAFT = new Set([
    '!collectBlocks',
    '!craftRecipe',
    '!smeltItem',
    '!clearFurnace',
    '!placeHere',
    '!tillHere',
    '!activate',
    '!equip',
    '!replaceBrokenArmor',
    '!discard',
    '!consume',
    '!useOn',
    '!givePlayer',
    '!putInChest',
    '!takeFromChest',
    '!digDown',
    '!digUp',
]);

// Complex — arbitrary code exec, combat, trading, social. 4–6s — these
// actions are the most "deliberate" in-game and benefit most from the pause.
const COMPLEX = new Set([
    '!newAction',
    '!attack',
    '!attackPlayer',
    '!tradeWithVillager',
    '!startConversation',
    '!searchWiki',
]);

// Default range when a command isn't classified. Movement tier — middle of
// the road, safe if the actions.js registry grows.
const UNKNOWN_RANGE = [2000, 3000];

/**
 * Classify a command name into its delay range, or null for instant.
 * Accepts names with or without the leading `!`.
 *
 * @param {string} commandName
 * @returns {[number, number] | null}
 */
function _rangeFor(commandName) {
    if (!commandName || typeof commandName !== 'string') return UNKNOWN_RANGE;
    const name = commandName.startsWith('!') ? commandName : '!' + commandName;
    if (INSTANT.has(name)) return null;
    if (TRIVIAL.has(name)) return [1000, 2000];
    if (MOVEMENT.has(name)) return [2000, 3000];
    if (GATHER_CRAFT.has(name)) return [3000, 5000];
    if (COMPLEX.has(name)) return [4000, 6000];
    return UNKNOWN_RANGE;
}

/**
 * Post-command delay in milliseconds for a given command name.
 * Returns 0 for instant commands.
 *
 * @param {string} commandName - e.g. "!goToCoordinates" or "goToCoordinates"
 * @returns {number} delay in ms
 */
export function getHumanDelay(commandName) {
    const range = _rangeFor(commandName);
    if (!range) return 0;
    const [lo, hi] = range;
    return Math.floor(lo + Math.random() * (hi - lo));
}
