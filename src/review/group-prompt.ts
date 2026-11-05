import type { ChangedFile } from './diff-groups.js'
import type { DiffGroup } from './types.js'

export interface GroupView {
  index: number
  total: number
  group: DiffGroup
  changed: readonly ChangedFile[]
}

export const GROUPS = `This pull request is large, so Phada reviews it in groups of files and joins
the answers into one review. PHADA_GROUP says which group this is and lists every
changed file of the pull request; PHADA_DIFF holds only the diff of this group.
Report findings only on lines of PHADA_DIFF. When a file of another group matters
to this one, read it with the tools when you have them.
A problem whose cause is in a file of another group belongs to that group, which
reports it at its own lines: leave it out here, even when this group calls or
wires that code. Report it here only when its cause is in the lines of PHADA_DIFF.
In summary, write one or two sentences on what this group changes. In files,
account for the files of this group only.`

export function groupText({ index, total, group, changed }: GroupView): string {
  const inGroup = new Set(group.files)
  const kb = Math.max(1, Math.round(group.bytes / 1000))
  const count = `${group.files.length} ${group.files.length === 1 ? 'file' : 'files'}`
  return [
    `Group ${index + 1} of ${total}: ${group.label} (${count}, ${kb} KB)`,
    'Changed files of the pull request (* in this group):',
    ...changed.map(
      ({ path, added, removed }) =>
        `${inGroup.has(path) ? '*' : ' '} ${path} (+${added} -${removed})`,
    ),
  ].join('\n')
}
