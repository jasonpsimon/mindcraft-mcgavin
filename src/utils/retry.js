/**
 * Retry Wrapper — Exponential backoff for async operations.
 *
 * Wraps any async function with configurable retry logic.
 * Used primarily for LLM API calls that may fail transiently
 * (network errors, rate limits, timeouts).
 *
 * Backoff formula: baseDelay * 2^attempt (capped at maxDelay)
 * With optional jitter to prevent thundering herd.
 */

/**
 * Execute an async function with exponential backoff retry.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} options
 * @param {number} options.maxRetries - Max retry attempts (default 3)
 * @param {number} options.baseDelay - Initial delay in ms (default 1000)
 * @param {number} options.maxDelay - Max delay cap in ms (default 30000)
 * @param {boolean} options.jitter - Add random jitter to delay (default true)
 * @param {Function} options.shouldRetry - Custom retry predicate (receives error, returns bool)
 * @param {Function} options.onRetry - Callback on each retry (receives error, attempt number)
 * @returns {Promise<*>} Result of fn()
 */
export async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 30000,
        jitter = true,
        shouldRetry = null,
        onRetry = null
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // Don't retry on final attempt
            if (attempt >= maxRetries) break;

            // Check if error is retryable
            if (shouldRetry && !shouldRetry(err)) break;

            // Default: don't retry context length errors (not transient)
            if (!shouldRetry && isNonRetryable(err)) break;

            // Calculate delay with exponential backoff
            let delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            if (jitter) {
                delay = delay * (0.5 + Math.random() * 0.5); // 50-100% of calculated delay
            }

            if (onRetry) {
                onRetry(err, attempt + 1, delay);
            } else {
                console.warn(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${err.message}. Retrying in ${Math.round(delay)}ms...`);
            }

            await new Promise(r => setTimeout(r, delay));
        }
    }

    throw lastError;
}

/**
 * Check if an error should NOT be retried (non-transient).
 */
function isNonRetryable(err) {
    const msg = (err.message || '').toLowerCase();
    const code = err.code || '';

    // Context length — retrying won't help
    if (msg.includes('context length') || code === 'context_length_exceeded') return true;

    // Auth errors — credentials won't fix themselves
    if (code === 'invalid_api_key' || msg.includes('authentication') || msg.includes('unauthorized')) return true;

    // Model not found
    if (code === 'model_not_found' || msg.includes('model not found')) return true;

    return false;
}

/**
 * Convenience wrapper for LLM API calls.
 * Pre-configured with sensible defaults for inference requests.
 */
export async function withLLMRetry(fn, label = 'LLM') {
    return withRetry(fn, {
        maxRetries: 3,
        baseDelay: 2000,
        maxDelay: 15000,
        jitter: true,
        onRetry: (err, attempt, delay) => {
            console.warn(`[${label}] Request failed (attempt ${attempt}/3): ${err.message}. Retrying in ${Math.round(delay)}ms...`);
        }
    });
}

// ---------------------------------------------------------------------------
// LLM call telemetry (BT-3)
// ---------------------------------------------------------------------------
//
// withLLMMetrics() wraps a single LLM round-trip with timing + token-usage
// logging on top of the same retry semantics as withLLMRetry. Emits exactly
// one [LLM] structured log line per invocation — on success OR on terminal
// failure after retries are exhausted.
//
// Philosophy alignment:
//   - Principle 1 (reduce LLM reliance): measurement is the prerequisite
//     to tuning. You can't tune what you can't measure.
//   - Principle 8 (fail loudly, informatively): [LLM] lines surface
//     latency, tokens, retries, and error class in a single scannable
//     prefix — no grep archaeology required.
//
// Rule alignment:
//   - Rule 1 (flexible): `extractUsage` is an optional callback so
//     non-OpenAI-shaped responses (Anthropic, Replicate, etc.) can opt
//     in without touching this file. Default covers OpenAI-compatible
//     (LM Studio, GPT, OpenRouter, etc.).
//   - Rule 5 (no adverse effects): the telemetry wrapper returns the
//     raw response from fn unchanged — callers see no behavior shift.
//     A failure to extract usage / emit the log is caught and logged
//     with its own prefix; it never propagates to the caller.
//
// Scope note (Principle 5 — Finish migrations, kill redundancy):
// Today only lmstudio.js routes through this helper. The other 19
// model adapters (gpt, claude, ollama, gemini, etc.) retain their
// original error handling and do NOT emit [LLM] lines. That migration
// is tracked as whiteboard entry BT-3b. The deferral is intentional:
// JP's only active LLM provider is LM Studio, and migrating 19
// untested adapters would add risk without value today.

/**
 * Default usage extractor for OpenAI-compatible responses.
 * Returns a normalized object with nullable fields where the response
 * doesn't carry the information.
 */
function _defaultExtractUsage(response) {
    if (!response || typeof response !== 'object') {
        return { prompt_tokens: null, completion_tokens: null, total_tokens: null, finish_reason: null, cache_hit: null };
    }
    const usage = response.usage || {};
    const firstChoice = Array.isArray(response.choices) ? response.choices[0] : null;
    // LM Studio sometimes returns prompt_tokens_details.cached_tokens when
    // the prompt cache was hit. Normalize to a single `cache_hit` boolean
    // when any cached tokens are reported.
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
    return {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        finish_reason: firstChoice?.finish_reason ?? null,
        cache_hit: typeof cachedTokens === 'number' ? (cachedTokens > 0) : null,
    };
}

/** Safely classify an error for the [LLM] status=error log line. */
function _errorClass(err) {
    if (!err) return 'unknown';
    return err.name || err.code || 'Error';
}

/**
 * Wrap an async LLM call with retry + one [LLM] structured log line.
 *
 * @param {object} context
 * @param {string} context.label            Short adapter label, e.g. "LMStudio".
 * @param {string} context.model            Model name being called.
 * @param {Function} [context.extractUsage] Optional response -> usage extractor.
 *                                          Defaults to OpenAI-compatible shape.
 * @param {object} [context.retryOptions]   Overrides for withRetry (maxRetries, etc.).
 * @param {Function} fn                     Async function performing the API call.
 * @returns {Promise<*>}                    Raw response from fn() (unchanged).
 */
export async function withLLMMetrics(context, fn) {
    const {
        label = 'LLM',
        model = '?',
        extractUsage = _defaultExtractUsage,
        retryOptions = {},
    } = context || {};

    const startedAt = Date.now();
    let retries = 0;

    // Build retry options. Count retries via onRetry; keep the same
    // user-visible warn log shape so behavior doesn't change for callers.
    const mergedRetryOptions = {
        maxRetries: 3,
        baseDelay: 2000,
        maxDelay: 15000,
        jitter: true,
        ...retryOptions,
        onRetry: (err, attempt, delay) => {
            retries = attempt; // final value = total retries executed
            if (typeof retryOptions.onRetry === 'function') {
                retryOptions.onRetry(err, attempt, delay);
            } else {
                console.warn(`[${label}] Request failed (attempt ${attempt}/3): ${err.message}. Retrying in ${Math.round(delay)}ms...`);
            }
        },
    };

    try {
        const result = await withRetry(fn, mergedRetryOptions);
        const elapsedMs = Date.now() - startedAt;
        try {
            const usage = extractUsage(result) || {};
            // tok_per_s — only meaningful when we have a token count AND
            // non-zero elapsed. Prefer completion_tokens (decode rate);
            // fall back to total_tokens when completion isn't exposed.
            const tokForRate = typeof usage.completion_tokens === 'number'
                ? usage.completion_tokens
                : usage.total_tokens;
            const tokPerSec = (typeof tokForRate === 'number' && elapsedMs > 0)
                ? Number((tokForRate / (elapsedMs / 1000)).toFixed(2))
                : null;
            console.log(
                `[LLM] label=${label} model=${model} elapsed_ms=${elapsedMs} ` +
                `prompt_tok=${usage.prompt_tokens ?? '?'} ` +
                `completion_tok=${usage.completion_tokens ?? '?'} ` +
                `total_tok=${usage.total_tokens ?? '?'} ` +
                `tok_per_s=${tokPerSec ?? '?'} ` +
                `retries=${retries} ` +
                `finish=${usage.finish_reason ?? '?'} ` +
                `cache_hit=${usage.cache_hit ?? '?'} ` +
                `status=ok`
            );
        } catch (logErr) {
            // Never let telemetry failure poison the return path.
            console.warn(`[LLM] telemetry extract failed (label=${label} model=${model}): ${logErr.message}`);
        }
        return result;
    } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        try {
            console.log(
                `[LLM] label=${label} model=${model} elapsed_ms=${elapsedMs} ` +
                `retries=${retries} status=error err_class=${_errorClass(err)}`
            );
        } catch (_) {
            // log emit should itself never throw, but guard anyway
        }
        throw err;
    }
}
