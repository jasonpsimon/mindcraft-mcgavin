/**
 * Event Pipeline — Hybrid event-driven + polling architecture.
 *
 * Replaces the hardcoded 300ms polling loop with:
 *   1. Event listeners for time-critical reactions (damage, entity proximity, drowning)
 *   2. A configurable polling interval for non-critical periodic checks
 *   3. Debounced event handling to prevent event storms
 *
 * The goal is to reduce CPU usage during idle periods while maintaining
 * fast reaction times for critical events like combat and self-preservation.
 *
 * Integrates with the existing modes system — modes can register as
 * event-driven (trigger on specific events) or polling-based (checked on interval).
 */

import settings from './settings.js';

export class EventPipeline {
    constructor(agent) {
        this.agent = agent;
        this.bot = null; // set after bot is ready

        // Configurable polling interval (default 300ms for backwards compatibility)
        this.pollingInterval = settings.polling_interval || 300;
        // Adaptive: increase interval when idle, decrease when active
        this.adaptivePolling = settings.adaptive_polling !== false;
        this.idleInterval = settings.idle_polling_interval || 1000;
        this.activeInterval = settings.active_polling_interval || 300;

        // Debounce tracking
        this._lastEventTime = {};
        this._debounceMs = 200; // minimum ms between handling same event type

        // Flag-based urgent update: events set the flag, polling loop executes
        this._pendingUrgentUpdate = false;
        this._urgentMinInterval = 100; // ms guard between urgent updates
        this._lastUrgentUpdate = 0;

        // Stats
        this.stats = {
            eventsHandled: 0,
            pollCycles: 0,
            eventTypes: {}
        };
    }

    /**
     * Initialize event listeners on the bot.
     * Call this after bot.once('spawn') fires.
     */
    init(bot) {
        this.bot = bot;

        // --- Critical event listeners (immediate reaction) ---

        // Health change: potential damage, hunger, healing
        bot.on('health', () => {
            this._handleEvent('health', () => {
                // Force modes update immediately on health change
                // This ensures self_preservation reacts faster than polling
                if (bot.health < 10) {
                    this._urgentModesUpdate();
                }
            });
        });

        // Entity spawn nearby: potential threat detection
        bot.on('entitySpawn', (entity) => {
            this._handleEvent('entitySpawn', () => {
                // Only care about hostile mobs within reasonable range
                if (entity.type === 'hostile' || entity.type === 'mob') {
                    const dist = entity.position?.distanceTo(bot.entity?.position);
                    if (dist && dist < 16) {
                        this._urgentModesUpdate();
                    }
                }
            });
        });

        // Block update at player position: lava, water, sand falling
        bot.on('blockUpdate', (oldBlock, newBlock) => {
            this._handleEvent('blockUpdate', () => {
                if (!newBlock || !bot.entity) return;
                const dist = newBlock.position.distanceTo(bot.entity.position);
                if (dist < 3) {
                    const dangerous = ['lava', 'fire', 'sweet_berry_bush'];
                    if (dangerous.includes(newBlock.name)) {
                        this._urgentModesUpdate();
                    }
                }
            });
        });

        // Weather change
        bot.on('rain', () => {
            this._handleEvent('weather', () => {
                // Invalidate delta state cache on weather change
                if (this.agent.prompter?.deltaState) {
                    // Weather change is tracked by delta state automatically
                }
            });
        });

        // Dimension change: invalidate caches
        bot.on('respawn', () => {
            this._handleEvent('respawn', () => {
                if (this.agent.prompter?.deltaState) {
                    this.agent.prompter.deltaState.invalidate();
                }
            });
        });

        console.log(`[EventPipeline] Initialized with ${this.adaptivePolling ? 'adaptive' : 'fixed'} polling (${this.pollingInterval}ms)`);
    }

    /**
     * Start the main update loop with configurable interval.
     * Replaces the hardcoded 300ms while(true) loop.
     */
    startUpdateLoop() {
        let last = Date.now();

        const loop = async () => {
            while (true) {
                let start = Date.now();

                // Consume urgent flag: run modes update through the single pipeline
                if (this._pendingUrgentUpdate) {
                    this._pendingUrgentUpdate = false;
                    const now = Date.now();
                    if (now - this._lastUrgentUpdate >= this._urgentMinInterval) {
                        this._lastUrgentUpdate = now;
                        try {
                            await this.bot.modes.update();
                        } catch (err) {
                            console.warn('[EventPipeline] Urgent modes update failed:', err.message);
                        }
                    }
                }

                await this.agent.update(start - last);
                this.stats.pollCycles++;

                // Adaptive interval: slower when idle, faster when active
                // "Effectively idle" = not executing an action, even if self-prompter
                // is active (it's just waiting in its cooldown, not doing work)
                let interval = this.pollingInterval;
                if (this.adaptivePolling) {
                    const effectivelyIdle = !this.agent.actions.executing;
                    interval = effectivelyIdle ? this.idleInterval : this.activeInterval;
                }

                // If an urgent event came in while we were updating, skip the sleep
                if (this._pendingUrgentUpdate) {
                    interval = 0;
                }

                let remaining = interval - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise(resolve => setTimeout(resolve, remaining));
                }
                last = start;
            }
        };

        setTimeout(loop, this.pollingInterval);
    }

    /**
     * Handle an event with debouncing.
     */
    _handleEvent(eventType, handler) {
        const now = Date.now();
        const lastTime = this._lastEventTime[eventType] || 0;

        if (now - lastTime < this._debounceMs) return;

        this._lastEventTime[eventType] = now;
        this.stats.eventsHandled++;
        this.stats.eventTypes[eventType] = (this.stats.eventTypes[eventType] || 0) + 1;

        try {
            handler();
        } catch (err) {
            console.warn(`[EventPipeline] Error handling ${eventType}:`, err.message);
        }
    }

    /**
     * Flag an urgent modes update.
     * Instead of executing directly (risking double-fire with polling),
     * sets a flag that the polling loop checks on its next cycle.
     * Also shortens the current sleep to near-zero for fast reaction.
     */
    _urgentModesUpdate() {
        this._pendingUrgentUpdate = true;
    }

    /**
     * Get pipeline stats for monitoring.
     */
    getStats() {
        return {
            ...this.stats,
            currentInterval: this.adaptivePolling
                ? (!this.agent.actions.executing ? this.idleInterval : this.activeInterval)
                : this.pollingInterval
        };
    }
}
