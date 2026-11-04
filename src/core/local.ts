/** Standalone composition boundary: the same Engine, with mandatory LAO acceptance metadata. */
import { Engine } from './engine.ts'
import type { EngineOptions } from './part.ts'
export function createLocalEngine(options: Omit<EngineOptions, 'mode'>): Engine {
  if (!options.repo.workflow) throw new Error('LAO requires a repository with durable lifecycle and issue identity records')
  return new Engine({ ...options, mode: 'local' })
}
