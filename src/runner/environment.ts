/** Explicit, in-memory Runtime credential injection. Never serialized into requests, records or logs. */
const ALLOWED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'])
export const RUNTIME_ENV_CHANNEL = 'WORKFORCE_RUNTIME_ENV_JSON'
export function validateRuntimeEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Runtime environment')
  const result: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (!ALLOWED.has(name) || typeof item !== 'string' || item.includes('\0') || item.length > 16_384)
      throw new Error('Unsupported or malformed Runtime environment field')
    result[name] = item
  }
  return result
}
