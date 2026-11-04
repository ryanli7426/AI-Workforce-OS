import { appendFileSync } from 'node:fs'

const [, , mode, ...args] = process.argv
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

switch (mode) {
  case 'success':
    process.stdout.write('fixture stdout\n')
    process.stderr.write('fixture stderr\n')
    break

  case 'exit': {
    const code = Number.parseInt(args[0] ?? '', 10)
    if (!Number.isInteger(code)) throw new Error('exit mode requires an integer exit code')
    process.stdout.write(`exiting ${code}\n`)
    process.exitCode = code
    break
  }

  case 'delay': {
    const durationMs = Number.parseInt(args[0] ?? '', 10)
    if (!Number.isInteger(durationMs) || durationMs < 0) throw new Error('delay mode requires a duration')
    process.stdout.write('delay started\n')
    await delay(durationMs)
    process.stdout.write('delay finished\n')
    break
  }

  case 'count': {
    const [markerPath, duration = '250'] = args
    if (!markerPath) throw new Error('count mode requires a marker path')
    appendFileSync(markerPath, `${process.pid}\n`, { encoding: 'utf8' })
    await delay(Number.parseInt(duration, 10))
    break
  }

  case 'wait':
    process.stdout.write('waiting\n')
    await delay(Number.parseInt(args[0] ?? '30000', 10))
    break

  case 'output': {
    const bytes = Number.parseInt(args[0] ?? '65536', 10)
    if (!Number.isInteger(bytes) || bytes < 1) throw new Error('output mode requires a byte count')
    const chunk = Buffer.alloc(1024, 'x')
    for (let written = 0; written < bytes; written += chunk.length) {
      process.stdout.write(chunk)
      process.stderr.write(chunk)
    }
    await delay(30000)
    break
  }

  default:
    throw new Error(`unknown fixture mode: ${mode ?? '<missing>'}`)
}
