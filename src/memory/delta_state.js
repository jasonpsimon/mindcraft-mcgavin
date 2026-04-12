/**
 * Delta State Tracker — Only sends what changed to the LLM.
 *
 * Caches the last known game state from getFullState() and produces
 * a compact diff string showing only what changed since the last call.
 * On first call (no cache), returns the full state formatted compactly.
 *
 * Token savings come from replacing full stat/inventory/nearby dumps
 * with concise delta messages like:
 *   "Health: 20→14 | Inventory: +3 oak_log, -1 wooden_pickaxe | Now in: forest"
 *
 * Integrates with prompter.js by replacing the $STATS and $INVENTORY
 * placeholder logic.
 */

export class DeltaStateTracker {
    constructor() {
        this.lastState = null;
        this.callCount = 0;
        this.fullRefreshInterval = 10; // send full state every N calls as a safety net
    }

    /**
     * Process a new game state and return a formatted string.
     * Returns full state on first call, delta on subsequent calls.
     *
     * @param {object} currentState - Output from getFullState()
     * @returns {string} Formatted state string for the LLM prompt
     */
    update(currentState) {
        this.callCount++;

        // First call or periodic full refresh
        if (!this.lastState || this.callCount % this.fullRefreshInterval === 0) {
            this.lastState = this._deepCopy(currentState);
            return this._formatFullState(currentState);
        }

        // Compute delta
        const delta = this._computeDelta(this.lastState, currentState);
        this.lastState = this._deepCopy(currentState);

        if (delta.length === 0) {
            return '[No changes since last update]';
        }

        return delta.join('\n');
    }

    /**
     * Force a full state output on the next call.
     * Useful after major events like death, dimension change, etc.
     */
    invalidate() {
        this.lastState = null;
    }

    /**
     * Compute differences between old and new game state.
     * Returns an array of human-readable change strings.
     */
    _computeDelta(oldState, newState) {
        const changes = [];

        // --- Gameplay changes ---
        if (oldState.gameplay && newState.gameplay) {
            const og = oldState.gameplay;
            const ng = newState.gameplay;

            if (og.health !== ng.health)
                changes.push(`Health: ${og.health}→${ng.health}`);
            if (og.hunger !== ng.hunger)
                changes.push(`Hunger: ${og.hunger}→${ng.hunger}`);
            if (og.biome !== ng.biome)
                changes.push(`Biome: ${og.biome}→${ng.biome}`);
            if (og.dimension !== ng.dimension)
                changes.push(`Dimension: ${og.dimension}→${ng.dimension}`);
            if (og.timeLabel !== ng.timeLabel)
                changes.push(`Time: ${og.timeLabel}→${ng.timeLabel}`);
            if (og.weather !== ng.weather)
                changes.push(`Weather: ${og.weather}→${ng.weather}`);
            if (og.gamemode !== ng.gamemode)
                changes.push(`Gamemode: ${og.gamemode}→${ng.gamemode}`);

            // Position — only report if moved significantly (> 3 blocks)
            if (og.position && ng.position) {
                const dist = Math.sqrt(
                    Math.pow(og.position.x - ng.position.x, 2) +
                    Math.pow(og.position.y - ng.position.y, 2) +
                    Math.pow(og.position.z - ng.position.z, 2)
                );
                if (dist > 3) {
                    changes.push(`Position: (${ng.position.x}, ${ng.position.y}, ${ng.position.z})`);
                }
            }
        }

        // --- Action changes ---
        if (oldState.action && newState.action) {
            if (oldState.action.current !== newState.action.current)
                changes.push(`Action: ${oldState.action.current}→${newState.action.current}`);
        }

        // --- Inventory changes ---
        if (oldState.inventory?.counts && newState.inventory?.counts) {
            const invDelta = this._diffCounts(oldState.inventory.counts, newState.inventory.counts);
            if (invDelta.length > 0) {
                changes.push(`Inventory: ${invDelta.join(', ')}`);
            }

            // Equipment changes
            if (oldState.inventory.equipment && newState.inventory.equipment) {
                const equipChanges = this._diffEquipment(oldState.inventory.equipment, newState.inventory.equipment);
                if (equipChanges.length > 0) {
                    changes.push(`Equipment: ${equipChanges.join(', ')}`);
                }
            }
        }

        // --- Nearby changes ---
        if (oldState.nearby && newState.nearby) {
            // Player changes
            const playerDelta = this._diffArrays(
                oldState.nearby.humanPlayers || [],
                newState.nearby.humanPlayers || []
            );
            if (playerDelta.added.length > 0)
                changes.push(`Players nearby: +${playerDelta.added.join(', ')}`);
            if (playerDelta.removed.length > 0)
                changes.push(`Players left: -${playerDelta.removed.join(', ')}`);

            // Entity type changes
            const entityDelta = this._diffArrays(
                oldState.nearby.entityTypes || [],
                newState.nearby.entityTypes || []
            );
            if (entityDelta.added.length > 0)
                changes.push(`New entities: +${entityDelta.added.join(', ')}`);
            if (entityDelta.removed.length > 0)
                changes.push(`Entities gone: -${entityDelta.removed.join(', ')}`);
        }

        // --- Surroundings changes ---
        if (oldState.surroundings && newState.surroundings) {
            if (oldState.surroundings.below !== newState.surroundings.below)
                changes.push(`Standing on: ${newState.surroundings.below}`);
            if (oldState.surroundings.head !== newState.surroundings.head && newState.surroundings.head !== 'air')
                changes.push(`Head in: ${newState.surroundings.head}`);
        }

        return changes;
    }

