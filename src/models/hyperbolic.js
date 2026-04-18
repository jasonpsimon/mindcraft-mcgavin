import { getKey } from '../utils/keys.js';
import { stripThinkTags } from '../utils/text.js';
import { withLLMMetrics } from '../utils/retry.js';

// Hyperbolic's raw-fetch OpenAI-style endpoint returns the standard
// `{ choices: [{ finish_reason, message }], usage: { prompt_tokens,
// completion_tokens, total_tokens } }` shape wrapped in a raw Response —
// after .json() it matches the default extractor. A thin wrapper keeps the
// extraction explicit so the [LLM] line format stays uniform even when the
// raw-fetch error path returns a malformed body.
function _extractHyperbolicUsage(response) {
    if (!response || typeof response !== 'object') {
        return { prompt_tokens: null, completion_tokens: null, total_tokens: null, finish_reason: null, cache_hit: null };
    }
    const usage = response.usage || {};
    const firstChoice = Array.isArray(response.choices) ? response.choices[0] : null;
    return {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        finish_reason: firstChoice?.finish_reason ?? null,
        cache_hit: null,
    };
}

export class Hyperbolic {
    static prefix = 'hyperbolic';
    constructor(modelName, apiUrl) {
        this.modelName = modelName || "deepseek-ai/DeepSeek-V3";
        this.apiUrl = apiUrl || "https://api.hyperbolic.xyz/v1/chat/completions";

        // Retrieve the Hyperbolic API key from keys.js
        this.apiKey = getKey('HYPERBOLIC_API_KEY');
        if (!this.apiKey) {
            throw new Error('HYPERBOLIC_API_KEY not found. Check your keys.js file.');
        }
    }

    /**
     * Sends a chat completion request to the Hyperbolic endpoint.
     *
     * @param {Array} turns - An array of message objects, e.g. [{role: 'user', content: 'Hi'}].
     * @param {string} systemMessage - The system prompt or instruction.
     * @param {string} stopSeq - A stopping sequence, default '***'.
     * @returns {Promise<string>} - The model's reply.
     */
    async sendRequest(turns, systemMessage, stopSeq = '***') {
        // Prepare the messages with a system prompt at the beginning
        const messages = [{ role: 'system', content: systemMessage }, ...turns];

        // Build the request payload
        const payload = {
            model: this.modelName,
            messages: messages,
            max_tokens: 8192,
            temperature: 0.7,
            top_p: 0.9,
            stream: false
        };

        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting Hyperbolic API response... (attempt: ${attempt})`);
            console.log('Messages:', messages);

            let completionContent = null;

            try {
                // Wrap goes inside the think-block retry loop so each attempt
                // emits one [LLM] line, matching the BT-3 per-round-trip
                // convention. The inner async call returns the parsed JSON
                // body so _extractHyperbolicUsage sees the usage block.
                const data = await withLLMMetrics(
                    { label: 'Hyperbolic', model: this.modelName, extractUsage: _extractHyperbolicUsage },
                    async () => {
                        const response = await fetch(this.apiUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${this.apiKey}`
                            },
                            body: JSON.stringify(payload)
                        });
                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                        return response.json();
                    },
                );
                if (data?.choices?.[0]?.finish_reason === 'length') {
                    throw new Error('Context length exceeded');
                }

                completionContent = data?.choices?.[0]?.message?.content || '';
                console.log('Received response from Hyperbolic.');
            } catch (err) {
                if (
                    (err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') &&
                    turns.length > 1
                ) {
                    console.log('Context length exceeded, trying again with a shorter context...');
                    return await this.sendRequest(turns.slice(1), systemMessage, stopSeq);
                } else {
                    console.error(err);
                    completionContent = 'My brain disconnected, try again.';
                }
            }

            // Partial <think> block (open without close) — retry the request
            if (completionContent.includes("<think>") && !completionContent.includes("</think>")) {
                console.warn("Partial <think> block detected. Re-generating...");
                continue;
            }

            finalRes = stripThinkTags(completionContent).replace(/<\|separator\|>/g, '*no response*');
            break; // Valid response obtained—exit loop
        }

        if (finalRes == null) {
            console.warn("Could not get a valid <think> block or normal response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Hyperbolic.');
    }
}
