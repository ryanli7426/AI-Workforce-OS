import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const bad = []
for (const group of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) for (const name of Object.keys(pkg[group] ?? {})) if (name.startsWith('@deepseek-ai/')) bad.push(name)
function scan(dir) { for (const entry of readdirSync(dir, {withFileTypes:true})) { const p=join(dir,entry.name); if(entry.isDirectory()) scan(p); else if(/\.[cm]?[jt]s$/.test(p) && /(?:from\s*|import\s*\(|require\s*\()\s*['"]@deepseek-ai\//.test(readFileSync(p,'utf8'))) bad.push(p) } }
scan('src'); scan('tests')
if (bad.length) throw new Error('Forbidden runtime dependencies: '+bad.join(', '))
console.log('No DeepSeek Harness package dependencies or source imports')
