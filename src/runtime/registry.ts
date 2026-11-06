/** Immutable trusted driver registry. Constructing/listing it never probes or launches CLIs. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { validateLaunchSpec } from '../runner/protocol.ts'
import type { RuntimeAdapter, RuntimeAdapterOptions, RuntimeCapabilities, RuntimeDriver, RuntimeDriverDescriptor } from './ports.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CAPABILITIES = ['activeInput','continueSession','reattachMonitor','pause','structuredResult','filesystemIsolation'] as const

function capabilities(value: RuntimeCapabilities): RuntimeCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== CAPABILITIES.length
    || CAPABILITIES.some(key => typeof value[key] !== 'boolean')) {
    throw new Error('Invalid Runtime capabilities')
  }
  return Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key,value[key]]))) as unknown as RuntimeCapabilities
}

export class RuntimeRegistry {
  private readonly drivers = new Map<string, {descriptor: RuntimeDriverDescriptor; create: RuntimeDriver['create']}>()

  constructor(drivers: readonly RuntimeDriver[]) {
    if (!Array.isArray(drivers) || drivers.length > 64) throw new Error('Invalid Runtime registry')
    for (const driver of drivers) {
      if (!driver || typeof driver.id !== 'string' || !SAFE_ID.test(driver.id) || typeof driver.displayName !== 'string'
        || !Number.isSafeInteger(driver.protocolVersion) || driver.protocolVersion < 1 || driver.protocolVersion > 1000000
        || !driver.displayName.trim() || driver.displayName.length > 128
        || /[\x00-\x1f\x7f]/.test(driver.displayName) || typeof driver.create !== 'function') {
        throw new Error('Invalid Runtime driver')
      }
      if (this.drivers.has(driver.id)) throw new Error('Duplicate Runtime driver')
      const descriptor = Object.freeze({id:driver.id,displayName:driver.displayName,protocolVersion:driver.protocolVersion,capabilities:capabilities(driver.capabilities)})
      this.drivers.set(driver.id,{descriptor,create:driver.create.bind(driver)})
    }
  }

  list(): RuntimeDriverDescriptor[] { return [...this.drivers.values()].map(entry => entry.descriptor) }

  require(id: string): RuntimeDriverDescriptor {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error('Unsupported Runtime driver')
    return driver.descriptor
  }

  fingerprint(id: string): string {
    const descriptor=this.require(id)
    return createHash('sha256').update(JSON.stringify([1,descriptor.id,descriptor.protocolVersion,CAPABILITIES.map(key=>descriptor.capabilities[key])])).digest('hex')
  }

  create(id: string, options: RuntimeAdapterOptions): RuntimeAdapter {
    const descriptor = this.require(id)
    if (!options || typeof options.command !== 'string' || !isAbsolute(options.command) || options.command.includes('\0')
      || ['timeoutMs','maxOutputBytes','graceMs'].some(key => !Number.isSafeInteger(options[key as keyof RuntimeAdapterOptions]) || (options[key as keyof RuntimeAdapterOptions] as number) < 1)) {
      throw new Error('Invalid Runtime adapter options')
    }
    const frozen = Object.freeze({...options})
    const adapter = this.drivers.get(id)!.create(frozen)
    if (!adapter || adapter.runtime !== id || typeof adapter.createLaunch !== 'function' || typeof adapter.parseResult !== 'function'
      || JSON.stringify(capabilities(adapter.capabilities)) !== JSON.stringify(descriptor.capabilities)) {
      throw new Error('Runtime adapter does not match registered driver')
    }
    const launch = adapter.createLaunch.bind(adapter), parse = adapter.parseResult.bind(adapter)
    return Object.freeze({
      runtime:id,
      capabilities:descriptor.capabilities,
      createLaunch(input) {
        const result=structuredClone(launch(structuredClone(input)))
        validateLaunchSpec(result)
        for (const key of ['executionId','assignmentId','ticketId','generation','cwd'] as const) {
          if(result[key]!==input[key]) throw new Error('Runtime launch identity mismatch')
        }
        if(result.command!==frozen.command || result.timeoutMs>frozen.timeoutMs
          || result.maxOutputBytes>frozen.maxOutputBytes || result.graceMs>frozen.graceMs) {
          throw new Error('Runtime launch exceeds configured authority')
        }
        return result
      },
      parseResult(input) {
        const result=structuredClone(parse(structuredClone(input)))
        if(!result || !['success','error'].includes(result.terminal) || typeof result.summary!=='string'
          || result.summary.length>8192 || result.summary.includes('\0')) throw new Error('Invalid Runtime result')
        return result
      },
    } satisfies RuntimeAdapter)
  }
}
