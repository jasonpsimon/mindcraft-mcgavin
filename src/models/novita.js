import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat, stripThinkTags } from '../utils/text.js';

// llama, mistral
export class Novita {
	static prefix = 'novita';
	constructor(model_name, url, params) {
    this.model_name = model_name;
    this.url = url || 'https://api.novita.ai/v3/openai';
    this.params = params;


    let config = {
      baseURL: this.url
    };
    config.apiKey = getKey('NOVITA_API_KEY');

    this.openai = new OpenAIApi(config);
  }

	async sendRequest(turns, systemMessage, stop_seq='***') {
      let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

      
      messages = strictFormat(messages);
      
      const pack = {
          model: this.model_name || "meta-llama/llama-4-scout-17b-16e-instruct",
          messages,
          stop: [stop_seq],
          ...(this.params || {})
      };

      let res = null;
      try {
          console.log('Awaiting novita api response...')
          let completion = await this.openai.chat.completions.create(pack);
          if (completion.choices[0].finish_reason == 'length')
              throw new Error('Context length exceeded'); 
          console.log('Received.')
          res = completion.choices[0].message.content;
      }
      catch (err) {
          if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
              console.log('Context length exceeded, trying again with shorter context.');
              return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
          } else {
            console.log(err);
              res = 'My brain disconnected, try again.';
          }
      }
      return stripThinkTags(res);
  }

	async embed(text) {
		throw new Error('Embeddings are not supported by Novita AI.');
	}
}
