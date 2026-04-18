import { strictFormat, stripThinkTags } from '../utils/text.js';
import { withLLMMetrics } from '../utils/retry.js';

// Ollama's /api/chat returns `{ message: { content }, eval_count,
// prompt_eval_count }` instead of OpenAI's `usage` block. Normalize so the
// [LLM] line format stays uniform.
function _extractOllamaUsage(response) {
    if (!response || typeof response !== 'object') {
        return { prompt_tokens: null, completion_tokens: null, total_tokens: null, finish_reason: null, cache_hit: null };
    }
    const promptTok = typeof response.prompt_eval_count === 'number' ? response.prompt_eval_count : null;
    const completionTok = typeof response.eval_count === 'number' ? response.eval_count : null;
    const totalTok = (typeof promptTok === 'number' && typeof completionTok === 'number')
        ? promptTok + completionTok
        : null;
    return {
        prompt_tokens: promptTok,
        completion_tokens: completionTok,
        total_tokens: totalTok,
        finish_reason: response.done_reason ?? (response.done ? 'stop' : null),
        cache_hit: null,
    };
}

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embeddings';
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                // Wrap goes inside the think-block retry loop so each attempt
                // emits one [LLM] line, matching the BT-3 per-round-trip
                // convention.
                let apiResponse = await withLLMMetrics(
                    { label: 'Ollama', model, extractUsage: _extractOllamaUsage },
                    () => this.send(this.chat_endpoint, {
                        model: model,
                        messages: messages,
                        stream: false,
                        ...(this.params || {})
                    }),
                );
                if (apiResponse) {
                    res = apiResponse['message']['content'];
                } else {
                    res = 'No response data.';
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else {
                    console.log(err);
                    res = 'My brain disconnected, try again.';
                }
            }

            if (res.includes("<think>") && !res.includes("</think>")) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            finalRes = stripThinkTags(res);
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        let res = await withLLMMetrics(
            { label: 'Ollama-Embed', model, extractUsage: _extractOllamaUsage },
            () => this.send(this.embedding_endpoint, body),
        );
        return res['embedding'];
    }

    async send(endpoint, body) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const request = new Request(url, { method, headers, body: JSON.stringify(body) });
        let data = null;
        try {
            const res = await fetch(request);
            if (res.ok) {
                data = await res.json();
            } else {
                throw new Error(`Ollama Status: ${res.status}`);
            }
        } catch (err) {
            console.error('Failed to send Ollama request.');
            console.error(err);
        }
        return data;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }
}
