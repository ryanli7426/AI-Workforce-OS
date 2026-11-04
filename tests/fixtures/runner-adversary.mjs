/** Adversarial Runner child fixture: private cwd markers only; never signals foreign PIDs. */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , mode, ...args] = process.argv
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function writeMarkers(dir, extra = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'direct.pid'), `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(join(dir, 'direct.pgid'), `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(join(dir, 'markers.json'), `${JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    ...extra,
    at: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600 })
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

switch (mode) {
  case 'hold': {
    const [markerDir, duration = '30000'] = args
    if (!markerDir) throw new Error('hold mode requires a marker directory')
    writeMarkers(markerDir, { mode: 'hold' })
    process.stdout.write('adversary holding\n')
    await delay(Number.parseInt(duration, 10))
    break
  }

  case 'count': {
    const [markerPath, duration = '500'] = args
    if (!markerPath) throw new Error('count mode requires a marker path')
    appendFileSync(markerPath, `${process.pid}\n`, { encoding: 'utf8' })
    await delay(Number.parseInt(duration, 10))
    break
  }

  case 'env-dump': {
    const [outPath] = args
    if (!outPath) throw new Error('env-dump mode requires an output path')
    writeFileSync(outPath, `${JSON.stringify(process.env, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    process.stdout.write('env dumped\n')
    break
  }

  case 'orphan-descendant': {
    const [markerDir, holdMs = '20000'] = args
    if (!markerDir) throw new Error('orphan-descendant mode requires a marker directory')
    writeMarkers(markerDir, { mode: 'orphan-descendant' })

    // Stay in the Runner child's process group so the worker observes a surviving member.
    const descendant = spawn(process.execPath, [
      '-e',
      `
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const dir = ${JSON.stringify(markerDir)};
        writeFileSync(join(dir, 'descendant.pid'), String(process.pid) + '\\n', { mode: 0o600 });
        writeFileSync(join(dir, 'descendant.pgid'), String(process.pid) + '\\n', { mode: 0o600 });
        setInterval(() => {}, 1000);
        setTimeout(() => process.exit(0), ${Number.parseInt(holdMs, 10)});
      `,
    ], {
      stdio: 'ignore',
      detached: false,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        USER: process.env.USER ?? '',
        LANG: process.env.LANG ?? 'C',
        TMPDIR: process.env.TMPDIR ?? '',
      },
    })

    const started = Date.now()
    while (!alive(descendant.pid) && Date.now() - started < 2_000) await delay(20)
    if (!descendant.pid || !alive(descendant.pid)) throw new Error('descendant failed to start')
    writeFileSync(join(markerDir, 'descendant.spawn.pid'), `${descendant.pid}\n`, { encoding: 'utf8', mode: 0o600 })
    process.stdout.write(`orphan parent exiting; descendant=${descendant.pid}\n`)
    // Exit the direct child while the descendant keeps the process group alive.
    process.exit(0)
    break
  }

  case 'success':
    process.stdout.write('adversary ok\n')
    break

  default:
    throw new Error(`unknown adversary mode: ${mode ?? '<missing>'}`)
}
