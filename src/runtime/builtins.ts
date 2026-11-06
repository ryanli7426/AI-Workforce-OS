/** Concrete drivers are installed here, outside Core and the generic registry. */
import { ClaudeCodeAdapter, CLAUDE_CODE_CAPABILITIES } from './claude-code.ts'
import { RuntimeRegistry } from './registry.ts'

// Fixed compatibility identity for pre-registry Claude print/JSON execution records.
// Never recompute this from a future driver's current capabilities/version.
export const LEGACY_CLAUDE_RUNTIME_FINGERPRINT = '494fb1345011366b25ef9b7200ceee9f53228975aa523a9e4fd5bacd1d301519'

export function builtinRuntimeRegistry(): RuntimeRegistry {
  return new RuntimeRegistry([{
    id:'claude-code',
    displayName:'Claude Code CLI',
    protocolVersion:1,
    capabilities:CLAUDE_CODE_CAPABILITIES,
    create:options => new ClaudeCodeAdapter(options),
  }])
}
