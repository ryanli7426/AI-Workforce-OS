#!/usr/bin/env node
/**
 * Mock Claude Code CLI for LocalOrchestrator tests.
 * Speaks the same argv/stdout JSON contract as ClaudeCodeAdapter; no network or model calls.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const args = process.argv.slice(2)
const prompt = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : ''
const cwd = process.cwd()

const countPath = join(cwd, '.fixture-launch-count')
appendFileSync(countPath, `${process.pid}\n`, { encoding: 'utf8' })

function modeFromPrompt() {
  const match = /FIXTURE_MODE=([a-z0-9_-]+)/i.exec(prompt)
  if (match) return match[1].toLowerCase()
  const marker = join(cwd, '.fixture-mode')
  if (existsSync(marker)) {
    return readFileSync(marker, 'utf8').trim().toLowerCase() || 'success'
  }
  return 'success'
}

function successResult(resultText) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText,
    session_id: 'fixture-session',
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })
}

function errorResult(resultText, extras = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: resultText,
    session_id: 'fixture-session',
    ...extras,
  })
}

const mode = modeFromPrompt()

switch (mode) {
  case 'success': {
    await delay(120)
    const readme = join(cwd, 'README.md')
    if (existsSync(readme)) {
      const before = readFileSync(readme, 'utf8')
      writeFileSync(readme, before.replaceAll('typoo', 'typo'), { encoding: 'utf8' })
    } else {
      writeFileSync(join(cwd, 'RESULT.txt'), 'fixture-ok\n', { encoding: 'utf8' })
    }
    process.stdout.write(`${successResult('Updated local files for the authorized task.')}\n`)
    break
  }

  case 'nonzero': {
    await delay(100)
    process.stdout.write(`${errorResult('Fixture forced a nonzero process exit')}\n`)
    process.exitCode = 2
    break
  }

  case 'denial': {
    await delay(100)
    process.stdout.write(`${errorResult('Permission denied by fixture', {
      subtype: 'success',
      is_error: false,
      permission_denials: [{ tool_name: 'Bash', reason: 'not allowed' }],
    })}\n`)
    break
  }

  case 'malformed': {
    await delay(100)
    process.stdout.write('not-json-result\n')
    break
  }

  case 'wait': {
    const duration = Number.parseInt(/FIXTURE_WAIT_MS=(\d+)/i.exec(prompt)?.[1] ?? '30000', 10)
    process.stdout.write('fixture waiting\n')
    await delay(Number.isFinite(duration) ? duration : 30_000)
    process.stdout.write(`${successResult('Wait finished without cancellation')}\n`)
    break
  }

  case 'delayed-success': {
    // Hold before any stdout so adapters that require a single JSON result still parse cleanly.
    const duration = Number.parseInt(/FIXTURE_DELAY_MS=(\d+)/i.exec(prompt)?.[1] ?? '1000', 10)
    await delay(Number.isFinite(duration) ? duration : 1_000)
    const readme = join(cwd, 'README.md')
    if (existsSync(readme)) {
      const before = readFileSync(readme, 'utf8')
      writeFileSync(readme, before.replaceAll('typoo', 'typo'), { encoding: 'utf8' })
    } else {
      writeFileSync(join(cwd, 'RESULT.txt'), 'fixture-ok\n', { encoding: 'utf8' })
    }
    process.stdout.write(`${successResult('Delayed success completed for the authorized task.')}\n`)
    break
  }

  case 'count': {
    await delay(150)
    process.stdout.write(`${successResult('Counted launch only')}\n`)
    break
  }

  default:
    process.stderr.write(`unknown fixture mode: ${mode}\n`)
    process.exitCode = 1
}
