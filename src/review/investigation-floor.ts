import type { Toolbox } from '../investigation/toolbox.js'
import { parseDiffFiles } from './diff-lines.js'

export const DIFF_BYTES_PER_CALL = 10 * 1024
export const MIN_INVESTIGATION_CALLS = 3
export const MAX_INVESTIGATION_CALLS = 15
export const FLOOR_FROM_BYTES = 30 * 1024

const INFRA_KINDS: readonly { kind: string; matches: (path: string, name: string) => boolean }[] = [
  {
    kind: 'CI workflows',
    matches: (path, name) =>
      /^\.github\/(workflows|actions)\//.test(path) ||
      path.startsWith('.circleci/') ||
      ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'].includes(
        name,
      ),
  },
  {
    kind: 'container files',
    matches: (_path, name) =>
      /^Dockerfile(\..+)?$|\.dockerfile$|^(docker-)?compose[\w.-]*\.ya?ml$/i.test(name),
  },
  {
    kind: 'infrastructure code',
    matches: (path, name) =>
      /\.(tf|tfvars|hcl)$/.test(name) ||
      /^(serverless\.ya?ml|Chart\.yaml)$/.test(name) ||
      /(^|\/)(infra|infrastructure|deploy|k8s|kubernetes|helm)\//.test(path),
  },
  {
    kind: 'package manifests',
    matches: (_path, name) =>
      /^(package\.json|go\.mod|pyproject\.toml|requirements[\w.-]*\.txt|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile)$/.test(
        name,
      ),
  },
]

export function investigationFloor(diff: string): number | undefined {
  const bytes = byteLength(diff)
  if (bytes < FLOOR_FROM_BYTES && changedInfraKinds(diff).length === 0) return undefined
  const calls = Math.floor(bytes / DIFF_BYTES_PER_CALL)
  return Math.min(MAX_INVESTIGATION_CALLS, Math.max(MIN_INVESTIGATION_CALLS, calls))
}

export function investigationFloorText(diff: string): string {
  const expected = investigationFloor(diff)
  if (expected === undefined) return ''
  const floor = `This diff is ${sizeText(diff)}: make at least ${expected} tool calls before you answer.`
  const kinds = changedInfraKinds(diff)
  if (kinds.length === 0) return floor
  return `${floor}
This diff changes ${listText(kinds)}: they decide what runs, gets installed or gets deployed.
Investigating them is required: check what each changed one affects (the jobs,
images, resources or packages that use it) before you answer.`
}

export function investigationShortfall(
  calls: number,
  diff: string,
  skill?: string,
): string | undefined {
  const floor = investigationFloor(diff)
  if (floor === undefined || calls >= floor) return undefined
  const times = `${calls} time${calls === 1 ? '' : 's'}`
  const text = `nvestigated ${times} for a ${sizeText(diff)} diff (expected at least ${floor}).`
  return skill === undefined ? `I${text}` : `Skill ${skill}: i${text}`
}

export function countingToolbox(toolbox: Toolbox): { toolbox: Toolbox; calls(): number } {
  let calls = 0
  return {
    toolbox: {
      ...toolbox,
      touchedPaths: () => toolbox.touchedPaths(),
      call: (name, args, options) => {
        calls += 1
        return toolbox.call(name, args, options)
      },
    },
    calls: () => calls,
  }
}

function changedInfraKinds(diff: string): string[] {
  const paths = parseDiffFiles(diff).map(({ path }) => path)
  return INFRA_KINDS.filter(({ matches }) =>
    paths.some((path) => matches(path, path.slice(path.lastIndexOf('/') + 1))),
  ).map(({ kind }) => kind)
}

function listText(items: readonly string[]): string {
  return items.length === 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function sizeText(diff: string): string {
  const bytes = byteLength(diff)
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
