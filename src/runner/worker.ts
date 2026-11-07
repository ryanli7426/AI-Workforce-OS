import {signContainmentEvidence} from '../containment/evidence.ts'
import type {PreparedContainment} from '../containment/srt.ts'
import { StreamingRedactor } from '../security/redaction.ts'
import { RUNTIME_ENV_CHANNEL, validateRuntimeEnvironment } from './environment.ts'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { ExecutionState } from '../execution/model.ts'
import {
  validateLaunchSpec,
  type RunnerEvent,
  type RunnerRequest,
  type RunnerSnapshot,
  type StopRequest,
} from './protocol.ts'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const HEARTBEAT_MS = 250
const STOP_POLL_MS = 50
const LOOP_MS = 10
const SPAWN_CONFIRM_MS = 5_000
const POST_KILL_MS = 2_000
const CLOSE_WAIT_MS = 2_000
const POSIX = process.platform !== 'win32'

type RuntimeChild = ChildProcessByStdio<null, Readable, Readable>
type TerminationKind = 'manual' | 'timeout' | 'output' | 'descendants' | 'internal'

interface Termination {
  kind: TerminationKind
  reason: string
  requestedAt: number
  killSentAt?: number
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'UNKNOWN'
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
}

function openPrivate(path: string, flags: number): number {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const fd = openSync(path, flags | noFollow, FILE_MODE)
  fchmodSync(fd, FILE_MODE)
  return fd
}

