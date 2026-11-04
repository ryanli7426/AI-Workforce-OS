import { readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('compiles an independent source closure without a host or vendor runtime', () => {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  expect(program.getSourceFiles().filter(f => /@deepseek-ai/.test(f.fileName)).map(f => f.fileName)).toEqual([])
  for (const file of program.getSourceFiles().filter(f => f.fileName.startsWith(resolve('src/core')))) {
    for (const statement of file.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text
        expect(specifier.startsWith('node:') || specifier.startsWith('./'), `${relative(process.cwd(), file.fileName)} -> ${specifier}`).toBe(true)
      }
    }
  }
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
}, 30_000)

it('preserves the selected migration files with exact provenance', () => {
  const manifest = JSON.parse(readFileSync('docs/MIGRATION_MANIFEST.json', 'utf8')) as { files: {path: string; sha256: string; currentSha256?: string}[] }
  expect(manifest.files.length).toBeGreaterThan(20)
  for (const item of manifest.files) expect(createHash('sha256').update(readFileSync(item.path)).digest('hex'), item.path).toBe(item.currentSha256 ?? item.sha256)
})
