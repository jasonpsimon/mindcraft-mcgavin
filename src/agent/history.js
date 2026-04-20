import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { EpisodicMemory } from '../memory/episodic_memory.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        // Kept for backwards compatibility — episodic memory supplements this
        this.memory = '';

        // Episodic memory: vector-embedded event storage for semantic retrieval
        // Embedding model is set later via initEpisodicMemory() after prompter is ready
        this.episodic = new EpisodicMemory(this.name, null, settings.episodic_memory || {});

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    /**
     * Initialize episodic memory with the embedding model once available.
     * Called after prompter is initialized in agent.start().
     */
    async initEpisodicMemory(embeddingModel) {
        this.episodic.embeddingModel = embeddingModel;
        await this.episodic.reembed(); // re-embed any loaded episodes that lack vectors
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        // Store in episodic memory (non-lossy, vector-embedded).
        // This is the real memory capture — it runs unconditionally.
        try {
            const currentGoal = this.agent.self_prompter?.isStopped?.()
                ? null : this.agent.self_prompter?.prompt;
            await this.episodic.addEpisode(turns, { goal: currentGoal });
        } catch (err) {
            console.warn('[History] Episodic memory storage failed:', err.message);
        }

        // Legacy 500-char freeform summary — upstream kolbytn/mindcraft behavior.
        // When ContextBuilder is on (mcgavin default), conversation prompts route
        // through episodic + long-term memory at priority 6 and never read
        // `history.memory`. The coding template had $MEMORY removed as part of
        // the D1 deprecation (2026-04-15), so nothing reads this value anymore.
        // Skip the LLM call entirely when CB is enabled — saves one inference per
        // 5 turns and eliminates the "Memory truncated to 500 chars" warning.
        // #21 L1.3: `use_context_builder` default lives at settings.js:100 (true).
        if (!settings.use_context_builder) {
            console.log("Storing memories (legacy summary path)...");
            this.memory = await this.agent.prompter.promptMemSaving(turns);

            if (this.memory.length > 500) {
                this.memory = this.memory.slice(0, 500);
                this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
            }

            console.log("Memory updated to: ", this.memory);
        }
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            // BT-bundle(c): the init write was outside the try/catch below —
            // a missing histories dir or permission error would propagate
            // up into async appendFullHistory's caller with no [History]
            // log. Wrap it, log, and reset fp so a later call may retry.
            try {
                writeFileSync(this.full_history_fp, '[]', 'utf8');
            } catch (err) {
                console.error(`[History] init write failed ${this.full_history_fp}: ${err.message}`);
                this.full_history_fp = undefined;
                return;
            }
        }
        // BT-bundle(c): catch covers read→parse→push→write; prior message
        // said "Error reading" which was misleading on write-side throws.
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error appending to ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            // Fire-and-forget: memory summarization runs in the background
            // under the GenerationLock (Priority.MEMORY) so it won't compete
            // with in-flight PLAYER or SELF generations.
            this.summarizeMemories(chunk).catch(err => {
                console.warn('[History] Background memory summarization failed:', err.message);
            });
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                goal_queue: this.agent.self_prompter.goalQueue || [],
                persistent_rules: (this.agent.self_prompter.persistentRules || []).map(r => ({
                    id: r.id, description: r.description, action: r.action
                })),
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}
