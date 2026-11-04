import { expect, it } from 'vitest'
import { LocalStore } from '../src/storage/store.ts'
import { applicationRepositories, initializeApplicationSchema } from '../src/storage/application-store.ts'

it('explicitly initializes all module schemas inside one atomic transaction', () => {
  const store = new LocalStore(':memory:')
  try {
    expect(() => applicationRepositories(store.db)).toThrow('not initialized')
    initializeApplicationSchema(store)
    const repositories = applicationRepositories(store.db)
    expect(repositories.executions.list()).toEqual([])
    expect(repositories.intents.list()).toEqual([])
    expect(repositories.employees.list('local')).toEqual([])
    expect(repositories.projects.list('local')).toEqual([])
    initializeApplicationSchema(store)
    expect(repositories.executions.list()).toEqual([])
  } finally { store.close() }
})
it('does not partially install schemas when any module has a newer version', () => {
  const store = new LocalStore(':memory:')
  try {
    store.set('approval-schema', 2)
    expect(() => initializeApplicationSchema(store)).toThrow('Unsupported module schema')
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'execution'").get()).toBeUndefined()
    expect(store.get('approval-schema')).toBe(2)
  } finally { store.close() }
})
