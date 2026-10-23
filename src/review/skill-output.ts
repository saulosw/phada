import type { CapturedWrite, NativeSkillRun } from './types.js'

export const SKILL_OUTPUT_LIMIT_BYTES = 65_536

const CUT_NOTE = '\n[cut by Phada at 64 KB]'

export function skillOutputText(run: NativeSkillRun): string {
  const text = [
    ...run.captured.flatMap((write) => [`--- ${write.command} ---`, capturedText(write)]),
    '--- final answer ---',
    run.text,
  ].join('\n')
  return withinLimit(text)
}

export function skillBodyText(run: NativeSkillRun): string {
  const posted = run.captured.map(capturedText).filter((text) => text.trim() !== '')
  return withinLimit(posted.length === 0 ? run.text : posted.join('\n\n'))
}

function capturedText({ body, comments }: CapturedWrite): string {
  return [
    ...(body === '' ? [] : [body]),
    ...comments.map(({ path, line, startLine, body: comment }) => {
      const lines =
        line === undefined ? '' : startLine === undefined ? `:${line}` : `:${startLine}-${line}`
      return `${path}${lines}: ${comment}`
    }),
  ].join('\n')
}

function withinLimit(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= SKILL_OUTPUT_LIMIT_BYTES) return text
  const cut = new TextDecoder().decode(bytes.subarray(0, SKILL_OUTPUT_LIMIT_BYTES))
  return `${cut.replace(/�+$/, '')}${CUT_NOTE}`
}
