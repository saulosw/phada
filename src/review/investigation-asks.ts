import { NEW_FILE_COMPARED_FROM_LINES } from './coverage.js'
import { newCodeShare, parseDiffFiles } from './diff-lines.js'

const ACCOUNT_FOR_FILES = `In files, account for every file of the diff. Compare each new file with ${NEW_FILE_COMPARED_FROM_LINES} or
more added lines with the existing code closest to it: read that code with the
tools and give its path in against. Code moved out of a file this diff deletes or
shrinks is compared with that file, which the diff shows.`

const SEARCH_TOOLS = ['list', 'find_symbol', 'similar']

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

export function investigationAsks(diff: string, toolNames: readonly string[]): string {
  const asks = newCodeShare(diff).createsCode
    ? `${ACCOUNT_FOR_FILES}\n${compareNewCode(toolNames)}`
    : ACCOUNT_FOR_FILES
  const kinds = changedInfraKinds(diff)
  if (kinds.length === 0) return asks
  return `${asks}
This diff changes ${listText(kinds)}: they decide what runs, gets installed or gets deployed.
Investigating them is required: check what each changed one affects (the jobs,
images, resources or packages that use it) before you answer.`
}

function changedInfraKinds(diff: string): string[] {
  const paths = parseDiffFiles(diff).map(({ path }) => path)
  return INFRA_KINDS.filter(({ matches }) =>
    paths.some((path) => matches(path, path.slice(path.lastIndexOf('/') + 1))),
  ).map(({ kind }) => kind)
}

function compareNewCode(toolNames: readonly string[]): string {
  return `This pull request mostly adds new code. Before you judge it, find the existing
code closest to it (a sibling module, the same kind of handler, test or step)
with ${searchTools(toolNames)}, read it and compare the new code with it: the
structure, the helpers it reuses and the conventions it follows. Report what the
new code reimplements (with existing set) or does differently in a way that
breaks a convention or causes a bug.`
}

function searchTools(toolNames: readonly string[]): string {
  const tools = SEARCH_TOOLS.filter((name) => toolNames.includes(name))
  return tools.length === 0 ? 'the tools' : listText(tools)
}

function listText(items: readonly string[]): string {
  return items.length === 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
