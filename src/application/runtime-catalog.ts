/** Public configured Runtime metadata; never probes commands or exposes executable paths. */
import { validateSettings, type LocalSettings } from '../config/settings.ts'
import { builtinRuntimeRegistry } from '../runtime/builtins.ts'
import type { RuntimeDriverDescriptor } from '../runtime/ports.ts'

export interface RuntimeCatalog {
  drivers: RuntimeDriverDescriptor[]
  instances: Array<{
    id: string
    driver: string
    configured: boolean
    health: 'not_checked'
  }>
}

export function runtimeCatalog(value: LocalSettings): RuntimeCatalog {
  const settings = validateSettings(value)
  const registry = builtinRuntimeRegistry()
  registry.require(settings.runtime.driver)
  return {
    drivers: registry.list(),
    instances: [{
      id:settings.runtime.id,
      driver:settings.runtime.driver,
      configured:settings.runtime.command !== null,
      health:'not_checked',
    }],
  }
}
