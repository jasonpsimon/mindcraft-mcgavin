import Replicate from 'replicate';
import { toSinglePrompt } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { withLLMMetrics } from '../utils/retry.js';

// llama, mistral
export class ReplicateAPI {
	static prefix = 'replicate';
	constructor(model_name, url, params) {
		this.model_name = model_name;
		this.url = url;
		this.params = params;

		if (this.url) {
			console.warn('Replicate API does not support custom URLs. Ignoring provided URL.');
		}

		this.replicate = new Replicate({
			auth: getKey('REPLICATE_API_KEY'),
		});
	}

	async sendRequest(turns, systemMessage) {
		const stop_seq = '***';
		const prompt = toSinglePrompt(turns, null, stop_seq);
		let model_name = this.model_name || 'meta/meta-llama-3-70b-instruct';

		const input = { 
			prompt, 
			system_prompt: systemMessage,
			...(this.params || {})
		};
		let res = null;
		try {
			console.log('Awaiting Replicate API response...');
			// Replicate streams token-by-token via an async iterator and does
			// not surface a usage block on the final chunk — the wrapper's
			// default extractUsage will see no `usage` field and emit all
			// null-token fields, which is accepted for streaming adapters
			// (same convention as HuggingFace). The wrap still captures
			// elapsed_ms + status + retries so the [LLM] line shape stays
			// uniform.
			const result = await withLLMMetrics(
				{ label: 'Replicate', model: model_name },
				async () => {
					let acc = '';
					for await (const event of this.replicate.stream(model_name, { input })) {
						acc += event;
						if (acc === '') break;
						if (acc.includes(stop_seq)) {
							acc = acc.slice(0, acc.indexOf(stop_seq));
							break;
						}
					}
					return acc;
				},
			);
			res = result;
		} catch (err) {
			console.log(err);
			res = 'My brain disconnected, try again.';
		}
		console.log('Received.');
		return res;
	}

	async embed(text) {
		const embedModel = this.model_name || "mark3labs/embeddings-gte-base:d619cff29338b9a37c3d06605042e1ff0594a8c3eff0175fd6967f5643fc4d47";
		const output = await withLLMMetrics(
			{ label: 'Replicate-Embed', model: embedModel },
			() => this.replicate.run(embedModel, { input: {text} }),
		);
		return output.vectors;
	}
}