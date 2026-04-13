/**
 * Context Builder — Token-budgeted prompt assembly.
 *
 * Replaces the "dump everything" approach in prompter.replaceStrings() with
 * an intelligent prompt assembler that fits content into a token budget.
 *
 * Priority order (highest to lowest):
 *   1. Bot identity + rules + current goal (from profile, always included)
 *   2. Current action status
 *   3. Delta state (compact game state changes)
 *   4. Command docs (goal-filtered, fewer = better for small models)
 *   5. Recent conversation turns (compressed in self-prompt mode)
 *   6. Episodic + long-term memories (replaces legacy 500-char summary)
 *   7. Few-shot examples (0 when self-prompting, 1-2 with players)
 *
 * Token estimation uses a simple chars/4 heuristic (good enough for
 * most models; LM Studio with Gemma averages ~3.5 chars/token).
 */

export class ContextBuilder {
    constructor(options = {}) {
        // Token budget (chars ≈ tokens * 4)
        this.maxTokens = options.maxTokens || 4096;
        this.charsPerToken = options.charsPerToken || 4;
        this.maxChars = this.maxTokens * this.charsPerToken;

        // Reserve space for the LLM response
        this.responseReserve = options.responseReserve || 512;
        this.availableChars = this.maxChars - (this.responseReserve * this.charsPerToken);

        // Minimum allocations (chars) for each section
        this.minConversation = options.minConversation || 800;  // ~200 tokens for recent turns
        this.minState = options.minState || 400;                // ~100 tokens for state
        this.minCommands = options.minCommands || 600;          // ~150 tokens for command docs

        // Stats
        this.lastBuild = null;
    }

    /**
     * Build a complete prompt context within the token budget.
     *
     * @param {object} params
     * @param {string} params.botName - Bot's name
     * @param {string} params.goal - Current self-prompt goal (or null)
     * @param {string} params.action - Current action label
     * @param {string} params.deltaState - Output from DeltaStateTracker
     * @param {Array} params.turns - Recent conversation turns
     * @param {string} params.commandDocs - Filtered command docs string
     * @param {string} params.episodicMemory - Formatted episodic memories
     * @param {string} params.longTermMemory - Formatted long-term knowledge
     * @param {string} params.examples - Formatted few-shot examples
     * @param {boolean} params.isSelfPrompting - Whether the bot is in self-prompt mode
     * @param {object} params.profile - Bot profile JSON (for identity/rules)
     * @returns {object} { systemPrompt: string, stats: object }
     */
    build(params) {
        const sections = [];
        let usedChars = 0;
        const isSP = params.isSelfPrompting || false;
        const stats = {
            totalBudget: this.availableChars,
            sections: {}
        };

        // --- PRIORITY 1: Identity + Rules + Goal (always included) ---
        const identity = this._buildIdentity(params.botName, params.goal, params.profile);
        sections.push(identity);
        usedChars += identity.length;
        stats.sections.identity = identity.length;

        // --- PRIORITY 2: Current action (small, always included) ---
        if (params.action && params.action !== 'Idle') {
            const actionStr = `Current action: ${params.action}\n`;
            sections.push(actionStr);
            usedChars += actionStr.length;
            stats.sections.action = actionStr.length;
        }

        // --- PRIORITY 3: Delta state (compact, high value) ---
        const stateStr = params.deltaState || '';
        if (stateStr.length > 0) {
            const stateBudget = Math.max(this.minState, stateStr.length);
            const trimmedState = stateStr.substring(0, stateBudget);
            sections.push(trimmedState + '\n');
            usedChars += trimmedState.length + 1;
            stats.sections.state = trimmedState.length + 1;
        }

        // --- PRIORITY 3.5: Nearby notable blocks (high value for mining decisions) ---
        const nearbyStr = params.nearbyBlocks || '';
        if (nearbyStr.length > 0) {
            sections.push(nearbyStr + '\n');
            usedChars += nearbyStr.length + 1;
            stats.sections.nearbyBlocks = nearbyStr.length + 1;
        }

        // --- PRIORITY 4: Command docs (goal-filtered, high value) ---
        const cmdBudget = Math.min(
            this.minCommands + Math.floor((this.availableChars - usedChars) * 0.25),
            this.availableChars - usedChars - this.minConversation
        );
        if (params.commandDocs && cmdBudget > 200) {
            const cmdStr = this._trimToFit(params.commandDocs, cmdBudget);
            sections.push(cmdStr + '\n');
            usedChars += cmdStr.length + 1;
            stats.sections.commands = cmdStr.length + 1;
        }

        // --- PRIORITY 5: Conversation turns (compressed in self-prompt mode) ---
        const remaining = this.availableChars - usedChars;
        const convoBudget = Math.max(this.minConversation, Math.floor(remaining * 0.45));
        const convoStr = this._buildConversation(params.turns, convoBudget, isSP);
        if (convoStr.length > 0) {
            sections.push(convoStr);
            usedChars += convoStr.length;
            stats.sections.conversation = convoStr.length;
        }

        // --- PRIORITY 6: Episodic + long-term memory (replaces legacy summary) ---
        const memBudget = Math.min(
            Math.floor((this.availableChars - usedChars) * 0.6),
            this.availableChars - usedChars
        );
        if (memBudget > 100) {
            let memParts = [];
            if (params.episodicMemory) memParts.push(params.episodicMemory);
            if (params.longTermMemory) memParts.push(params.longTermMemory);
            // NOTE: legacy memory intentionally excluded — episodic replaces it

            let memStr = memParts.join('\n');
            if (memStr.length > 0) {
                memStr = this._trimToFit(memStr, memBudget);
                sections.push(memStr + '\n');
                usedChars += memStr.length + 1;
                stats.sections.memory = memStr.length + 1;
            }
        }

        // --- PRIORITY 7: Examples (skip during self-prompting, use 1-2 with players) ---
        // When self-prompting, episodic memories serve as better "examples" than static ones.
        // Only include examples when talking to a player and episodic memory is thin.
        const hasEpisodicContext = (params.episodicMemory || '').length > 50;
        const includeExamples = !isSP && (!hasEpisodicContext || !params.episodicMemory);

        if (includeExamples && params.examples) {
            const exBudget = this.availableChars - usedChars;
            if (exBudget > 200) {
                const exStr = this._trimToFit(params.examples, exBudget);
                sections.push(exStr);
                usedChars += exStr.length;
                stats.sections.examples = exStr.length;
            }
        }

        stats.usedChars = usedChars;
        stats.usedTokens = Math.ceil(usedChars / this.charsPerToken);
        stats.remainingTokens = Math.ceil((this.availableChars - usedChars) / this.charsPerToken);
        stats.selfPrompting = isSP;

        this.lastBuild = stats;

        return {
            systemPrompt: sections.join('\n'),
            stats
        };
    }

