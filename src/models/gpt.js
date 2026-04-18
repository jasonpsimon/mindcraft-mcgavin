import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import { withLLMMetrics } from '../utils/retry.js';

// GPT-style `responses.create` returns `{ output_text, usage: { input_tokens,
// output_tokens, total_tokens } }` instead of the OpenAI chat shape. Normalize
// to the same fields the default extractor produces so the [LLM] line format
// stays uniform with the chat path.
function _extractGPTResponsesUsage(response) {
    if (!response || typeof response !== 'object') {
        return { prompt_tokens: null, completion_tokens: null, total_tokens: null, finish_reason: null, cache_hit: null };
    }
    const usage = response.usage || {};
    return {
        prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
        completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        finish_reason: response.incomplete_details?.reason ?? response.status ?? null,
        cache_hit: null,
    };
}

export class GPT {
    static prefix = 'openai';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url; // store so that we know whether a custom URL has been set

        let config = {};
        if (url)
            config.baseURL = url;

        if (hasKey('OPENAI_ORG_ID'))
            config.organization = getKey('OPENAI_ORG_ID');

        config.apiKey = getKey('OPENAI_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = strictFormat(turns);
        messages = messages.map(message => {
            message.content += stop_seq;
            return message;
        });
        let model = this.model_name || "gpt-4o-mini";

        let res = null;

        try {
            console.log('Awaiting openai api response from model', model);
            // if a custom URL is set, use chat.completions
            // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
            if (this.url) {
                let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
                messages = strictFormat(messages);
                const pack = {
                    model: model,
                    messages,
                    stop: stop_seq,
                    ...(this.params || {})
                };
                if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
                    delete pack.stop;
                }
                let completion = await withLLMMetrics(
                    { label: this.constructor.name, model },
                    () => this.openai.chat.completions.create(pack),
                );
                if (completion.choices[0].finish_reason == 'length')
                    throw new Error('Context length exceeded');
                console.log('Received.');
                res = completion.choices[0].message.content;
            }
            // otherwise, use responses
            else {
                let messages = strictFormat(turns);
                messages = messages.map(message => {
                    message.content += stop_seq;
                    return message;
                });
                const response = await withLLMMetrics(
                    { label: `${this.constructor.name}-Responses`, model, extractUsage: _extractGPTResponsesUsage },
                    () => this.openai.responses.create({
                        model: model,
                        instructions: systemMessage,
                        input: messages,
                        ...(this.params || {})
                    }),
                );
                console.log('Received.');
                res = response.output_text;
                let stop_seq_index = res.indexOf(stop_seq);
                res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
            }
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else if (err.message.includes('image_url')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "input_text", text: systemMessage },
                {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedModel = this.model_name || "text-embedding-3-small";
        const embedding = await withLLMMetrics(
            { label: `${this.constructor.name}-Embed`, model: embedModel },
            () => this.openai.embeddings.create({
                model: embedModel,
                input: text,
                encoding_format: "float",
            }),
        );
        return embedding.data[0].embedding;
    }

}

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = {
        model: model,
        voice: voice,
        input: text
    }

    let config = {};

    if (url)
        config.baseURL = url;

    if (hasKey('OPENAI_ORG_ID'))
        config.organization = getKey('OPENAI_ORG_ID');

    config.apiKey = getKey('OPENAI_API_KEY');

    const openai = new OpenAIApi(config);

    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const base64 = buffer.toString("base64");
    return base64;
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
}
