// Opt-in diagnostic logging. Off by default so day-to-day runs stay quiet and,
// critically, never emit provider payloads or credential material. Enable with
// LLM_USAGE_DEBUG=1. Callers must pass only a scope and a static, payload-free
// message — never account data, tokens, or raw provider output.
export function debugLog(scope: string, message: string): void {
  if (process.env.LLM_USAGE_DEBUG) {
    console.error(`[llm-usage:${scope}] ${message}`);
  }
}