    /**
     * Build the identity/personality section from the bot profile.
     * Reads `context_rules` from profile for customizable rules per bot.
     * Falls back to a sensible default if not present.
     */
    _buildIdentity(botName, goal, profile) {
        // Base identity — always present
        let identity = `You are a Minecraft bot named ${botName}. Use commands to act.\n`;

        // Rules — read from profile, or use default strategic knowledge
        const rules = profile?.context_rules ||
            `RULES: Tool progression: wood→stone→iron→diamond pickaxe. Need pickaxe for stone/ore. Need crafting_table for tools (craft from 4 planks). Diamond ore only below y=16. Smelt raw_iron in furnace→iron_ingot before crafting. If inventory full: !autoDiscard(5). Use !getCraftingPlan to check requirements before crafting.`;
        identity += rules + '\n';

        // Personality — compact
        identity += `Be brief. Use commands, don't describe actions. Respond only as ${botName}. Only use tab '\\t' when self-prompting and there's nothing to do.\n`;
        identity += `IMPORTANT: When a player talks to you, ALWAYS respond to them conversationally FIRST (in plain text), then optionally add a command after. Never ignore a player message. If they ask you to do something, acknowledge it before acting.\n`;

        if (goal) {
            identity += `GOAL: "${goal}"\n`;
        }

        return identity;
    }

    /**
     * Build conversation string from turns, fitting within budget.
     * In self-prompt mode, strips fluff — keeps only commands and their results.
     * In conversation mode, keeps full turns for natural dialogue.
     */
    _buildConversation(turns, budget, selfPrompting = false) {
        if (!turns || turns.length === 0) return '';

        const lines = [];
        let totalLen = 'Conversation:\n'.length;

        // Work backwards from most recent
        for (let i = turns.length - 1; i >= 0; i--) {
            const turn = turns[i];
            let content = turn.content;

            if (selfPrompting) {
                // Strip repeated self-prompt reminders — they waste tokens
                if (turn.role === 'system' && content.includes('self-prompting with the goal')) continue;

                // Strip assistant turns that are just chatter (no command)
                if (turn.role === 'assistant' && !content.includes('!') && content !== '\\t') continue;

                // Compress system action output — strip "Action output:\n" prefix
                if (turn.role === 'system' && content.startsWith('Action output:\n')) {
                    content = content.replace('Action output:\n', '');
                }
            }

            const prefix = turn.role === 'assistant' ? 'You' :
                          turn.role === 'system' ? 'System' : 'User';
            const line = `${prefix}: ${content}`;

            if (totalLen + line.length + 1 > budget) break;

            lines.unshift(line);
            totalLen += line.length + 1;
        }

        if (lines.length === 0) return '';
        return 'Conversation:\n' + lines.join('\n') + '\n';
    }

    /**
     * Trim content to fit within a character budget, breaking at line boundaries.
     */
    _trimToFit(text, budget) {
        if (text.length <= budget) return text;

        // Try to break at a newline
        const trimmed = text.substring(0, budget);
        const lastNewline = trimmed.lastIndexOf('\n');
        if (lastNewline > budget * 0.5) {
            return trimmed.substring(0, lastNewline);
        }
        return trimmed;
    }

    /**
     * Get stats from the last build for monitoring.
     */
    getLastBuildStats() {
        return this.lastBuild;
    }
}
