const axios = require('axios');

/**
 * Shared LLM client.
 *
 * Supports any OpenAI-compatible endpoint (OpenAI, vLLM, LiteLLM, LM Studio, …)
 * AND the legacy Ollama native API, selected purely via environment so modules
 * need no branching of their own.
 *
 * Configuration (preferred — OpenAI-compatible):
 *   LLM_BASE_URL          e.g. http://YOUR-LLM-HOST:PORT/v1   (presence of this enables OpenAI mode)
 *   LLM_API_KEY           Bearer token for the endpoint
 *   LLM_MODEL             the model name to request
 *   LLM_ENABLE_THINKING   "true" keeps reasoning output; default "false" → fast, clean output
 *
 * Legacy fallback (used when LLM_BASE_URL is unset):
 *   OLLAMA_URL / OLLAMA_MODEL → native POST /api/generate
 *
 * For reasoning models, enabling thinking streams the chain into
 * `message.reasoning_content` and the answer into `message.content`. We disable
 * thinking by default (chat_template_kwargs.enable_thinking=false) so the analysis
 * tasks get deterministic content without burning the token budget.
 */

function cfg() {
  const baseUrl = process.env.LLM_BASE_URL || '';
  const openai = !!baseUrl;
  return {
    openai,
    baseUrl: baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL || 'llama3:8b',
    enableThinking: String(process.env.LLM_ENABLE_THINKING || 'false') === 'true',
  };
}

async function isAvailable(timeoutMs = 5000) {
  const c = cfg();
  try {
    if (c.openai) {
      const r = await axios.get(`${c.baseUrl}/models`, {
        timeout: timeoutMs,
        headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      });
      return r.status === 200;
    }
    const r = await axios.get(`${c.baseUrl}/api/tags`, { timeout: timeoutMs });
    return r.status === 200;
  } catch (e) {
    return false;
  }
}

/**
 * Run a completion.
 * @param {string|Array|{system?:string,user?:string}} promptOrMessages
 * @param {{maxTokens?:number,temperature?:number,timeout?:number,json?:boolean}} opts
 * @returns {Promise<string|null>} text content (reasoning stripped) or null on failure
 */
async function complete(promptOrMessages, opts = {}) {
  const c = cfg();
  const { maxTokens = 1000, temperature = 0.4, timeout = 120000, json = false, model = null } = opts;

  let messages;
  if (typeof promptOrMessages === 'string') {
    messages = [{ role: 'user', content: promptOrMessages }];
  } else if (Array.isArray(promptOrMessages)) {
    messages = promptOrMessages;
  } else {
    messages = [];
    if (promptOrMessages.system) messages.push({ role: 'system', content: promptOrMessages.system });
    if (promptOrMessages.user) messages.push({ role: 'user', content: promptOrMessages.user });
  }

  try {
    if (c.openai) {
      const body = { model: model || c.model, messages, max_tokens: maxTokens, temperature };
      if (!c.enableThinking) body.chat_template_kwargs = { enable_thinking: false };
      if (json) body.response_format = { type: 'json_object' };
      const r = await axios.post(`${c.baseUrl}/chat/completions`, body, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
      });
      const msg = r.data?.choices?.[0]?.message;
      const content = msg?.content && msg.content.trim();
      return content || null;
    }

    // Legacy Ollama native API
    const prompt = messages
      .map(m => (m.role === 'system' ? `[System] ${m.content}` : m.content))
      .join('\n\n');
    const r = await axios.post(`${c.baseUrl}/api/generate`, {
      model: model || c.model,
      prompt,
      stream: false,
      options: { temperature, num_predict: maxTokens, num_ctx: 4096 },
    }, { timeout });
    return r.data?.response || null;
  } catch (e) {
    console.error('[LLM] complete() error:', e.response?.status || '', e.message);
    return null;
  }
}

function describe() {
  const c = cfg();
  return `${c.openai ? 'openai' : 'ollama'}:${c.model} @ ${c.baseUrl}`;
}

module.exports = { isAvailable, complete, describe, config: cfg };
