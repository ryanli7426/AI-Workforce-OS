import { describe, expect, it } from 'vitest'
import { redact, StreamingRedactor } from '../src/security/redaction.ts'

function collect(redactor: StreamingRedactor, chunks: Array<string | Buffer>): string {
  let output = ''
  for (const chunk of chunks) output += redactor.write(chunk)
  return output + redactor.end()
}

describe('redact', () => {
  it('redacts exact configured literals without treating them as regular expressions', () => {
    expect(redact('short=a.b long=a.b-123 repeated=a.b', ['a.b', 'a.b-123'])).toBe(
      'short=[REDACTED] long=[REDACTED] repeated=[REDACTED]',
    )
  })

  it('redacts common provider, PAT, bearer, and credential assignment forms', () => {
    const input = [
      'raw anthropic sk-ant-api03-abcdefghijklmnop',
      'raw openai sk-proj-abcdefghijklmnopqrstuv',
      'raw cursor key_abcdefghijklmnopqrstuv',
      'raw github github_pat_abcdefghijklmnop',
      'ANTHROPIC_API_KEY=sk-ant-short-but-assigned',
      'openai_api_key = "sk-proj-short"',
      "cursor_token='cursor-value'",
      'PAT=personal-access-token',
      'Authorization: Bearer header.payload.signature',
      'database_password=hunter2',
    ].join('\n')

    const result = redact(input)
    expect(result).toBe([
      'raw anthropic [REDACTED]',
      'raw openai [REDACTED]',
      'raw cursor [REDACTED]',
      'raw github [REDACTED]',
      'ANTHROPIC_API_KEY=[REDACTED]',
      'openai_api_key = "[REDACTED]"',
      "cursor_token='[REDACTED]'",
      'PAT=[REDACTED]',
      'Authorization: Bearer [REDACTED]',
      'database_password=[REDACTED]',
    ].join('\n'))
    expect(result).not.toContain('hunter2')
    expect(result).not.toContain('header.payload.signature')
  })

  it('does not include configured values in validation errors', () => {
    const sensitive = `do-not-print-${'x'.repeat(9_000)}`
    let message = ''
    try {
      redact('input', [sensitive])
    } catch (error) {
      message = String(error)
    }
    expect(message).not.toContain('do-not-print')
    expect(message).not.toContain(sensitive)
  })
})

describe('StreamingRedactor', () => {
  it('redacts a configured secret at every string chunk boundary', () => {
    const secret = 'seeded-secret-value'
    const input = `before ${secret} after\n`
    for (let boundary = 0; boundary <= input.length; boundary += 1) {
      const output = collect(
        new StreamingRedactor({ secrets: [secret] }),
        [input.slice(0, boundary), input.slice(boundary)],
      )
      expect(output, `split at character ${boundary}`).toBe('before [REDACTED] after\n')
    }
  })

  it('redacts a configured secret at every Buffer byte boundary', () => {
    const secret = 'buffer-secret-value'
    const input = Buffer.from(`prefix:${secret}:suffix\n`)
    for (let boundary = 0; boundary <= input.length; boundary += 1) {
      const output = collect(
        new StreamingRedactor({ secrets: [secret] }),
        [input.subarray(0, boundary), input.subarray(boundary)],
      )
      expect(output, `split at byte ${boundary}`).toBe('prefix:[REDACTED]:suffix\n')
    }
  })

  it('preserves unicode split across individual UTF-8 bytes while redacting the line', () => {
    const secret = '密钥-🔐-value'
    const input = Buffer.from(`日志 🔎 ${secret} 完成\n`)
    const chunks = [...input].map((_byte, index) => input.subarray(index, index + 1))
    expect(collect(new StreamingRedactor({ secrets: [secret] }), chunks)).toBe(
      '日志 🔎 [REDACTED] 完成\n',
    )
  })

  it('preserves a surrogate pair split across string chunks', () => {
    const value = 'before 🔐 after\n'
    const split = value.indexOf('🔐') + 1
    expect(collect(new StreamingRedactor(), [value.slice(0, split), value.slice(split)])).toBe(value)
  })

  it('buffers incomplete lines and redacts them when end flushes', () => {
    const redactor = new StreamingRedactor({ secrets: ['final-secret'] })
    expect(redactor.write('unfinished final-')).toBe('')
    expect(redactor.write('secret')).toBe('')
    expect(redactor.end()).toBe('unfinished [REDACTED]')
  })

  it('redacts multiple configured and detected credentials on one line', () => {
    const output = collect(
      new StreamingRedactor({ secrets: ['first-secret', 'second-secret'] }),
      ['first-', 'secret OPENAI_API_KEY=provider-value second-secret Bearer bearer-value\n'],
    )
    expect(output).toBe(
      '[REDACTED] OPENAI_API_KEY=[REDACTED] [REDACTED] Bearer [REDACTED]\n',
    )
  })

  it('bounds an unterminated oversized line and resumes after its newline', () => {
    const redactor = new StreamingRedactor({ maxPendingBytes: 8 })
    let output = redactor.write('123456789')
    output += redactor.write('discarded-secret-tail')
    output += redactor.write('\nok\n')
    output += redactor.end()

    expect(output).toBe('[REDACTED: oversized line]\nok\n')
    expect(output).not.toContain('123456789')
    expect(output).not.toContain('discarded-secret-tail')
  })

  it('uses independent state for separate output streams', () => {
    const stdout = new StreamingRedactor({ secrets: ['stdout-secret'] })
    const stderr = new StreamingRedactor({ secrets: ['stderr-secret'] })

    expect(stdout.write('stdout-')).toBe('')
    expect(stderr.write('stderr-secret\n')).toBe('[REDACTED]\n')
    expect(stdout.write('secret\n')).toBe('[REDACTED]\n')
    expect(stdout.end()).toBe('')
    expect(stderr.end()).toBe('')
  })

  it('rejects unsafe configuration without exposing secret contents', () => {
    const sensitive = `private-material-${'z'.repeat(9_000)}`
    const invalidConfigurations = [
      () => new StreamingRedactor({ secrets: [sensitive] }),
      () => new StreamingRedactor({ secrets: ['line-one\nline-two'] }),
      () => new StreamingRedactor({ secrets: Array.from({ length: 129 }, (_, index) => `value-${index}`) }),
      () => new StreamingRedactor({ maxPendingBytes: Number.POSITIVE_INFINITY }),
    ]

    for (const create of invalidConfigurations) {
      let message = ''
      try {
        create()
      } catch (error) {
        message = String(error)
      }
      expect(message).not.toContain('private-material')
      expect(message).not.toContain('line-one')
      expect(message).not.toContain(sensitive)
    }
  })

  it('rejects writes after end', () => {
    const redactor = new StreamingRedactor()
    expect(redactor.end()).toBe('')
    expect(() => redactor.write('later')).toThrow()
    expect(() => redactor.end()).toThrow()
  })
})
