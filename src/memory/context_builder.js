/**
 * Context Builder — Token-budgeted prompt assembly.
 *
 * Replaces the "dump everything" approach in prompter.replaceStrings() with
 * an intelligent prompt assembler that fits content into a token budget.
 *
 * Priority order (highest to lowest):
 *   1. Bot identity + current goal (always included)
 *   2. Current action status
 *   3. Delta state (compact game state changes)
 *   4. Recent conversation turns (working memory)
 *   5. Relevant command docs (not all 35+)
 *   6. Episodic memories (semantically relevant)
 *   7. Few-shot examples (reduced for simple tasks)
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
     * @param {string} params.commandDocs - Full command docs string
     * @param {string} params.episodicMemory - Formatted episodic memories
     * @param {string} params.legacyMemory - Legacy 500-char summary
     * @param {string} params.examples - Formatted few-shot examples
     * @returns {object} { systemPrompt: string, stats: object }
     */
    build(params) {
        const sections = [];
        let usedChars = 0;
        const stats = {
            totalBudget: this.availableChars,
            sections: {}
        };

        // --- PRIORITY 1: Identity + Goal (always included, ~100-300 chars) ---
        const identity = this._buildIdentity(params.botName, params.goal);
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
            sections.push('Game state:\n' + trimmedState + '\n');
            usedChars += trimmedState.length + 13;
            stats.sections.state = trimmedState.length + 13;
        }

        // --- PRIORITY 4: Conversation turns (working memory) ---
        const remaining = this.availableChars - usedChars;
        const convoBudget = Math.min(
            Math.max(this.minConversation, Math.floor(remaining * 0.35)),
            remaining - this.minCommands // leave room for commands
        );
        const convoStr = this._buildConversation(params.turns, convoBudget);
        if (convoStr.length > 0) {
            sections.push(convoStr);
            usedChars += convoStr.length;
            stats.sections.conversation = convoStr.length;
        }

        // --- PRIORITY 5: Command docs (filtered if possible) ---
        const cmdBudget = Math.min(
            this.minCommands + Math.floor((this.availableChars - usedChars) * 0.3),
            this.availableChars - usedChars
        );
        if (params.commandDocs && cmdBudget > 200) {
            const cmdStr = this._trimToFit(params.commandDocs, cmdBudget);
            sections.push(cmdStr + '\n');
            usedChars += cmdStr.length + 1;
            stats.sections.commands = cmdStr.length + 1;
        }

        // --- PRIORITY 6: Episodic + legacy memory ---
        const memBudget = Math.min(
            Math.floor((this.availableChars - usedChars) * 0.4),
            this.availableChars - usedChars
        );
        if (memBudget > 100) {
            let memStr = '';
            if (params.episodicMemory) {
                memStr = params.episodicMemory;
            }
            if (params.legacyMemory && params.legacyMemory.length > 0) {
                memStr = memStr
                    ? memStr + '\nSummary: ' + params.legacyMemory
                    : 'Memory: ' + params.legacyMemory;
            }
            if (memStr.length > 0) {
                memStr = this._trimToFit(memStr, memBudget);
                sections.push(memStr + '\n');
                usedChars += memStr.length + 1;
                stats.sections.memory = memStr.length + 1;
            }
        }

        // --- PRIORITY 7: Examples (reduced when confidence is high) ---
        const exBudget = this.availableChars - usedChars;
        if (params.examples && exBudget > 200) {
            const exStr = this._trimToFit(params.examples, exBudget);
            sections.push(exStr);
            usedChars += exStr.length;
            stats.sections.examples = exStr.length;
        }

        stats.usedChars = usedChars;
        stats.usedTokens = Math.ceil(usedChars / this.charsPerToken);
        stats.remainingTokens = Math.ceil((this.availableChars - usedChars) / this.charsPerToken);

        this.lastBuild = stats;

        return {
            systemPrompt: sections.join('\n'),
            stats
        };
    }

    /**
     * Build the identity/personality section.
     */
    _buildIdentity(botName, goal) {
        let identity = `You are an AI Minecraft bot named ${botName} that can converse with players, see, move, mine, build, and interact with the world by using commands.\n`;
        identity += `Be a friendly, casual, effective, and efficient robot. Be very brief in your responses, don't apologize constantly, don't give instructions or make lists unless asked, and don't refuse requests. Don't pretend to act, use commands immediately when requested. Respond only as ${botName}. If you have nothing to say or do, respond with just a tab '\\t'.\n`;

        if (goal) {
            identity += `YOUR CURRENT ASSIGNED GOAL: "${goal}"\n`;
        }

        return identity;
    }

    /**
     * Build conversation string from turns, fitting within budget.
     * Keeps the most recent turns first (most relevant).
     */
    _buildConversation(turns, budget) {
        if (!turns || turns.length === 0) return '';

        const lines = [];
        let totalLen = 'Conversation:\n'.length;

        // Work backwards from most recent
        for (let i = turns.length - 1; i >= 0; i--) {
            const turn = turns[i];
            const prefix = turn.role === 'assistant' ? 'You' :
                          turn.role === 'system' ? 'System' : 'User';
            const line = `${prefix}: ${turn.content}`;

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
