import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs, getFilteredCommandDocs, initCommandDocEmbeddings } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns, stripThinkTags } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { DeltaStateTracker } from '../memory/delta_state.js';
import { getFullState } from '../agent/library/full_state.js';
import { ContextBuilder } from '../memory/context_builder.js';
import { GenerationLock, Priority } from '../agent/generation_lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;

        // Defaults + base profile fill missing fields in the individual profile. If
        // either file is missing or malformed, degrade to {} so the bot can still
        // start from a fully-specified individual profile (ThatCoolGuyDude.json). A
        // typo or missing file here used to crash the process at startup.
        let default_profile = {};
        try {
            default_profile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        } catch (e) {
            console.warn('[Prompter] ./profiles/defaults/_default.json load failed, using empty defaults:', e.message);
        }
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = './profiles/defaults/survival.json';
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = './profiles/defaults/assistant.json';
        } else if (settings.base_profile.includes('creative')) {
            base_fp = './profiles/defaults/creative.json';
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = './profiles/defaults/god_mode.json';
        }
        let base_profile = {};
        try {
            base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));
        } catch (e) {
            console.warn(`[Prompter] ${base_fp || '(no base profile matched settings.base_profile)'} load failed, using empty base:`, e.message);
        }

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;
        this.awaiting_response = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        if (this.profile.url) chat_model_profile.url = this.profile.url;
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        // Fast model for simple tasks (query responses, high-confidence hints)
        // Falls back to chat_model if not configured
        if (this.profile.fast_model) {
            try {
                let fast_model_profile = selectAPI(this.profile.fast_model);
                this.fast_model = createModel(fast_model_profile);
            } catch (e) {
                console.warn('Failed to initialize fast_model, falling back to chat_model:', e.message);
                this.fast_model = this.chat_model;
            }
        }
        else {
            this.fast_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            this.embedding_model = createModel({api: chat_model_profile.api});
        }

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        this.deltaState = new DeltaStateTracker();
        this.contextBuilder = new ContextBuilder(settings.context_builder || {});
        this.generationLock = new GenerationLock();
        mkdirSync(`./bots/${name}`, { recursive: true });
        // BT-bundle(c): sync writeFileSync does not accept a callback — the
        // previous `(err) => throw ...` arrow was silently discarded by Node,
        // so a real write failure (ENOSPC, EACCES) would escape as an uncaught
        // throw with no structured log. Wrap in try/catch with [Prompter] log
        // and re-throw so the caller still sees the failure.
        try {
            writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4));
            console.log("Copy profile saved.");
        } catch (err) {
            console.error(`[Prompter] Failed to save profile ./bots/${name}/last_profile.json: ${err.message}`);
            throw err;
        }
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for examples, skill library, and command doc embeddings to load
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary(),
                initCommandDocEmbeddings(this.embedding_model)
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS') || prompt.includes('$INVENTORY')) {
            // Delta state: use compact diff instead of full dumps when enabled
            if (settings.use_delta_state !== false && this.deltaState) {
                try {
                    const fullState = getFullState(this.agent);
                    const deltaOutput = this.deltaState.update(fullState);
                    if (prompt.includes('$STATS'))
                        prompt = prompt.replaceAll('$STATS', deltaOutput);
                    if (prompt.includes('$INVENTORY'))
                        prompt = prompt.replaceAll('$INVENTORY', ''); // included in delta output
                } catch (err) {
                    console.warn('[DeltaState] Error, falling back to full state:', err.message);
                    // Fallback to original behavior
                    let stats = await getCommand('!stats').perform(this.agent) + '\n';
                    stats += await getCommand('!entities').perform(this.agent) + '\n';
                    stats += await getCommand('!nearbyBlocks').perform(this.agent);
                    if (prompt.includes('$STATS'))
                        prompt = prompt.replaceAll('$STATS', stats);
                    if (prompt.includes('$INVENTORY')) {
                        let inventory = await getCommand('!inventory').perform(this.agent);
                        prompt = prompt.replaceAll('$INVENTORY', inventory);
                    }
                }
            } else {
                // Original behavior when delta state is disabled
                if (prompt.includes('$STATS')) {
                    let stats = await getCommand('!stats').perform(this.agent) + '\n';
                    stats += await getCommand('!entities').perform(this.agent) + '\n';
                    stats += await getCommand('!nearbyBlocks').perform(this.agent);
                    prompt = prompt.replaceAll('$STATS', stats);
                }
                if (prompt.includes('$INVENTORY')) {
                    let inventory = await getCommand('!inventory').perform(this.agent);
                    prompt = prompt.replaceAll('$INVENTORY', inventory);
                }
            }
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS')) {
            // Use filtered command docs when possible — only relevant commands for context
            if (settings.use_filtered_commands !== false && this.embedding_model && messages?.length > 0) {
                try {
                    const contextQuery = this._getContextQuery(messages);
                    const filteredDocs = await getFilteredCommandDocs(
                        this.agent,
                        contextQuery,
                        this.embedding_model,
                        settings.relevant_commands_count || 8
                    );
                    prompt = prompt.replaceAll('$COMMAND_DOCS', filteredDocs);
                } catch (err) {
                    console.warn('[Prompter] Filtered command docs failed, using full docs:', err.message);
                    prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
                }
            } else {
                prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
            }
        }
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY')) {
            // #27 (2026-04-20): Finish D1 consumer teardown under CB.
            //   - `history.memory` is '' under CB (load skipped — see history.js).
            //   - Episodic + long-term memory are already injected by
            //     `_buildContextPrompt` at priority 6; running the legacy episodic
            //     fetch here would double-inject the same content in CB-fallback
            //     and `promptConvoFast` paths, which both still use replaceStrings.
            //   - Profiles (e.g. ThatCoolGuyDude.json) had the
            //     `Summarized memory:'$MEMORY'` line stripped; this short-circuit
            //     is the defense-in-depth for any legacy-shaped profile that
            //     still references the token.
            // Legacy non-CB path preserved verbatim below.
            if (settings.use_context_builder) {
                prompt = prompt.replaceAll('$MEMORY', '');
            } else {
                // #21 L1.4 context (pre-#27): this was the original combined path
                // mixing legacy 500-char summary with episodic memory retrieval.
                let memoryText = this.agent.history.memory;
                try {
                    if (this.agent.history.episodic && messages?.length > 0) {
                        const contextQuery = this._getContextQuery(messages);
                        const episodicText = await this.agent.history.episodic.getFormattedMemories(
                            contextQuery
                        );
                        if (episodicText) {
                            memoryText = memoryText
                                ? memoryText + '\n' + episodicText
                                : episodicText;
                        }
                    }
                } catch (err) {
                    console.warn('[Prompter] Episodic memory retrieval failed:', err.message);
                }
                prompt = prompt.replaceAll('$MEMORY', memoryText);
            }
        }
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = '';
            if (!this.agent.self_prompter.isStopped()) {
                self_prompt = `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n`;
                const queue = this.agent.self_prompter.goalQueue || [];
                if (queue.length > 0) {
                    self_prompt += `QUEUED GOALS (work on these in order after current goal):\n`;
                    queue.forEach((g, i) => { self_prompt += `  ${i + 1}. ${g}\n`; });
                }
            }
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    /**
     * Build a context query string from the current goal + last message.
     * Used by context-aware placeholders ($COMMAND_DOCS, $MEMORY) and ContextBuilder
     * to retrieve semantically relevant content.
     */
    _getContextQuery(messages) {
        const goalCtx = !this.agent.self_prompter.isStopped()
            ? this.agent.self_prompter.prompt + ' ' : '';
        const lastMsg = messages?.[messages.length - 1]?.content || '';
        return goalCtx + lastMsg;
    }

    /**
     * Build a system prompt using the ContextBuilder instead of template replacement.
     * Opt-in via settings.use_context_builder = true.
     * Assembles a token-budgeted prompt from all available context.
     */
    async _buildContextPrompt(messages) {
        try {
            const agent = this.agent;
            const isSelfPrompting = !agent.self_prompter.isStopped();
            const goal = isSelfPrompting ? agent.self_prompter.prompt : null;
            const action = agent.actions.currentActionLabel || 'Idle';

            // Delta state
            let deltaState = '';
            try {
                const fullState = getFullState(agent);
                deltaState = this.deltaState.update(fullState);
            } catch (e) {
                console.warn('[ContextBuilder] Delta state failed:', e.message);
            }

            // Command docs — fewer when self-prompting (goal-focused), more when chatting
            const contextQuery = this._getContextQuery(messages);
            const cmdCount = isSelfPrompting
                ? Math.min(settings.relevant_commands_count || 8, 5)  // tighter during goals
                : settings.relevant_commands_count || 8;
            let commandDocs = '';
            try {
                if (settings.use_filtered_commands !== false && this.embedding_model && messages?.length > 0) {
                    commandDocs = await getFilteredCommandDocs(agent, contextQuery, this.embedding_model, cmdCount);
                } else {
                    commandDocs = getCommandDocs(agent);
                }
            } catch (e) {
                commandDocs = getCommandDocs(agent);
            }

            // Episodic memory
            let episodicMemory = '';
            try {
                if (agent.history.episodic && messages?.length > 0) {
                    episodicMemory = await agent.history.episodic.getFormattedMemories(contextQuery) || '';
                }
            } catch (e) { /* silent */ }

            // Long-term memory (persistent knowledge across sessions)
            let longTermMemory = '';
            try {
                if (agent.long_term_memory && contextQuery) {
                    longTermMemory = await agent.long_term_memory.getFormattedKnowledge(contextQuery) || '';
                }
            } catch (e) { /* silent */ }

            // Examples — ContextBuilder will skip these during self-prompting
            let examples = '';
            try {
                if (this.convo_examples) {
                    examples = await this.convo_examples.createExampleMessage(messages);
                }
            } catch (e) { /* silent */ }

            // Nearby blocks — run the full !nearbyBlocks command like upstream does
            // This gives the LLM block awareness every turn without wasting a command
            let nearbyBlocks = '';
            try {
                nearbyBlocks = await getCommand('!nearbyBlocks').perform(agent);
                if (nearbyBlocks) nearbyBlocks = nearbyBlocks.trim();
                console.log('[NearbyBlocks] ' + (nearbyBlocks ? nearbyBlocks.replace(/\n/g, ' | ') : '(empty)'));
            } catch (e) {
                console.warn('[ContextBuilder] nearbyBlocks failed:', e.message);
            }

            const goalQueue = agent.self_prompter.goalQueue || [];
            const { systemPrompt, stats } = this.contextBuilder.build({
                botName: agent.name,
                goal,
                goalQueue,
                action,
                deltaState,
                nearbyBlocks,
                turns: messages,
                commandDocs,
                episodicMemory,
                longTermMemory,
                examples,
                isSelfPrompting,
                profile: this.profile
            });

            console.log(`[ContextBuilder] ${stats.usedTokens}/${Math.ceil(this.contextBuilder.availableChars / this.contextBuilder.charsPerToken)} tokens | conv:${stats.sections.conversation || 0} cmd:${stats.sections.commands || 0} mem:${stats.sections.memory || 0} ex:${stats.sections.examples || 0} nb:${stats.sections.nearbyBlocks || 0} | SP:${isSelfPrompting}`);
            return systemPrompt;
        } catch (err) {
            console.warn('[ContextBuilder] Failed, falling back to replaceStrings:', err.message);
            const fallbackPrompt = await this.replaceStrings(
                this.profile.conversing, messages, this.convo_examples
            );
            return fallbackPrompt;
        }
    }

    /**
     * Fast prompt path for MEDIUM confidence situations.
     * Uses fast_model with a stripped-down prompt (no examples, no code docs).
     * Falls back to full promptConvo on error.
     */
    async promptConvoFast(messages, hint = '') {
        if (this.fast_model === this.chat_model) {
            // No separate fast model configured, use normal path
            return this.promptConvo(messages, Priority.PLAYER);
        }

        await this.checkCooldown();
        try {
            let prompt = this.profile.conversing;
            // Minimal replacement: identity, stats, inventory, commands (no examples)
            prompt = await this.replaceStrings(prompt, messages, null);
            if (hint) {
                prompt += '\n' + hint;
            }

            console.log('[FastModel] Sending to fast model...');
            let generation = await this.fast_model.sendRequest(messages, prompt);

            if (typeof generation !== 'string' || generation.includes('(FROM OTHER BOT)')) {
                console.warn('[FastModel] Bad response, falling back to full model.');
                return this.promptConvo(messages, Priority.PLAYER);
            }

            generation = stripThinkTags(generation);

            console.log('[FastModel] Generated:', generation);
            await this._saveLog(prompt, messages, generation, 'fast_conversation');
            return generation;
        } catch (err) {
            console.warn('[FastModel] Error, falling back to full model:', err.message);
            return this.promptConvo(messages, Priority.PLAYER);
        }
    }

    async promptConvo(messages, priority = Priority.SELF) {
        return this.generationLock.run(priority, async () => {
            this.awaiting_response = true;
            try {
                for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
                    await this.checkCooldown();

                    // Use ContextBuilder when enabled — token-budgeted prompt assembly
                    // _buildContextPrompt handles its own fallback to replaceStrings on failure
                    const prompt = settings.use_context_builder
                        ? await this._buildContextPrompt(messages)
                        : await this.replaceStrings(this.profile.conversing, messages, this.convo_examples);
                    let generation;

                    try {
                        generation = await this.chat_model.sendRequest(messages, prompt);
                        if (typeof generation !== 'string') {
                            console.error('Error: Generated response is not a string', generation);
                            throw new Error('Generated response is not a string');
                        }
                        console.log("Generated response:", generation);
                        await this._saveLog(prompt, messages, generation, 'conversation');

                    } catch (error) {
                        console.error('Error during message generation or file writing:', error);
                        continue;
                    }

                    // Check for hallucination or invalid output
                    if (generation?.includes('(FROM OTHER BOT)')) {
                        console.warn('LLM hallucinated message as another bot. Trying again...');
                        continue;
                    }

                    generation = stripThinkTags(generation);

                    return generation;
                }

                return '';
            } finally {
                this.awaiting_response = false;
            }
        });
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        return this.generationLock.run(Priority.MEMORY, async () => {
            await this.checkCooldown();
            let prompt = this.profile.saving_memory;
            prompt = await this.replaceStrings(prompt, null, null, to_summarize);
            let resp = await this.chat_model.sendRequest([], prompt);
            await this._saveLog(prompt, to_summarize, resp, 'memSaving');
            resp = stripThinkTags(resp);
            return resp;
        });
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // #21 L1.2: NOT deprecated despite the old marker — still called from
        // npc/controller.js:100 for the NPC goal-setting path. Retained for
        // NPC use only; main agent loop does not hit this.
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}

