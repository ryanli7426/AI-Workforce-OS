const REDACTION_MARKER = '[REDACTED]'
const OVERSIZED_LINE_MARKER = '[REDACTED: oversized line]'
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024
const MAX_PENDING_BYTES = 1024 * 1024
const MAX_SECRET_COUNT = 128
const MAX_SECRET_BYTES = 8 * 1024
const MAX_TOTAL_SECRET_BYTES = 64 * 1024

const CREDENTIAL_KEY = String.raw`(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pat|credential)`
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?:"|')?\b${CREDENTIAL_KEY}\b(?:"|')?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)`,
  'gi',
)
const BEARER_PATTERN = /\b(Bearer)(\s+)([A-Za-z0-9._~+/=-]+)/gi
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{8,}/gi
const OPENAI_KEY_PATTERN = /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{16,}/g
const CURSOR_KEY_PATTERN = /\b(?:cursor_(?:pat|token)_[A-Za-z0-9_-]{8,}|cpk_[A-Za-z0-9_-]{8,}|key_[A-Za-z0-9_-]{16,})\b/gi
const PAT_PATTERN = /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{8,}|pat_[A-Za-z0-9_-]{8,})\b/g

export interface StreamingRedactorOptions {
  secrets?: readonly string[]
  maxPendingBytes?: number
}

function validateSecrets(secrets: readonly string[] | undefined): string[] {
  if (secrets === undefined) return []
  if (!Array.isArray(secrets)) throw new TypeError('Configured secrets must be an array')
  if (secrets.length > MAX_SECRET_COUNT) throw new RangeError('Too many configured secrets')

  let totalBytes = 0
  const unique = new Set<string>()
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new TypeError('Configured secrets must be non-empty strings')
    }
    if (secret.includes('\n') || secret.includes('\r')) {
      throw new TypeError('Configured secrets must not contain line breaks')
    }

    const bytes = Buffer.byteLength(secret)
    if (bytes > MAX_SECRET_BYTES) throw new RangeError('A configured secret is too large')
    totalBytes += bytes
    if (totalBytes > MAX_TOTAL_SECRET_BYTES) {
      throw new RangeError('Configured secrets exceed the total size limit')
    }
    unique.add(secret)
  }

  return [...unique].sort((left, right) => right.length - left.length)
}

function configuredSecretPattern(secrets: readonly string[]): RegExp | undefined {
  if (secrets.length === 0) return undefined
  const alternatives = secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(alternatives.join('|'), 'g')
}

function applyRedaction(text: string, secretPattern?: RegExp): string {
  let redacted = text
  if (secretPattern !== undefined) {
    secretPattern.lastIndex = 0
    redacted = redacted.replace(secretPattern, REDACTION_MARKER)
  }

  redacted = redacted.replace(ASSIGNMENT_PATTERN, (_match: string, prefix: string, value: string) => {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return `${prefix}${quote}${REDACTION_MARKER}${quote}`
    }
    return `${prefix}${REDACTION_MARKER}`
  })
  redacted = redacted.replace(BEARER_PATTERN, (_match: string, scheme: string, spacing: string) =>
    `${scheme}${spacing}${REDACTION_MARKER}`)
  redacted = redacted.replace(ANTHROPIC_KEY_PATTERN, REDACTION_MARKER)
  redacted = redacted.replace(OPENAI_KEY_PATTERN, REDACTION_MARKER)
  redacted = redacted.replace(CURSOR_KEY_PATTERN, REDACTION_MARKER)
  redacted = redacted.replace(PAT_PATTERN, REDACTION_MARKER)
  return redacted
}

export function redact(text: string, secrets?: readonly string[]): string {
  if (typeof text !== 'string') throw new TypeError('Text to redact must be a string')
  return applyRedaction(text, configuredSecretPattern(validateSecrets(secrets)))
}

export class StreamingRedactor {
  readonly #maxPendingBytes: number
  readonly #secretPattern: RegExp | undefined
  readonly #decoder = new TextDecoder('utf-8')
  #pending = ''
  #pendingBytes = 0
  #trailingHighSurrogate = ''
  #droppingOversizedLine = false
  #ended = false

  constructor(options: StreamingRedactorOptions = {}) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('Streaming redactor options must be an object')
    }

    const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0 || maxPendingBytes > MAX_PENDING_BYTES) {
      throw new RangeError('maxPendingBytes is outside the supported range')
    }

    this.#maxPendingBytes = maxPendingBytes
    this.#secretPattern = configuredSecretPattern(validateSecrets(options.secrets))
  }

  write(chunk: string | Buffer): string {
    if (this.#ended) throw new Error('Cannot write after redactor end')
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
      throw new TypeError('Redactor chunks must be strings or Buffers')
    }

    if (typeof chunk === 'string') {
      const flushedBytes = this.#decoder.decode()
      return this.#consume(flushedBytes + this.#prepareStringChunk(chunk))
    }

    let decoded = ''
    if (this.#trailingHighSurrogate !== '') {
      decoded = '�'
      this.#trailingHighSurrogate = ''
    }
    decoded += this.#decoder.decode(chunk, { stream: true })
    return this.#consume(decoded)
  }

  end(): string {
    if (this.#ended) throw new Error('Redactor has already ended')

    let decoded = ''
    if (this.#trailingHighSurrogate !== '') {
      decoded = '�'
      this.#trailingHighSurrogate = ''
    }
    decoded += this.#decoder.decode()

    let output = this.#consume(decoded)
    if (!this.#droppingOversizedLine && this.#pending !== '') {
      output += applyRedaction(this.#pending, this.#secretPattern)
      this.#clearPending()
    }
    this.#ended = true
    return output
  }

  #prepareStringChunk(chunk: string): string {
    let text = this.#trailingHighSurrogate + chunk
    this.#trailingHighSurrogate = ''
    if (text.length === 0) return text

    const finalCodeUnit = text.charCodeAt(text.length - 1)
    if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
      this.#trailingHighSurrogate = text.at(-1) ?? ''
      text = text.slice(0, -1)
    }
    return text
  }

  #consume(text: string): string {
    if (text.length === 0) return ''

    const output: string[] = []
    let start = 0
    while (start < text.length) {
      const newline = text.indexOf('\n', start)
      const end = newline === -1 ? text.length : newline
      const segment = text.slice(start, end)

      if (!this.#droppingOversizedLine) {
        const segmentBytes = Buffer.byteLength(segment)
        if (this.#pendingBytes + segmentBytes > this.#maxPendingBytes) {
          this.#clearPending()
          this.#droppingOversizedLine = true
          output.push(OVERSIZED_LINE_MARKER)
        } else {
          this.#pending += segment
          this.#pendingBytes += segmentBytes
        }
      }

      if (newline === -1) break
      if (this.#droppingOversizedLine) {
        output.push('\n')
        this.#droppingOversizedLine = false
      } else {
        output.push(applyRedaction(this.#pending, this.#secretPattern), '\n')
        this.#clearPending()
      }
      start = newline + 1
    }

    return output.join('')
  }

  #clearPending(): void {
    this.#pending = ''
    this.#pendingBytes = 0
  }
}
