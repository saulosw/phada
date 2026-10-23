const GLOBAL_REFUSED: readonly string[] = [
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--config-env',
  '--namespace',
]
const REFUSED: readonly string[] = [
  '--output',
  '--open-files-in-pager',
  '--no-index',
  '--contents',
  '--ext-diff',
  '--textconv',
  '--exclude-from',
]
const GREP_REFUSED: readonly string[] = ['-f', '--file']

export function gitRefusal(argv: readonly string[]): string | undefined {
  const subcommand = argv.findIndex((arg) => !arg.startsWith('-'))
  const globals = subcommand === -1 ? argv : argv.slice(0, subcommand)
  for (const arg of globals) {
    const option = GLOBAL_REFUSED.find(
      (name) =>
        arg === name || arg.startsWith(`${name}=`) || (name.length === 2 && arg.startsWith(name)),
    )
    if (option !== undefined) return refused(option)
  }
  if (subcommand === -1) return undefined
  const isGrep = argv[subcommand] === 'grep'
  for (const arg of argv.slice(subcommand + 1)) {
    if (arg === '--') break
    if (isGrep && /^-[A-Za-z0-9]*O/.test(arg)) return refused('-O')
    if (isGrep && /^-[A-Za-z0-9]*f/.test(arg)) return refused('-f')
    const option = [...REFUSED, ...(isGrep ? GREP_REFUSED : [])].find(
      (name) => arg === name || arg.startsWith(`${name}=`),
    )
    if (option !== undefined) return refused(option)
  }
  return undefined
}

function refused(option: string): string {
  return `phada: git ${option} is not available during a Phada review: it could run a program, write a file or read outside the checkout.`
}
