import { toSinglePrompt, stripThinkTags } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { HfInference } from "@huggingface/inference";

export class HuggingFace {
  static prefix = 'huggingface';
  constructor(model_name, url, params) {
    // Remove 'huggingface/' prefix if present
    this.model_name = model_name.replace('huggingface/', '');
    this.url = url;
    this.params = params;

    if (this.url) {
      console.warn("Hugging Face doesn't support custom urls!");
    }

    this.huggingface = new HfInference(getKey('HUGGINGFACE_API_KEY'));
  }

  async sendRequest(turns, systemMessage) {
    const stop_seq = '***';
    // Build a single prompt from the conversation turns
    const prompt = toSinglePrompt(turns, null, stop_seq);
    // Fallback model if none was provided
    const model_name = this.model_name || 'meta-llama/Meta-Llama-3-8B';
    // Combine system message with the prompt
    const input = systemMessage + "\n" + prompt;

    // We'll try up to 5 times in case of partial <think> blocks for DeepSeek-R1 models.
    const maxAttempts = 5;
    let attempt = 0;
    let finalRes = null;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Awaiting Hugging Face API response... (model: ${model_name}, attempt: ${attempt})`);
      let res = '';
      try {
        // Consume the streaming response chunk by chunk
        for await (const chunk of this.huggingface.chatCompletionStream({
          model: model_name,
          messages: [{ role: "user", content: input }],
          ...(this.params || {})
        })) {
          res += (chunk.choices[0]?.delta?.content || "");
        }
      } catch (err) {
        console.log(err);
        res = 'My brain disconnected, try again.';
        // Break out immediately; we only retry when handling partial <think> tags.
        break;
      }

      // Partial <think> block (open without close) — retry the request
      if (res.includes("<think>") && !res.includes("</think>")) {
          console.warn("Partial <think> block detected. Re-generating...");
          continue;
      }

      finalRes = stripThinkTags(res);
      break; // Exit loop if we got a valid response.
    }

    // If no valid response was obtained after max attempts, assign a fallback.
    if (finalRes == null) {
      console.warn("Could not get a valid <think> block or normal response after max attempts.");
      finalRes = 'I thought too hard, sorry, try again.';
    }
    console.log('Received.');
    console.log(finalRes);
    return finalRes;
  }

  async embed(text) {
    throw new Error('Embeddings are not supported by HuggingFace.');
  }
}
