import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { withLLMMetrics } from '../utils/retry.js';

// Anthropic messages.create returns `{ usage: { input_tokens, output_tokens,
// cache_read_input_tokens? }, stop_reason, content: [...] }` — different shape
// from OpenAI's `usage.prompt_tokens / completion_tokens / total_tokens`.
// Normalize so the [LLM] line format stays uniform.
function _extractClaudeUsage(response) {
    if (!response || typeof response !== 'object') {
        return { prompt_tokens: null, completion_tokens: null, total_tokens: null, finish_reason: null, cache_hit: null };
    }
    const usage = response.usage || {};
    const promptTok = usage.input_tokens ?? null;
    const completionTok = usage.output_tokens ?? null;
    const totalTok = (typeof promptTok === 'number' && typeof completionTok === 'number')
        ? promptTok + completionTok
        : null;
    const cachedTok = usage.cache_read_input_tokens;
    return {
        prompt_tokens: promptTok,
        completion_tokens: completionTok,
        total_tokens: totalTok,
        finish_reason: response.stop_reason ?? null,
        cache_hit: typeof cachedTok === 'number' ? (cachedTok > 0) : null,
    };
}

export class Claude {
    static prefix = 'anthropic';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};
        if (url)
            config.baseURL = url;
        
        config.apiKey = getKey('ANTHROPIC_API_KEY');

        this.anthropic = new Anthropic(config);
    }

    async sendRequest(turns, systemMessage) {
        const messages = strictFormat(turns);
        let res = null;
        try {
            console.log(`Awaiting anthropic response from ${this.model_name}...`)
            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000;
                    // max_tokens must be greater than thinking.budget_tokens
                } else {
                    this.params.max_tokens = 4096;
                }
            }
            const claudeModel = this.model_name || "claude-sonnet-4-20250514";
            const resp = await withLLMMetrics(
                { label: 'Claude', model: claudeModel, extractUsage: _extractClaudeUsage },
                () => this.anthropic.messages.create({
                    model: claudeModel,
                    system: systemMessage,
                    messages: messages,
                    ...(this.params || {})
                }),
            );

            console.log('Received.')
            // get first content of type text
            const textContent = resp.content.find(content => content.type === 'text');
            if (textContent) {
                res = textContent.text;
            } else {
                console.warn('No text content found in the response.');
                res = 'No response from Claude.';
            }
        }
        catch (err) {
            if (err.message.includes("does not support image input")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = "My brain disconnected, try again.";
            }
            console.log(err);
        }
        return res;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemMessage
                },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude.');
    }
}
