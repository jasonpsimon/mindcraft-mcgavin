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
