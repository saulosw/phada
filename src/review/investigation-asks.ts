import { NEW_FILE_COMPARED_FROM_LINES } from './coverage.js'
import { parseDiffFiles } from './diff-lines.js'

const ACCOUNT_FOR_FILES = `In files, account for every file of the diff. Compare each new file with ${NEW_FILE_COMPARED_FROM_LINES} or
more added lines with the existing code closest to it: read that code with the
tools and give its path in against. Code moved out of a file this diff deletes or
shrinks is compared with that file, which the diff shows.`

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

export function investigationAsks(diff: string): string {
  const kinds = changedInfraKinds(diff)
  if (kinds.length === 0) return ACCOUNT_FOR_FILES
  return `${ACCOUNT_FOR_FILES}
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

function listText(items: readonly string[]): string {
  return items.length === 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
