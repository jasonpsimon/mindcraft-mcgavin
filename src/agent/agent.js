import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, getCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import { ConfidenceEngine, CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from '../memory/index.js';
import { LongTermMemory } from '../memory/long_term_memory.js';
import { seedMemory } from '../memory/seed_memory.js';
import { getFullState } from './library/full_state.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { EventPipeline } from './event_pipeline.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { AutoRecoveryEngine } from './auto_recovery.js';
import { ChunkWait } from './chunk_wait.js';
import { Priority } from './generation_lock.js';
import { withBotLock } from './bot_mutex.js';
import * as skills from './library/skills.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank(); // legacy — kept for upstream command compatibility
        this.long_term_memory = new LongTermMemory(this.name, null, settings.long_term_memory || {});
        this.confidence_engine = new ConfidenceEngine(this.name, settings.confidence_engine || {});
        this.self_prompter = new SelfPrompter(this);
        this.event_pipeline = new EventPipeline(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // Initialize memory systems with the embedding model now that prompter is ready
        if (this.prompter.embedding_model) {
            await this.history.initEpisodicMemory(this.prompter.embedding_model);
            await this.long_term_memory.init(this.prompter.embedding_model);
            // Seed long-term memory with Minecraft fundamentals on first run
            await seedMemory(this.long_term_memory);
        }

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        // Start the chunk-wait watchdog *before* connecting so it begins
        // ticking immediately. It survives reconnects (attached to the
        // Agent, not to any bot instance) and remains safe to consult from
        // any caller via this.chunk_wait.* — see Rule 7 perimeter notes in
        // chunk_wait.js.
        if (!this.chunk_wait) {
            this.chunk_wait = new ChunkWait(this);
        }
        this.chunk_wait.start();

        await this._connectBot(save_data, init_message, count_id, load_mem);
    }

    /**
     * Create and wire a mineflayer client for this Agent. Called once from
     * start() for the first connect, and again from reconnect() for each
     * subsequent soft-reconnect. The Agent itself (memory systems, task,
     * AutoRecovery, ConfidenceEngine, prompter, history) is NOT re-initialized
     * — only the mineflayer client + plugins + event bindings + bot-tied
     * post-spawn setup (pathfinder defaults, protected zones, village scanner,
     * spawn escape, chat listeners).
     *
     * Extracted from start() as a pure refactor in commit B1 (whiteboard #22).
     * B2 adds the soft-reconnect flag + onDisconnect gating; B3 adds the
     * chunk_wait module that drives reconnect() calls.
     */
    async _connectBot(save_data, init_message, count_id, load_mem) {
        // Stash the original connect args so reconnect() can re-enter this
        // method with appropriate overrides (null init_message so a queued
        // task message is not replayed; load_mem=true so task.initBotTask is
        // skipped and only the existing goal is re-set).
        this._connectArgs = { save_data, init_message, count_id, load_mem };

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        // Backref so skills.js (and any other bot-scoped code) can reach
        // Agent-level subsystems like chunk_wait. Refreshed on every
        // reconnect because this.bot is recreated by initBot().
        this.bot.agent = this;
        if (!this.auto_recovery) {
            // AutoRecoveryEngine holds agent-level state (cycle counters,
            // recovery history) that must persist across reconnects. Create
            // it once on the first connect; leave it alone afterward.
            this.auto_recovery = new AutoRecoveryEngine(this);
        }

        // Connection Handler.
        // On a hard disconnect (kick / network error / first disconnect) we
        // exit the process so tmux / an external supervisor sees a crash.
        // On a soft reconnect (this._softReconnect === true, set by
        // reconnect()), we instead re-enter _connectBot() with stashed args
        // and skip process.exit entirely so the Agent survives.
        const onDisconnect = async (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);

            if (this._softReconnect) {
                const args = this._connectArgs;
                this._softReconnect = false;
                this._disconnectHandled = false;
                log(this.name, `[Reconnect] Disconnect received (${event}) during soft reconnect — re-entering _connectBot.`);
                // Brief wait so the server fully deregisters us before a
                // new login attempt (duplicate-login errors otherwise).
                await new Promise(resolve => setTimeout(resolve, 2000));
                try {
                    await this._connectBot(args.save_data, null, args.count_id, true);
                    log(this.name, `[Reconnect] Soft reconnect dispatched; waiting for spawn.`);
                } catch (e) {
                    console.error('[Reconnect] Soft reconnect failed, exiting:', e);
                    process.exit(1);
                }
                return;
            }

            process.exit(1);
        };

        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        if (!this._modesInitialized) {
            // initModes attaches mode handlers to the Agent (not the bot);
            // safe to run only once across the Agent's lifetime.
            initModes(this);
            this._modesInitialized = true;
        }

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();

            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));

                console.log(`${this.name} spawned.`);
                this.clearBotLogs();

                // Load manual protected zones from player_structures.json before
                // any destructive action can be attempted. Missing file / malformed
                // JSON / invalid entries are all logged but non-fatal — bot starts
                // with only spawn-zone protection in those cases.
                try {
                    skills.loadPlayerStructures(this.bot);
                } catch (loadErr) {
                    console.warn('[ProtectedZone] loadPlayerStructures threw:', loadErr.message);
                }

                // Configure mineflayer-collectblock's Movements with our safer
                // defaults (maxDropDown=3, digCost=10, canSwim, terrain-safe).
                // Otherwise the plugin's default Movements lets pathfinder choose
                // vertical shafts as the cheapest path to buried ore. Stage 1 of
                // the whiteboard #12 Movements safety audit.
                try {
                    skills.installSafePathfinderDefaults(this.bot);
                } catch (safeErr) {
                    console.warn('[SafeMovements] installSafePathfinderDefaults threw:', safeErr.message);
                }

                // Kick off the village auto-detector. First scan fires ~5s after
                // startup (lets chunks/entities load); subsequent scans every 30s.
                // Adds zones to bot.protectedZones with type='village' and dedups
                // against existing entries, so re-scans are idempotent.
                try {
                    // Clear any prior interval from a previous connection before
                    // starting a new one, so reconnects don't leak timers.
                    if (this._villageScanInterval) {
                        clearInterval(this._villageScanInterval);
                        this._villageScanInterval = null;
                    }
                    this._villageScanInterval = skills.startVillageScanner(this.bot);
                } catch (scanErr) {
                    console.warn('[VillageDetect] startVillageScanner threw:', scanErr.message);
                }

                // Vacate any protected zone before anything else happens.
                // If the bot spawns inside the zone, no destructive action can succeed;
                // the LLM can't reliably reason its way out of a 250-block exclusion zone,
                // so this is a pure mechanical pre-game move. Handles spawn, village, and structure zones.
                try {
                    await skills.escapeProtectedZone(this.bot);
                } catch (escapeErr) {
                    console.warn('[ProtectedZoneEscape] Error during spawn escape:', escapeErr.message);
                }

                this._setupEventHandlers(save_data, init_message);
                this.startEvents();

                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    /**
     * Trigger a soft reconnect of the mineflayer client without killing the
     * Node process. Sets this._softReconnect so the onDisconnect handler in
     * _connectBot re-enters _connectBot() with the stashed args instead of
     * calling process.exit(1). The Agent (memory, task, AutoRecovery,
     * prompter, history, ConfidenceEngine) is preserved across the bounce;
     * only the mineflayer client + bot-tied event bindings are recycled.
     *
     * Intended caller: chunk_wait.js after the 180s escalation timer when
     * chunks still have not loaded. Also safe to call from any future
     * recovery path that needs a fresh server connection without losing
     * session state.
     *
     * Idempotent — if a reconnect is already in flight, the new request is
     * logged and ignored rather than stacking.
     *
     * @param {string} reason Human-readable reason (logged locally, NOT
     *                        sent to the server or players).
     */
    async reconnect(reason = 'unspecified') {
        if (this._softReconnect) {
            log(this.name, `[Reconnect] Already reconnecting — ignoring new request (${reason}).`);
            return;
        }
        this._softReconnect = true;
        log(this.name, `[Reconnect] Initiating soft reconnect: ${reason}`);
        try {
            if (this.bot && typeof this.bot.end === 'function') {
                // bot.end() fires the 'end' event → onDisconnect → (soft path)
                // → _connectBot(). The onDisconnect handler guards against
                // double-firing via this._disconnectHandled.
                this.bot.end('soft-reconnect');
            } else if (this.bot && typeof this.bot.quit === 'function') {
                this.bot.quit('soft-reconnect');
            } else {
                // No live bot to end — go direct. Rare path (would mean the
                // client failed to construct), but handled for safety.
                log(this.name, '[Reconnect] No bot handle; calling _connectBot directly.');
                this._softReconnect = false;
                this._disconnectHandled = false;
                const args = this._connectArgs;
                await this._connectBot(args.save_data, null, args.count_id, true);
            }
        } catch (e) {
            console.warn('[Reconnect] bot.end threw:', e.message);
            // Fall through — onDisconnect may still fire from a lower-level
            // socket close. If it doesn't, the chunk_wait watchdog will try
            // again on its own cadence.
        }
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        // Queue for player messages that arrive while the bot is busy generating
        this._playerMsgQueue = [];
        this._processingPlayerMsg = false;

        const _drainPlayerQueue = async () => {
            if (this._processingPlayerMsg || this._playerMsgQueue.length === 0) return;
            this._processingPlayerMsg = true;
            while (this._playerMsgQueue.length > 0) {
                const { username, message } = this._playerMsgQueue.shift();
                console.log('[PlayerQueue] Processing queued message from ' + username + ': ' + message);
                await this.handleMessage(username, message);
            }
            this._processingPlayerMsg = false;
        };

        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);

                    // --- Direct command passthrough: if player types !command, execute it ---
                    if (translation.trim().startsWith('!')) {
                        const cmdStr = translation.trim();
                        // Extract just the command name (e.g. "!goal" from '!goal("mine diamonds")')
                        // Normalize: remove space before parens, e.g. !goal ("text") -> !goal("text")
                        const cmdStrNorm = cmdStr.replace(/^(!\w+)\s*\(/, '$1(');
                        const cmdNameMatch = cmdStrNorm.match(/^(!\w+)/);
                        const cmdName = cmdNameMatch ? cmdNameMatch[1] : cmdStr;
                        console.log('[DirectCommand] Player ' + username + ' issued command: ' + cmdName + ' (full: ' + cmdStr + ')');
                        if (commandExists(cmdName)) {
                            await this.history.add(username, cmdStrNorm);
                            let result = await executeCommand(this, cmdStrNorm);
                            if (result) {
                                this.routeResponse(username, result);
                                await this.history.add('system', result);
                            }
                            this.history.save();
                            return;
                        } else {
                            console.log('[DirectCommand] Unknown command: ' + cmdName + ', falling through to LLM');
                        }
                    }

                    // --- Natural language goal/rule detection ---
                    const msg_lower = translation.toLowerCase();

                    // "add a goal to..." / "queue goal..." / "next goal..."
                    const goalMatch = msg_lower.match(/(?:add (?:a )?goal|queue (?:a )?goal|next goal|new goal)[:\s]+["']?(.+?)["']?\s*$/);
                    if (goalMatch) {
                        const goalText = goalMatch[1].replace(/^(?:to |for )/i, '').trim();
                        const cmdStr = '!addGoal("' + goalText + '")';
                        console.log('[NaturalLang] Goal detected: ' + cmdStr);
                        this.routeResponse(username, 'Got it, I\'ll queue that goal: "' + goalText + '"');
                        await this.history.add(username, translation);
                        let result = await executeCommand(this, cmdStr);
                        if (result) await this.history.add('system', result);
                        this.history.save();
                        return;
                    }

                    // "set goal to..." / "your goal is..." / "work on..."
                    const setGoalMatch = msg_lower.match(/(?:set (?:a |your )?goal|your goal is|work on|start working on|go (?:do|mine|collect|craft|build|find|get))[:\s]+["']?(.+?)["']?\s*$/);
                    if (setGoalMatch) {
                        const goalText = setGoalMatch[1].replace(/^(?:to |for )/i, '').trim();
                        const cmdStr = '!goal("' + goalText + '")';
                        console.log('[NaturalLang] Set goal detected: ' + cmdStr);
                        this.routeResponse(username, 'On it! Setting goal: "' + goalText + '"');
                        await this.history.add(username, translation);
                        let result = await executeCommand(this, cmdStr);
                        if (result) await this.history.add('system', result);
                        this.history.save();
                        return;
                    }

                    // "show goals" / "what are my goals" / "list goals"
                    if (msg_lower.match(/(?:show|list|view|what are|what's in).*(?:goal|queue)/)) {
                        console.log('[NaturalLang] View goals detected');
                        await this.history.add(username, translation);
                        const result = this.self_prompter.viewGoals();
                        this.routeResponse(username, result);
                        await this.history.add('system', result);
                        this.history.save();
                        return;
                    }

                    // "add a rule..." / "whenever you see..." / "always collect..."
                    const ruleMatch = msg_lower.match(/(?:add (?:a )?rule|whenever you (?:see|find|notice)|always (?:collect|mine|pick up|grab))[:\s]+["']?(.+?)["']?\s*$/);
                    if (ruleMatch) {
                        const ruleText = ruleMatch[1].trim();
                        // Try to auto-detect the action from the description
                        let action = '!nearbyBlocks';  // fallback
                        if (ruleText.match(/(?:collect|mine|grab|pick up).*(?:diamond)/i))
                            action = '!collectBlocks("diamond_ore", 3)';
                        else if (ruleText.match(/(?:collect|mine|grab|pick up).*(?:iron)/i))
                            action = '!collectBlocks("iron_ore", 5)';
                        else if (ruleText.match(/(?:collect|mine|grab|pick up).*(?:coal)/i))
                            action = '!collectBlocks("coal_ore", 5)';
                        else if (ruleText.match(/(?:collect|mine|grab|pick up).*(?:ore)/i))
                            action = '!collectBlocks("diamond_ore", 3)';
                        else if (ruleText.match(/(?:clean|discard|clear).*(?:inventory)/i))
                            action = '!autoDiscard(5)';

                        const cmdStr = '!addRule("' + ruleText + '", "' + action + '")';
                        console.log('[NaturalLang] Rule detected: ' + cmdStr);
                        this.routeResponse(username, 'Rule added: "' + ruleText + '" → ' + action);
                        await this.history.add(username, translation);
                        let result = await executeCommand(this, cmdStr);
                        if (result) await this.history.add('system', result);
                        this.history.save();
                        return;
                    }

                    // "show rules" / "what are the rules" / "list rules"
                    if (msg_lower.match(/(?:show|list|view|what are).*(?:rule)/)) {
                        console.log('[NaturalLang] View rules detected');
                        await this.history.add(username, translation);
                        const result = this.self_prompter.viewRules();
                        this.routeResponse(username, result);
                        await this.history.add('system', result);
                        this.history.save();
                        return;
                    }

                    // "remove rule #N" / "delete rule N"
                    const removeRuleMatch = msg_lower.match(/(?:remove|delete|clear) rule[:\s#]*(\d+)/);
                    if (removeRuleMatch) {
                        const ruleId = parseInt(removeRuleMatch[1]);
                        console.log('[NaturalLang] Remove rule #' + ruleId);
                        const removed = this.self_prompter.removeRule(ruleId);
                        const result = removed ? 'Rule #' + ruleId + ' removed.' : 'No rule found with ID #' + ruleId;
                        this.routeResponse(username, result);
                        await this.history.add(username, translation);
                        await this.history.add('system', result);
                        this.history.save();
                        return;
                    }

                    // Detect urgent player commands and execute immediately,
                    // even if the bot is busy generating an LLM response.
                    // Supports compound commands (e.g. "stop your goal and follow me").
                    let urgentCmds = [];

                    if (msg_lower.includes('stop') && (msg_lower.includes('goal') || msg_lower.includes('everything') || msg_lower.includes('what you') || msg_lower.includes('doing'))) {
                        urgentCmds.push('!endGoal');
                    } else if (msg_lower.match(/\b(stop|halt|stay|wait)\b/)) {
                        urgentCmds.push('!stop');
                    }
                    if (msg_lower.match(/\b(follow me|come here|come with me|follow)\b/)) {
                        urgentCmds.push('!followPlayer("' + username + '", 3)');
                    }

                    // "give me [item]" — parse item name and quantity from player request
                    const giveMatch = msg_lower.match(/(?:give me|hand over|pass me|drop me|toss me)\s+(.+)/);
                    if (giveMatch) {
                        let phrase = giveMatch[1].trim()
                            .replace(/\s*(from your inventory|from inventory|back|please|right now|now)\s*\.?\s*$/g, '')
                            .replace(/^(my|the|your|both|all|some|a|an)\s+/g, '')
                            .replace(/^(my|the|your)\s+/g, '');
                        let qty = 1;
                        const qtyMatch = phrase.match(/^(\d+|both|all)\s+/);
                        if (qtyMatch) {
                            if (qtyMatch[1] === 'both') qty = 2;
                            else if (qtyMatch[1] === 'all') qty = 64;
                            else qty = parseInt(qtyMatch[1]) || 1;
                            phrase = phrase.slice(qtyMatch[0].length);
                        } else if (msg_lower.includes('both')) {
                            qty = 2;
                        }
                        let rawItem = phrase
                            .replace(/(regular|enchanted|of the|of|my|the|your)/g, '')
                            .trim()
                            .replace(/\s+/g, '_');
                        if (rawItem.endsWith('xes')) rawItem = rawItem.slice(0, -2);
                        else if (rawItem.endsWith('s') && !rawItem.endsWith('ss')) rawItem = rawItem.slice(0, -1);
                        rawItem = rawItem.replace(/_+/g, '_').replace(/^_|_$/g, '');
                        console.log('[PlayerCommand] Give request parsed: item=' + rawItem + ' qty=' + qty + ' to=' + username);
                        urgentCmds.push('!givePlayer("' + username + '", "' + rawItem + '", ' + qty + ')');
                    }

                    if (urgentCmds.length > 0) {
                        console.log('[PlayerCommand] Detected urgent commands: ' + urgentCmds.join(', ') + ' from ' + username);
                        await this.self_prompter.stop();

                        // Build a friendly chat response describing what we're doing
                        let responseTexts = [];
                        for (const cmd of urgentCmds) {
                            if (cmd.includes('endGoal')) responseTexts.push("Alright, stopping my goal!");
                            else if (cmd.includes('stop')) responseTexts.push("Stopping!");
                            else if (cmd.includes('followPlayer')) responseTexts.push("Sure, I'll follow you!");
                            else if (cmd.includes('givePlayer')) {
                                const itemMatch = cmd.match(/"([^"]+)",\s*"([^"]+)",\s*(\d+)/);
                                if (itemMatch) responseTexts.push("Here, let me give you " + itemMatch[3] + " " + itemMatch[2].replace(/_/g, ' ') + "!");
                            }
                        }
                        if (responseTexts.length > 0) {
                            this.routeResponse(username, responseTexts.join(' '));
                        }

                        await this.history.add(username, translation);
                        for (const cmd of urgentCmds) {
                            await this.history.add(this.name, cmd);
                            let result = await executeCommand(this, cmd);
                            if (result) await this.history.add('system', result);
                        }
                        this.history.save();
                        return;
                    }

                    // If the bot is currently generating an LLM response, queue the
                    // player message instead of racing the promptConvo timestamp.
                    if (this.prompter.awaiting_response) {
                        console.log('[PlayerQueue] Bot busy generating, queuing message from ' + username);
                        this._playerMsgQueue.push({ username, message: translation });
                    } else {
                        await this.handleMessage(username, translation);
                        await _drainPlayerQueue();
                    }
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat. startAt bumped from 14 -> 19 (2026-04-15) so the
        // bot keeps hunger near full, which keeps health regenerating between
        // hits. Prior threshold of 14 meant auto-eat only fired AFTER the bot
        // was already injured + hungry — too late to prevent fall-damage death.
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 19,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            // Skip init_message when resuming a goal — it races with
            // self-prompter and causes responses to get discarded
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }

        // Restore goal queue
        if (save_data?.goal_queue && save_data.goal_queue.length > 0) {
            this.self_prompter.goalQueue = save_data.goal_queue;
            console.log('[GoalQueue] Restored ' + save_data.goal_queue.length + ' queued goals from memory');
        }

        // Restore persistent rules (re-create condition functions from descriptions)
        if (save_data?.persistent_rules && save_data.persistent_rules.length > 0) {
            for (const rule of save_data.persistent_rules) {
                const descLower = rule.description.toLowerCase();
                let conditionFn;

                if (descLower.includes('diamond ore') || descLower.includes('diamond_ore')) {
                    conditionFn = (agent) => {
                        try {
                            const blocks = agent.bot.findBlocks({ matching: (block) =>
                                block.name.includes('diamond_ore'), maxDistance: 16, count: 1 });
                            return blocks.length > 0;
                        } catch { return false; }
                    };
                } else if (descLower.includes('iron ore') || descLower.includes('iron_ore')) {
                    conditionFn = (agent) => {
                        try {
                            const blocks = agent.bot.findBlocks({ matching: (block) =>
                                block.name.includes('iron_ore'), maxDistance: 16, count: 1 });
                            return blocks.length > 0;
                        } catch { return false; }
                    };
                } else if (descLower.includes('inventory full') || descLower.includes('clean')) {
                    conditionFn = (agent) => {
                        try {
                            const slots = agent.bot.inventory.slots;
                            const usedSlots = slots.filter(s => s !== null).length;
                            return usedSlots >= 33;
                        } catch { return false; }
                    };
                } else if (descLower.includes('low health') || descLower.includes('heal')) {
                    conditionFn = (agent) => {
                        try { return agent.bot.health <= 8; } catch { return false; }
                    };
                } else if (descLower.includes('ore') && descLower.includes('collect')) {
                    conditionFn = (agent) => {
                        try {
                            const blocks = agent.bot.findBlocks({ matching: (block) =>
                                block.name.includes('_ore'), maxDistance: 16, count: 1 });
                            return blocks.length > 0;
                        } catch { return false; }
                    };
                } else {
                    conditionFn = () => true;
                }

                this.self_prompter.addRule(rule.description, conditionFn, rule.action);
            }
            console.log('[PersistentRules] Restored ' + save_data.persistent_rules.length + ' rules from memory');
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        // ChunkWait perimeter (Rule 7): if chunks haven't loaded, pause
        // LLM calls + command execution. Players get a polite reply
        // (throttled per player); self-prompts / system / other-bot
        // messages are silently deferred until chunks come back. The
        // self_prompter naturally resumes once the held state exits.
        if (this.chunk_wait?.isHeld()) {
            const isPlayerMsg = source && source !== 'system'
                && source !== this.name
                && !convoManager.isOtherAgent(source);
            if (isPlayerMsg) {
                if (this.chunk_wait.shouldGate(message)) {
                    // Non-whitelisted command / chat while held.
                    this.chunk_wait.notifyPlayerMessage(source);
                    return false;
                }
                // Whitelisted (!stop, !goal, !setMode, …) — fall through
                // so the player can still abort or retarget while paused.
            } else {
                // Self, system, and other-bot messages deferred silently.
                return false;
            }
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const llmPriority = self_prompt ? Priority.SELF : Priority.PLAYER;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;

            // --- Confidence Engine: check procedural memory before calling LLM ---
            let confidenceResult = null;
            let wasBypassed = false;
            try {
                const currentGoal = this.self_prompter.isStopped() ? null : this.self_prompter.prompt;
                this.bot._goalHint = currentGoal; // expose goal to skills for smart discard
                const gameState = getFullState(this);
                confidenceResult = this.confidence_engine.evaluate(currentGoal, message, gameState);
            } catch (err) {
                console.warn('[ConfidenceEngine] Evaluation error, falling back to LLM:', err.message);
            }

            let res;

            if (confidenceResult?.level === CONFIDENCE_HIGH && self_prompt) {
                // HIGH confidence: bypass LLM entirely, use cached action
                // Only bypass during self-prompting — player messages always go to LLM
                res = confidenceResult.action;
                wasBypassed = true;
                console.log(`[ConfidenceEngine] BYPASS (${(confidenceResult.confidence * 100).toFixed(0)}%): ${res}`);
            } else {
                // MEDIUM or LOW: call LLM (with optional hint for MEDIUM)
                let history = this.history.getHistory();

                if (confidenceResult?.level === CONFIDENCE_MEDIUM) {
                    const hint = this.confidence_engine.buildSuggestionFromResult(confidenceResult);
                    if (hint) {
                        // Inject hint as a system message at the end of history
                        history.push({ role: 'system', content: hint });
                    }
                    console.log(`[ConfidenceEngine] SUGGEST (${(confidenceResult.confidence * 100).toFixed(0)}%): ${confidenceResult.action}`);

                    // Route MEDIUM confidence to fast model if available
                    if (settings.use_fast_model !== false) {
                        res = await this.prompter.promptConvoFast(history, hint);
                    } else {
                        res = await this.prompter.promptConvo(history, llmPriority);
                    }
                } else {
                    res = await this.prompter.promptConvo(history, llmPriority);
                }
            }
            // --- End Confidence Engine hook ---

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                // During self-prompting, don't go idle — nudge the bot to act
                if (self_prompt && !this.self_prompter.isStopped()) {
                    console.log('Empty response during self-prompt, nudging to take action');
                    this.history.add('system', 'You must take an action toward your goal. Use a command like !inventory, !nearbyBlocks, !collectBlocks, !craftRecipe, or !discard to make progress. Do not idle.');
                    continue;
                }
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);

                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    // Record failure if this was a bypass, unless ChunkWait
                    // is held — procedural memory should not be written
                    // during an unstable chunk-load window (fixes #16.1
                    // false-positive class at source, not by keywords).
                    if (confidenceResult?.contextHash && !this.chunk_wait?.isHeld()) {
                        this.confidence_engine.recordOutcome(confidenceResult.contextHash, res, false, wasBypassed);
                    }
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await withBotLock(
                    `cmd:${command_name}`,
                    () => executeCommand(this, res)
                );

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                // --- Record outcome for procedural learning ---
                // Skip entirely while ChunkWait is held — the bot may
                // report guard-message "successes" that don't contain
                // failure keywords, and we don't want those polluting
                // procedural memory (fixes the #16.1 false-positive class
                // at source; see chunk_wait.js module docstring).
                if (confidenceResult?.contextHash && !this.chunk_wait?.isHeld()) {
                    const exec_lower = (execute_res || '').toLowerCase();
                    const success = !!execute_res && !exec_lower.includes('failed') && !exec_lower.includes('error') && !exec_lower.includes('invalid') && !exec_lower.includes('do not have the resources') && !exec_lower.includes('not a command') && !exec_lower.includes('was given') && !exec_lower.includes('does not exist') && !exec_lower.includes('exception');
                    this.confidence_engine.recordOutcome(confidenceResult.contextHash, res, success, wasBypassed, {
                        goal: this.self_prompter.isStopped() ? null : this.self_prompter.prompt,
                        trigger: message,
                        result: execute_res?.substring(0, 200) // truncate for storage
                    });
                }
                // --- End outcome recording ---

                if (execute_res) {
                    this.history.add('system', execute_res);

                    // --- Refresh nearby blocks after every action ---
                    // Bot has likely moved, give LLM fresh surroundings
                    try {
                        const nbResult = getCommand('!nearbyBlocks').perform(this);
                        if (nbResult) this.history.add('system', nbResult);
                    } catch (e) { /* silent */ }
                    // --- End nearby blocks refresh ---

                    // --- Auto-Recovery Engine ---
                    // Intercept failures and resolve dependency chains without LLM
                    try {
                        // Extract just the command string (e.g. "!digDown(5)") for retry, not the full LLM response
                        const cmdMatch = res.match(/!\w+(?:\((?:[^)]*)\))?/);
                        const cleanCommand = cmdMatch ? cmdMatch[0] : res;
                        const recovery = await this.auto_recovery.checkAndRecover(command_name, execute_res, cleanCommand);
                        if (recovery.recovered) {
                            console.log(`[AutoRecovery] Recovered from ${command_name} failure:`, recovery.result);
                            this.history.add('system', recovery.result);

                            // If recovery provides a retry command, execute it immediately
                            if (recovery.retry) {
                                console.log(`[AutoRecovery] Retrying: ${recovery.retry}`);
                                let retry_res = await withBotLock(
                                    `cmd:retry:${command_name}`,
                                    () => executeCommand(this, recovery.retry)
                                );
                                if (retry_res) {
                                    console.log(`[AutoRecovery] Retry result:`, retry_res);
                                    this.history.add('system', retry_res);
                                }
                            }
                        } else if (recovery.result !== execute_res) {
                            // Recovery couldn't fix it but has advice for the LLM
                            this.history.add('system', recovery.result);
                        }
                    } catch (recoveryErr) {
                        console.warn('[AutoRecovery] Error during recovery attempt:', recoveryErr.message);
                    }
                    // --- End Auto-Recovery Engine ---
                }
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }

            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                const death_pos = this.bot.entity?.position;
                const dimension = this.bot.game.dimension;

                if (death_pos) {
                    const posText = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                    this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                    await this.long_term_memory.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                    await this.history.episodic.addEvent(`Died: ${message} at ${posText}`);
                    this.handleMessage('system', `You died at position ${posText} in the ${dimension} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
                } else {
                    this.handleMessage('system', `You died in the ${dimension} dimension with the final message: '${message}'. Position unknown. Previous actions were stopped and you have respawned.`);
                }
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // Initialize event pipeline (event listeners + adaptive polling loop)
        this.event_pipeline.init(this.bot);
        this.event_pipeline.startUpdateLoop();

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}