    /**
     * Diff two inventory count objects.
     * Returns array like ["+3 oak_log", "-1 wooden_pickaxe"]
     */
    _diffCounts(oldCounts, newCounts) {
        const changes = [];
        const allKeys = new Set([...Object.keys(oldCounts), ...Object.keys(newCounts)]);

        for (const key of allKeys) {
            const oldVal = oldCounts[key] || 0;
            const newVal = newCounts[key] || 0;
            const diff = newVal - oldVal;

            if (diff > 0) changes.push(`+${diff} ${key}`);
            else if (diff < 0) changes.push(`${diff} ${key}`);
        }

        return changes;
    }

    /**
     * Diff equipment slots.
     */
    _diffEquipment(oldEquip, newEquip) {
        const changes = [];
        for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'mainHand']) {
            if (oldEquip[slot] !== newEquip[slot]) {
                const from = oldEquip[slot] || 'empty';
                const to = newEquip[slot] || 'empty';
                changes.push(`${slot}: ${from}→${to}`);
            }
        }
        return changes;
    }

    /**
     * Diff two arrays, returning added and removed items.
     */
    _diffArrays(oldArr, newArr) {
        const oldSet = new Set(oldArr);
        const newSet = new Set(newArr);
        return {
            added: newArr.filter(x => !oldSet.has(x)),
            removed: oldArr.filter(x => !newSet.has(x))
        };
    }

    /**
     * Format full state compactly (used on first call and periodic refresh).
     * Much more concise than the raw command outputs.
     */
    _formatFullState(state) {
        const parts = [];

        if (state.gameplay) {
            const g = state.gameplay;
            parts.push(`Position: (${g.position.x}, ${g.position.y}, ${g.position.z}) | ${g.dimension}`);
            parts.push(`Health: ${g.health}/20 | Hunger: ${g.hunger}/20 | Biome: ${g.biome}`);
            parts.push(`Time: ${g.timeLabel} | Weather: ${g.weather} | Mode: ${g.gamemode}`);
        }

        if (state.action) {
            parts.push(`Action: ${state.action.current}`);
        }

        if (state.inventory?.counts) {
            const items = Object.entries(state.inventory.counts)
                .map(([item, count]) => `${item}:${count}`)
                .join(', ');
            parts.push(`Inventory (${state.inventory.stacksUsed}/${state.inventory.totalSlots} slots): ${items || 'empty'}`);

            if (state.inventory.equipment) {
                const eq = state.inventory.equipment;
                const equipped = Object.entries(eq)
                    .filter(([_, v]) => v)
                    .map(([slot, item]) => `${slot}:${item}`)
                    .join(', ');
                if (equipped) parts.push(`Equipment: ${equipped}`);
            }
        }

        if (state.surroundings) {
            parts.push(`Standing on: ${state.surroundings.below} | Head: ${state.surroundings.head}`);
        }

        if (state.nearby) {
            if (state.nearby.humanPlayers?.length > 0)
                parts.push(`Players nearby: ${state.nearby.humanPlayers.join(', ')}`);
            if (state.nearby.entityTypes?.length > 0)
                parts.push(`Entities nearby: ${state.nearby.entityTypes.join(', ')}`);
        }

        if (state.modes?.summary) {
            parts.push(`Modes: ${state.modes.summary}`);
        }

        return parts.join('\n');
    }

    _deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * Get tracking stats for monitoring.
     */
    getStats() {
        return {
            callCount: this.callCount,
            hasCachedState: !!this.lastState,
            nextFullRefresh: this.fullRefreshInterval - (this.callCount % this.fullRefreshInterval)
        };
    }
}
