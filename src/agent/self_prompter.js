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

        // --- Goal lifecycle tracking (BT-7 Goal lifecycle) ---
        // _goalStartTime is set when a goal becomes active (start/advance)
        // and cleared on end. Elapsed ms is computed at end/advance time.
        this._goalStartTime = null;
        this._goalPrompt = null;

        // --- Stop attribution (for circuit-breaker watchdog) ---
        // Records why state transitioned to STOPPED. The watchdog in update()
        // only auto-resumes when stoppedReason === 'circuitBreaker'; explicit
        // user stops ('user') are respected and never auto-resumed.
        this.stoppedReason = null;

        // --- #23 ChunkWait held-state edge-trigger flag ---
        // Set true when the loop first observes chunk_wait.isHeld(); cleared
        // on the first non-held tick. Used to log enter/exit transitions
        // exactly once each instead of spamming on every poll.
        this._heldLogged = false;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.stoppedReason = null;
        this.prompt = prompt;
        this._goalStartTime = Date.now();
        this._goalPrompt = prompt;
        console.log(`[Goal] event=start prompt=${JSON.stringify(prompt)} queue_depth=${this.goalQueue.length}`);
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
        this.stoppedReason = null;
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
        console.log(`[Goal] event=pause prompt=${JSON.stringify(prompt)}`);
    }

    // --- Goal Queue Methods ---

    addGoal(goalText) {
        this.goalQueue.push(goalText);
        console.log(`[Goal] event=queue_add prompt=${JSON.stringify(goalText)} queue_depth=${this.goalQueue.length}`);
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
            const prev = this._goalPrompt ?? this.prompt;
            const elapsed = this._goalStartTime ? Date.now() - this._goalStartTime : null;
            console.log(`[Goal] event=advance from=${JSON.stringify(prev)} to=${JSON.stringify(nextGoal)} ms=${elapsed ?? '?'} queue_depth=${this.goalQueue.length}`);
            this.prompt = nextGoal;
            this._goalPrompt = nextGoal;
            this._goalStartTime = Date.now();
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

            // #23 ChunkWait held-state back-off.
            // Why: when chunks aren't loaded or position is NaN, the LLM has
            // nothing actionable to say. Inviting handleMessage anyway burns
            // round-trips, returns no-command responses, and walks the
            // no_command_count toward MAX_NO_COMMAND — firing the circuit
            // breaker, setting state=STOPPED, and serializing self_prompt:null
            // on the next history.save(). Net effect: goal lost on next
            // restart. The fix is a no-op tick: poll quickly, skip the LLM
            // call, do not advance the no-command counter.
            if (this.agent?.chunk_wait?.isHeld?.()) {
                if (!this._heldLogged) {
                    const reason = (typeof this.agent.chunk_wait.lastReason === 'function')
                        ? this.agent.chunk_wait.lastReason()
                        : 'unknown';
                    console.log(`[SelfPrompter] held — backing off (reason: ${reason})`);
                    this._heldLogged = true;
                }
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            if (this._heldLogged) {
                console.log('[SelfPrompter] hold released — resuming');
                this._heldLogged = false;
            }

            // #24 Player-chat yield — drain queued player messages BEFORE
            // the next self-prompt. Why: the existing bottom-of-loop drain
            // runs AFTER the LLM has already pattern-completed its self-
            // prompt response, so a player message that arrived during the
            // round-trip can't influence the in-flight decision — the bot
            // continues its stuck pattern and the player feels ignored
            // (observed live 2026-04-17 with !addRule chat). Draining at
            // the top gives each player message a dedicated LLM turn with
            // source=username (not 'system') before any new self-prompt.
            // Reset circuit-breaker counters so player turns can't cascade
            // into the #23 STOPPED-with-null-self_prompt path.
            if (this.agent._playerMsgQueue?.length > 0 && !this.agent._processingPlayerMsg) {
                this.agent._processingPlayerMsg = true;
                let drained = 0;
                while (this.agent._playerMsgQueue.length > 0) {
                    const { username, message } = this.agent._playerMsgQueue.shift();
                    console.log(`[SelfPrompter] yielding to player message from ${username}`);
                    await this.agent.handleMessage(username, message);
                    drained++;
                }
                this.agent._processingPlayerMsg = false;
                if (drained > 0) {
                    no_command_count = 0;
                    this._consecutiveNoProgress = 0;
                    this.cooldown = this.baseCooldown;
                    await new Promise(r => setTimeout(r, this.cooldown));
                    continue;
                }
            }

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
                    // Emit goal-end telemetry so the circuit-breaker stop is distinguishable
                    // from an explicit user stop in log analysis.
                    if (this._goalStartTime && this._goalPrompt) {
                        const elapsed = Date.now() - this._goalStartTime;
                        console.log(`[Goal] event=end prompt=${JSON.stringify(this._goalPrompt)} reason=circuit_breaker ms=${elapsed}`);
                        this._goalStartTime = null;
                        this._goalPrompt = null;
                    }
                    this.stoppedReason = 'circuitBreaker';
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
        // --- Circuit-breaker watchdog ---
        // If we stopped because of the 3-failed-prompts circuit breaker (not a
        // user-initiated stop) and we still have a goal, give the bot a chance
        // to recover after a cool-off period. User stops ('user') are respected
        // and never auto-resumed.
        else if (this.state === STOPPED
                 && this.stoppedReason === 'circuitBreaker'
                 && this.prompt
                 && !this.loop_active
                 && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            const WATCHDOG_MS = 180000; // 3 minutes
            if (this.idle_time >= WATCHDOG_MS) {
                console.log(`[Goal] event=resume prompt=${JSON.stringify(this.prompt)} reason=circuit_breaker_watchdog`);
                this.state = ACTIVE;
                this.stoppedReason = null;
                this._goalStartTime = Date.now();
                this._goalPrompt = this.prompt;
                this.idle_time = 0;
                this.startLoop();
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
        if (this._goalStartTime && this._goalPrompt) {
            const elapsed = Date.now() - this._goalStartTime;
            console.log(`[Goal] event=end prompt=${JSON.stringify(this._goalPrompt)} reason=stop ms=${elapsed}`);
            this._goalStartTime = null;
            this._goalPrompt = null;
        }
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.stoppedReason = 'user';
        this.state = STOPPED;
    }

    async pause() {
        if (this._goalStartTime && this._goalPrompt) {
            console.log(`[Goal] event=pause prompt=${JSON.stringify(this._goalPrompt)}`);
        }
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
