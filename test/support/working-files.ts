import { workingFiles } from '../../src/cli/fix-wiring.js'
import type { WorkingFiles } from '../../src/app/apply-file-suggestions.js'
import { nodeFileSystem } from '../../src/config/local-files.js'

export function diskFiles(root: string): WorkingFiles {
  return workingFiles(root, nodeFileSystem)
}
