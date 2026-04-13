const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this.baseCooldown = 2000;
        this.maxCooldown = 10000;  // slow down to 10s when stuck
        this._consecutiveNoProgress = 0;

        // --- Goal Queue: sequential goals that auto-advance ---
        this.goalQueue = [];

        // --- Persistent Rules: background checks between iterations ---
        // Each rule: { id, description, condition: function(agent) => bool, action: string }
        this.persistentRules = [];
        this._ruleIdCounter = 0;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    // --- Goal Queue Methods ---

    addGoal(goalText) {
        this.goalQueue.push(goalText);
        console.log(`[GoalQueue] Added goal: "${goalText}" (${this.goalQueue.length} in queue)`);
        return `Goal queued: "${goalText}" (position ${this.goalQueue.length} in queue)`;
    }

    viewGoals() {
        let result = `Current goal: "${this.prompt || '(none)'}"\n`;
        if (this.goalQueue.length === 0) {
            result += 'Goal queue: empty';
        } else {
            result += 'Goal queue:\n';
            this.goalQueue.forEach((g, i) => {
                result += `  ${i + 1}. ${g}\n`;
            });
        }
        return result;
    }

    advanceGoal() {
        if (this.goalQueue.length > 0) {
            const nextGoal = this.goalQueue.shift();
            console.log(`[GoalQueue] Advancing to next goal: "${nextGoal}" (${this.goalQueue.length} remaining)`);
            this.prompt = nextGoal;
            return nextGoal;
        }
        return null;
    }

    // --- Persistent Rules Methods ---

    addRule(description, conditionFn, actionStr) {
        const id = ++this._ruleIdCounter;
        this.persistentRules.push({ id, description, condition: conditionFn, action: actionStr });
        console.log(`[PersistentRule] Added rule #${id}: "${description}"`);
        return id;
    }

    removeRule(id) {
        const idx = this.persistentRules.findIndex(r => r.id === id);
        if (idx >= 0) {
            const removed = this.persistentRules.splice(idx, 1)[0];
            console.log(`[PersistentRule] Removed rule #${id}: "${removed.description}"`);
            return true;
        }
        return false;
    }

    viewRules() {
        if (this.persistentRules.length === 0) return 'No persistent rules active.';
        let result = 'Persistent rules:\n';
        this.persistentRules.forEach(r => {
            result += `  #${r.id}: ${r.description}\n`;
        });
        return result;
    }

    async checkPersistentRules() {
        for (const rule of this.persistentRules) {
            try {
                if (rule.condition(this.agent)) {
                    console.log(`[PersistentRule] Rule #${rule.id} triggered: "${rule.description}"`);
                    // Execute the rule action directly
                    await this.agent.handleMessage('system',
                        `[Persistent rule triggered: ${rule.description}] Execute: ${rule.action}`, -1);
                }
            } catch (e) {
                console.warn(`[PersistentRule] Rule #${rule.id} error:`, e.message);
            }
        }
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {

            // --- Check persistent rules between iterations ---
            if (this.persistentRules.length > 0) {
                await this.checkPersistentRules();
            }

            // --- Build the self-prompt message ---
            // Include queue awareness so the LLM knows there are more goals
            let msg = `You are self-prompting with the goal: '${this.prompt}'.`;
            if (this.goalQueue.length > 0) {
                msg += ` (${this.goalQueue.length} more goal${this.goalQueue.length > 1 ? 's' : ''} queued after this one.)`;
            }
            msg += ` Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);

            // Drain any player messages that queued up while the LLM was generating
            if (this.agent._playerMsgQueue && this.agent._playerMsgQueue.length > 0 && !this.agent._processingPlayerMsg) {
                this.agent._processingPlayerMsg = true;
                while (this.agent._playerMsgQueue.length > 0) {
                    const { username, message } = this.agent._playerMsgQueue.shift();
                    console.log('[PlayerQueue] Draining queued message from ' + username);
                    await this.agent.handleMessage(username, message);
                }
                this.agent._processingPlayerMsg = false;
            }

            if (!used_command) {
                no_command_count++;
                this._consecutiveNoProgress++;
                // Adaptive cooldown: slow down when not making progress
                this.cooldown = Math.min(this.maxCooldown, this.baseCooldown * (1 + this._consecutiveNoProgress));
                if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    break;
                }
            }
            else {
                no_command_count = 0;
                this._consecutiveNoProgress = 0;
                this.cooldown = this.baseCooldown; // reset to fast when making progress
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