function readRequest(requestPath: string): RunnerRequest {
  const stat = lstatSync(requestPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Runner request must be a regular file')
  const fd = openPrivate(requestPath, constants.O_RDONLY)
  try {
    if (fstatSync(fd).size > 1024 * 1024) throw new Error('Runner request is too large')
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('Invalid runner request')
    const request = value as Partial<RunnerRequest> & Record<string, unknown>
    if (Object.keys(request).some(key => !['version', 'token', 'spec'].includes(key))) {
      throw new Error('Unknown runner request fields')
    }
    if (request.version !== 1 && request.version !== 2) throw new Error('Unsupported runner request version')
    if (typeof request.token !== 'string' || !request.token || request.token.length > 4096 || request.token.includes('\0')) {
      throw new Error('Invalid runner token')
    }
    validateLaunchSpec(request.spec)
    if((request.version===1&&request.spec.containment!==undefined)||(request.version===2&&request.spec.containment===undefined))throw new Error('Containment protocol downgrade refused')
    return request as RunnerRequest
  } finally {
    closeSync(fd)
  }
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readAuthenticatedStop(path: string, token: string): StopRequest | undefined {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined
    const fd = openPrivate(path, constants.O_RDONLY)
    try {
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (!value || typeof value !== 'object') return undefined
      const stop = value as Partial<StopRequest> & Record<string, unknown>
      if (Object.keys(stop).some(key => !['version', 'token', 'reason'].includes(key))) return undefined
      if (stop.version !== 1 || typeof stop.token !== 'string' || !tokensEqual(stop.token, token)) return undefined
      if (typeof stop.reason !== 'string' || !stop.reason.trim() || stop.reason.length > 4096 || stop.reason.includes('\0')) {
        return undefined
      }
      return stop as StopRequest
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  let explicit: unknown = {}
  try { explicit = JSON.parse(process.env[RUNTIME_ENV_CHANNEL] ?? '{}') } catch { throw new Error('Invalid Runtime environment channel') }
  return { ...env, ...validateRuntimeEnvironment(explicit) }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function processGroupAlive(processId: number): boolean {
  if (!POSIX) return false
  try {
    process.kill(-processId, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

function signalProcess(child: RuntimeChild, processId: number, signal: NodeJS.Signals): void {
  try {
    if (POSIX) process.kill(-processId, signal)
    else child.kill(signal)
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

function fsyncDirectory(fd: number): void {
  try {
    fsyncSync(fd)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error
  }
}

export async function runWorker(requestPath: string): Promise<void> {
  const absoluteRequestPath = isAbsolute(requestPath) ? requestPath : resolve(requestPath)
  if (basename(absoluteRequestPath) !== 'request.json') throw new Error('Runner request path must name request.json')

  const executionDirectory = dirname(absoluteRequestPath)
  const directoryStat = lstatSync(executionDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Execution directory must be a real directory')
  chmodSync(executionDirectory, DIRECTORY_MODE)

  const request = readRequest(absoluteRequestPath)
  const { spec, token } = request
  if (!POSIX) throw new Error('Reliable Runner process-group control currently requires POSIX')
  const cwdStat = lstatSync(spec.cwd)
  if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()) throw new Error('Launch cwd must be a real directory')
  if (basename(executionDirectory) !== spec.executionId) throw new Error('Execution directory does not match execution ID')

  const runnerId = randomUUID()
  const runnerPid = process.pid
  const lockPath = resolve(executionDirectory, 'worker.lock')
  const statePath = resolve(executionDirectory, 'state.json')
  const eventsPath = resolve(executionDirectory, 'events.jsonl')
  const stdoutPath = resolve(executionDirectory, 'stdout.log')
  const stderrPath = resolve(executionDirectory, 'stderr.log')
  const stopPath = resolve(executionDirectory, 'stop.json')
  const stateTemporaryPath = resolve(executionDirectory, `.state.${runnerPid}.${runnerId}.tmp`)

  let lockFd: number | undefined
  let directoryFd: number | undefined
  let eventsFd: number | undefined
  let stdoutFd: number | undefined
  let stderrFd: number | undefined
  let child: RuntimeChild | undefined
  let prepared:PreparedContainment|undefined

  try {
    lockFd = openPrivate(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    writeAll(lockFd, Buffer.from(`${JSON.stringify({ version: 1, runnerId, runnerPid })}\n`))
    fsyncSync(lockFd)

    directoryFd = openSync(executionDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    eventsFd = openPrivate(eventsPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND)
    stdoutFd = openPrivate(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    stderrFd = openPrivate(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)

    const startedAt = new Date().toISOString()
    let snapshot: RunnerSnapshot = {
      version: request.version,
      executionId: spec.executionId,
      assignmentId: spec.assignmentId,
      ticketId: spec.ticketId,
      generation: spec.generation,
      runnerId,
      runnerPid,
      state: 'STARTING',
      sequence: 0,
      startedAt,
      updatedAt: startedAt,
      heartbeatAt: startedAt,
      stdoutBytes: 0,
      stderrBytes: 0,
    }

    const writeSnapshot = (): void => {
      const data = Buffer.from(`${JSON.stringify(snapshot)}\n`)
      const fd = openPrivate(stateTemporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      try {
        writeAll(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(stateTemporaryPath, statePath)
      fsyncDirectory(directoryFd!)
    }

    const emitLifecycle = (
      state: ExecutionState,
      fields: Partial<Pick<RunnerSnapshot, 'processId' | 'finishedAt' | 'exitCode' | 'signal' | 'reason'>> = {},
    ): void => {
      const at = new Date().toISOString()
      snapshot = {
        ...snapshot,
        ...fields,
        state,
        sequence: snapshot.sequence + 1,
        updatedAt: at,
        heartbeatAt: at,
      }
      const event: RunnerEvent = { ...snapshot, at }
      writeAll(eventsFd!, Buffer.from(`${JSON.stringify(event)}\n`))
      fsyncSync(eventsFd!)
      writeSnapshot()
    }

    const heartbeat = (): void => {
      const at = new Date().toISOString()
      snapshot = { ...snapshot, updatedAt: at, heartbeatAt: at }
      writeSnapshot()
    }

    const closeContainmentBeforeTerminal=async(details:Partial<RunnerSnapshot>={}):Promise<boolean>=>{
      if(!prepared)return true
      try{await prepared.close();return true}catch{
        emitLifecycle('UNKNOWN',{...details,reason:'Containment helper termination could not be confirmed'})
        return false
      }
    }

    emitLifecycle('STARTING')

    let targetCommand=spec.command,targetArgs=[...spec.args]
    if(request.version===2){
      const abort=new AbortController(),preflightAt=Date.now()
      let interrupted=false,persistenceFailure=false
      const timer=setInterval(()=>{
        try{
          heartbeat()
          if(readAuthenticatedStop(stopPath,token)||Date.now()-preflightAt>=10_000){interrupted=true;abort.abort()}
        }catch{persistenceFailure=true;abort.abort()}
      },HEARTBEAT_MS)
      try{
        const controlRoot=realpathSync(dirname(executionDirectory))
        const workRoot=realpathSync(spec.cwd)
        if(controlRoot===workRoot||controlRoot.startsWith(workRoot+sep)||workRoot.startsWith(controlRoot+sep))throw new Error('Contained worktree and private Runner root must be disjoint')
        for(const input of spec.containment!.readOnlyPaths){
          const path=realpathSync(input)
          if(path===controlRoot||controlRoot.startsWith(path+sep)||path.startsWith(controlRoot+sep))throw new Error('Containment cannot expose private Runner controls')
        }
        const {prepareContainment}=await import('../containment/srt.ts')
        prepared=await prepareContainment(spec.cwd,spec.containment!,abort.signal)
        if(interrupted||abort.signal.aborted||readAuthenticatedStop(stopPath,token))throw new Error('Containment preparation interrupted')
        prepared.assertIdentity()
        const proof=signContainmentEvidence(request,runnerId,prepared.evidence)
        const proofFd=openPrivate(resolve(executionDirectory,'containment.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL)
        try{writeAll(proofFd,Buffer.from(JSON.stringify(proof)+'\n'));fsyncSync(proofFd)}finally{closeSync(proofFd)}
        fsyncSync(directoryFd)
        snapshot={...snapshot,containment:prepared.evidence}
        emitLifecycle('STARTING')
        const wrapped=await prepared.wrap(spec.command,spec.args)
        if(abort.signal.aborted||readAuthenticatedStop(stopPath,token))throw new Error('Containment preparation interrupted')
        prepared.assertIdentity()
        targetCommand=wrapped.command;targetArgs=wrapped.args
      }catch(error){
        if(errorCode(error)==='CONTAINMENT_UNKNOWN'){emitLifecycle('UNKNOWN',{reason:'Containment helper termination could not be confirmed; target was not launched'});return}
        if(persistenceFailure)throw new Error('Containment preflight persistence failed')
        if(!await closeContainmentBeforeTerminal())return
        emitLifecycle('FAILED',{finishedAt:new Date().toISOString(),reason:interrupted||readAuthenticatedStop(stopPath,token)?'Required containment interrupted before target launch':'Required containment could not be established; target was not launched'})
        return
      }finally{clearInterval(timer)}
    }

    const runtimeEnvironment = minimalEnvironment()
    if(prepared)runtimeEnvironment.TMPDIR=prepared.tempDir

    const secrets = [...Object.entries(runtimeEnvironment).filter(([name, value]) => /KEY|TOKEN/.test(name) && !!value).map(([, value]) => value!),...(prepared?.secrets()??[])]
    const redactors = { stdout: new StreamingRedactor({ secrets, maxPendingBytes: 1024 * 1024 }), stderr: new StreamingRedactor({ secrets, maxPendingBytes: 1024 * 1024 }) }
    let redactorsEnded = false
    const flushRedactors = (): void => {
      if (redactorsEnded) return
      redactorsEnded = true
      writeAll(stdoutFd!, Buffer.from(redactors.stdout.end()))
      writeAll(stderrFd!, Buffer.from(redactors.stderr.end()))
    }
    let spawned = false
    let spawnError: unknown
    let childError: unknown
    let directExited = false
    let childClosed = false
    let exitCode: number | null | undefined
    let exitSignal: NodeJS.Signals | null | undefined
    let outputExceeded = false
    let logError: unknown
    let acceptingOutput = true

    try {
      child = spawn(targetCommand, targetArgs, {
        cwd: spec.cwd,
        detached: POSIX,
        shell: false,
        windowsHide: true,
        env: runtimeEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      spawnError = error
    }

    const writeOutput = (kind: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (!acceptingOutput || logError) return
      try {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const total = snapshot.stdoutBytes + snapshot.stderrBytes
        const remaining = Math.max(0, spec.maxOutputBytes - total)
        const accepted = Math.min(remaining, data.length)
        if (accepted > 0) {
          writeAll(kind === 'stdout' ? stdoutFd! : stderrFd!, Buffer.from(redactors[kind].write(data.subarray(0, accepted))))
          snapshot = {
            ...snapshot,
            stdoutBytes: snapshot.stdoutBytes + (kind === 'stdout' ? accepted : 0),
            stderrBytes: snapshot.stderrBytes + (kind === 'stderr' ? accepted : 0),
          }
        }
        if (accepted < data.length) outputExceeded = true
      } catch (error) {
        logError = error
      }
    }

    if (child) {
      child.once('spawn', () => { spawned = true })
      child.on('error', error => {
        if (!spawned) spawnError = error
        else childError = error
      })
      child.once('exit', (code, signal) => {
        directExited = true
        exitCode = code
        exitSignal = signal
      })
      child.once('close', (code, signal) => {
        childClosed = true
        if (exitCode === undefined) exitCode = code
        if (exitSignal === undefined) exitSignal = signal
      })
      child.stdout.on('data', chunk => writeOutput('stdout', chunk as Buffer))
      child.stderr.on('data', chunk => writeOutput('stderr', chunk as Buffer))
    }

    const spawnDeadline = Date.now() + SPAWN_CONFIRM_MS
    while (child && !spawned && !spawnError && Date.now() < spawnDeadline) await sleep(LOOP_MS)

    if (!child || spawnError) {
      const closeDeadline = Date.now() + CLOSE_WAIT_MS
      while (child && !childClosed && Date.now() < closeDeadline) await sleep(LOOP_MS)
      acceptingOutput = false
      child?.stdout.destroy()
      child?.stderr.destroy()
      flushRedactors()
      fsyncSync(stdoutFd)
      fsyncSync(stderrFd)
      const reason = `child startup failed (${errorCode(spawnError)})`
      if (child && !childClosed) emitLifecycle('UNKNOWN', { reason: 'child startup closure was not confirmed' })
      else if(await closeContainmentBeforeTerminal())emitLifecycle('FAILED', { finishedAt: new Date().toISOString(), reason })
      return
    }

    const processId = child.pid
    if (!spawned || processId === undefined) {
      if (processId !== undefined) {
        try { signalProcess(child, processId, 'SIGKILL') } catch { /* ownership remains recorded */ }
      }
      acceptingOutput = false
      child.stdout.destroy()
      child.stderr.destroy()
      flushRedactors()
      fsyncSync(stdoutFd)
      fsyncSync(stderrFd)
      emitLifecycle('UNKNOWN', { reason: 'child spawn could not be confirmed' })
      return
    }

    emitLifecycle('RUNNING', { processId })

    const timeoutAt = Date.now() + spec.timeoutMs
    let nextHeartbeatAt = Date.now() + HEARTBEAT_MS
    let nextStopPollAt = Date.now()
    let termination: Termination | undefined
    let closeWaitStartedAt: number | undefined
    let persistenceError: unknown

    const groupAlive = (): boolean => POSIX ? processGroupAlive(processId) : !directExited

    const beginTermination = (kind: TerminationKind, reason: string): void => {
      if (termination) return
      termination = { kind, reason, requestedAt: Date.now() }
      try {
        emitLifecycle('STOPPING', { processId, reason })
      } catch (error) {
        persistenceError = error
      }
      try {
        signalProcess(child!, processId, 'SIGTERM')
      } catch (error) {
        if (!persistenceError) persistenceError = error
      }
    }

    for (;;) {
      const now = Date.now()

      if (logError) beginTermination('internal', `runtime log write failed (${errorCode(logError)})`)
      else if (childError) beginTermination('internal', `child monitoring failed (${errorCode(childError)})`)
      else if (outputExceeded) beginTermination('output', 'combined output limit exceeded')
      else if (!termination && now >= timeoutAt) beginTermination('timeout', 'execution timed out')

      if (!termination && now >= nextStopPollAt) {
        nextStopPollAt = now + STOP_POLL_MS
        if (readAuthenticatedStop(stopPath, token)) beginTermination('manual', 'stop requested')
      }

      if (!termination && directExited && groupAlive()) {
        beginTermination('descendants', 'descendant processes outlived direct child')
      }

      if (termination && groupAlive() && now - termination.requestedAt >= spec.graceMs && termination.killSentAt === undefined) {
        termination.killSentAt = now
        try {
          signalProcess(child, processId, 'SIGKILL')
        } catch (error) {
          if (!persistenceError) persistenceError = error
        }
      }

      const alive = groupAlive()
      if (!alive && directExited && closeWaitStartedAt === undefined) closeWaitStartedAt = now

      if (now >= nextHeartbeatAt) {
        nextHeartbeatAt = now + HEARTBEAT_MS
        try {
          heartbeat()
        } catch (error) {
          persistenceError = error
          beginTermination('internal', `runner persistence failed (${errorCode(error)})`)
        }
      }

      if (childClosed && !alive) break

      const killExpired = termination?.killSentAt !== undefined && now - termination.killSentAt >= POST_KILL_MS
      const closeExpired = closeWaitStartedAt !== undefined && now - closeWaitStartedAt >= CLOSE_WAIT_MS
      if (killExpired || closeExpired || (persistenceError && termination?.killSentAt !== undefined && killExpired)) {
        acceptingOutput = false
        child.stdout.destroy()
        child.stderr.destroy()
        try { flushRedactors(); fsyncSync(stdoutFd) } catch { /* reflected by UNKNOWN */ }
        try { fsyncSync(stderrFd) } catch { /* reflected by UNKNOWN */ }
        const reason = alive
          ? 'surviving process-group members could not be ruled out'
          : 'child stream closure could not be confirmed'
        try { emitLifecycle('UNKNOWN', { processId, exitCode, signal: exitSignal, reason }) } catch { /* lock remains reconciliation evidence */ }
        return
      }

      await sleep(LOOP_MS)
    }

    acceptingOutput = false
    child.stdout.destroy()
    child.stderr.destroy()

    let logsDurable = true
    try {
      flushRedactors()
      fsyncSync(stdoutFd)
      fsyncSync(stderrFd)
    } catch {
      logsDurable = false
    }

    if (!logsDurable || persistenceError) {
      emitLifecycle('UNKNOWN', {
        processId,
        exitCode,
        signal: exitSignal,
        reason: logsDurable ? 'runner persistence could not be confirmed' : 'runtime log durability could not be confirmed',
      })
      return
    }

    if(!await closeContainmentBeforeTerminal({processId,exitCode,signal:exitSignal}))return
    const finishedAt = new Date().toISOString()
    if (termination) {
      if (termination.kind === 'manual') {
        emitLifecycle('CANCELLED', { processId, finishedAt, exitCode, signal: exitSignal, reason: termination.reason })
      } else if (termination.kind === 'timeout') {
        emitLifecycle('TIMED_OUT', { processId, finishedAt, exitCode, signal: exitSignal, reason: termination.reason })
      } else if (termination.kind === 'internal') {
        emitLifecycle('UNKNOWN', { processId, exitCode, signal: exitSignal, reason: termination.reason })
      } else {
        emitLifecycle('FAILED', { processId, finishedAt, exitCode, signal: exitSignal, reason: termination.reason })
      }
    } else if (exitCode === 0 && !exitSignal) {
      emitLifecycle('SUCCEEDED', { processId, finishedAt, exitCode: 0, signal: null })
    } else {
      const reason = exitSignal ? `process exited on signal ${exitSignal}` : `process exited with code ${String(exitCode)}`
      emitLifecycle('FAILED', { processId, finishedAt, exitCode, signal: exitSignal, reason })
    }
  } catch (error) {
    // A persistence/monitor exception must not leave a child writing without its supervisor.
    // Retain the last nonterminal snapshot and lock: the controller must reconcile UNKNOWN.
    if (child?.pid) {
      const ownedPid = child.pid
      try { signalProcess(child, ownedPid, 'SIGTERM') } catch { /* keep uncertainty */ }
      const deadline = Date.now() + Math.min(spec.graceMs, 2_000)
      while (processGroupAlive(ownedPid) && Date.now() < deadline) await sleep(LOOP_MS)
      if (processGroupAlive(ownedPid)) {
        try { signalProcess(child, ownedPid, 'SIGKILL') } catch { /* keep uncertainty */ }
      }
      const hardDeadline = Date.now() + POST_KILL_MS
      while (processGroupAlive(ownedPid) && Date.now() < hardDeadline) await sleep(LOOP_MS)
      child.stdout.destroy(); child.stderr.destroy()
    }
    throw error
  } finally {
    if(prepared){try{await prepared.close(child?.pid!==undefined&&processGroupAlive(child.pid))}catch{/* no containment downgrade; request/proof remain private evidence */}}
    for (const fd of [stderrFd, stdoutFd, eventsFd, directoryFd, lockFd]) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best-effort cleanup; worker.lock remains on disk */ }
      }
    }
  }
}

function mainRequestPath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--request' || !argv[1]) throw new Error('Usage: worker --request PATH')
  return argv[1]
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    const requestPath = mainRequestPath(process.argv.slice(2))
    runWorker(requestPath).catch(error => {
      console.error(`Runner worker failed (${errorCode(error)})`)
      process.exitCode = 1
    })
  } catch (error) {
    console.error(`Runner worker failed (${errorCode(error)})`)
    process.exitCode = 1
  }
}
