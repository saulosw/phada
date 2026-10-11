import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { GRAMMAR_FILES } from '../src/repo-map/grammars.js'

const require = createRequire(import.meta.url)
const target = join('dist', 'grammars')
mkdirSync(target, { recursive: true })
for (const { packageName, file } of Object.values(GRAMMAR_FILES)) {
  copyFileSync(require.resolve(`${packageName}/${file}`), join(target, file))
}
