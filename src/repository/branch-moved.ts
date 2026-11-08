export class BranchMovedError extends Error {
  override readonly name = 'BranchMovedError'

  constructor(repo: string, branch: string) {
    super(
      `${branch} moved on ${repo} since phada fix read it: nothing was pushed; run phada fix again.`,
    )
  }
}
