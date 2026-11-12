# Configuration and cache

The config files Phada reads (the repository's and your own), every key they take and which one
wins, the folders where Phada keeps its cache, and the map of a repository's code that
`phada index` builds. The rules and docs a review sends are in
[Rules and repository context](review-context.md#rules-and-repository-context); the watch, hooks
and Slack keys are in [Watch mode](watch-and-requests.md#watch-mode).

## Configuration

Phada reads two kinds of config, both optional:

- **The repository's**, shared with everyone who reviews it: `.phada/config.yml` and
  `.phada/rules.md` at the root. A `.phada/` folder in a subfolder adds rules, files and ignore
  patterns for that part of the tree; review options are only read at the root.
- **Your own**, in `~/.config/phada/` (or `$XDG_CONFIG_HOME/phada`, or `$PHADA_CONFIG_HOME`):
  `config.yml` and `rules.md` for every repository, and `repos/<owner>/<repo>/` (in lowercase) for
  one repository, which also works where you cannot commit.

`phada init` creates commented `.phada/` files in the current repository; `phada init --global`
creates your own config, and `phada init --global owner/repo` the one for a single repository.
Existing files are never overwritten. [`phada setup`](terminal-app.md#setup) and the app write
`provider`, `model`, `language` and `watch.repos` in your own config for you (see
[Changing your config from the app](terminal-app.md#changing-your-config-from-the-app)).

```yaml
# .phada/config.yml
language: pt-BR
minConfidence: 60
verify: true
ignore: ['src/generated/**']
rules:
  - id: orm-only
    rule: Use the ORM for every query; never build SQL by hand.
    scope: ['**/*.py']
    severity: P1
disabledRules: [no-console]
context:
  defaults: true
  files:
    - path: docs/architecture.md
  repos: [acme/web]
conversation: true
ci:
  read: true
  wait: 15m
  onFailure: review
  checks: [test, 'lint/*']
```

### Keys

"Both (root)" means the key is read from your config and from the `.phada/config.yml` at the root
of the repository, not from a subfolder's `.phada/`.

| Key                       | What it does                                                                                                                                      | Where                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `provider`                | `claude`, `codex` or `ollama`                                                                                                                     | your config             |
| `model`                   | Model for that provider                                                                                                                           | your config             |
| `localFiles`              | Files or folders on your machine to send as docs (a folder sends every `.md` in it); relative paths start at the folder of that `config.yml`      | your config             |
| `language`                | Review language, like `--language`                                                                                                                | both (root)             |
| `minConfidence`           | Confidence cut, like `--min-confidence`                                                                                                           | both (root)             |
| `verify`                  | Verify findings, like `--verify`                                                                                                                  | both (root)             |
| `investigate`             | `false` turns the [repository investigation](review-context.md#repository-investigation) off, like `--no-investigate`                             | both (root)             |
| `resolveThreads`          | `false` turns off the [recheck of earlier comments](publishing.md#comments-fixed-in-a-new-commit), like `--no-resolve`                            | both (root)             |
| `mcp`                     | MCP servers the AI may use: names from your AI CLI or servers declared with `command` or `url` (see [MCP servers](review-context.md#mcp-servers)) | your config             |
| `context.defaults`        | `false` sends only the files listed in `context.files`, not the docs Phada picks nor the `.claude/rules`                                          | both (root)             |
| `context.files`           | Files of the repository to always send (globs allowed), first in line for the budget                                                              | both                    |
| `context.repos`           | Other repositories the review may read (see [Related repositories](review-context.md#related-repositories))                                       | both (root)             |
| `context.privateOnPublic` | `true` lets a private related repository be read for a public pull request                                                                        | your config             |
| `conversation`            | `false` keeps the [conversation](review-context.md#the-conversation) away from the AI, like `--no-conversation`                                   | both (root)             |
| `ci.read`                 | `false` turns the [checks](review-context.md#the-checks) off, like `--no-ci`                                                                      | both (root)             |
| `ci.wait`                 | How long the watch and `--wait-ci` wait for pending checks (default `15m`, `0s` does not wait)                                                    | both (root)             |
| `ci.onFailure`            | `review` (default) or `skip`: the watch skips a commit whose checks fail until they pass (see [Watch mode](watch-and-requests.md#watch-mode))     | both (root)             |
| `ci.checks`               | The checks that count, by name or glob (default: all)                                                                                             | both (root)             |
| `ignore`                  | More files to leave out of the diff                                                                                                               | both                    |
| `rules`                   | Rules with `rule`, and optionally `id`, `scope` (globs), `severity` (`P0`, `P1` or `P2`), `kind` (`check` or `avoid`) and `from`                  | both                    |
| `review.debt`             | `summary` (default), `comments` or `off`: what to do with the [repository debt](publishing.md#repository-debt)                                    | both (root)             |
| `review.continuation`     | `true` (default) or `false`: one more pass over the files a review with low [coverage](publishing.md#coverage) left out                           | both (root)             |
| `review.groups`           | `false` (default), `true` or `{ concurrency: 1–4 }`: review a [large pull request](publishing.md#large-pull-requests) in diff groups              | both (root)             |
| `review.prompt`           | `file` and `mode` (`append` or `replace`) of the reviewer's focus (see [Review focus and skills](review-context.md#review-focus-and-skills))      | both (root)             |
| `review.skills`           | Skills to review with, one pass each, as names or `{ name, paths, mode }`; `phada` is the built-in reviewer                                       | both (root)             |
| `review.commands`         | Commands a [native skill](review-context.md#skills-that-run-natively) may run: `read-only` (default), a list like `["npm test"]`, or `all`        | your config             |
| `review.readDirs`         | Folders a native skill may read besides the checkout and its own folder                                                                           | your config             |
| `review.timeout`          | How long one native skill pass may run (`1m` to `2h`, default `30m`)                                                                              | your config             |
| `watch`                   | Repositories `phada watch` follows and how (see [Watch mode](watch-and-requests.md#watch-mode)), their `when` command and `replies`               | your config (top level) |
| `hooks`                   | Commands that get the [review events](watch-and-requests.md#review-events-and-hooks)                                                              | your config (top level) |
| `slack`                   | Slack channels the watch listens to (see [Slack](watch-and-requests.md#slack))                                                                    | your config (top level) |
| `history`                 | `false` keeps reviews out of the [history](history-and-lessons.md#history)                                                                        | your config (top level) |
| `misses.bots`             | Logins of the bots whose threads count as [misses](history-and-lessons.md#misses)                                                                 | your config             |
| `disabledRules`           | Ids of rules from other config files, or paths of `.claude/rules` files, to turn off; from a subfolder's `.phada/`, only inside that folder       | both                    |

### Globs

Globs follow the usual `*`/`**` rules and are relative to the folder of the `.phada/` that
declares them (the repository root for your own config): `*.snap` only matches at that level, so
write `**/*.snap` for every folder; a leading `/` also means that folder. Exceptions with `!` are
not supported: list only the files to match.

### How the files add up

`rules.md` is free Markdown with more rules; HTML comments in it are not sent. Rules, files and
ignore patterns from every config add up.

For options, a flag wins over your config for that repository, which wins over the repository's,
which wins over your global config. A `model` only applies with the `provider` set next to it, so
`--provider ollama` never takes a model meant for Claude.

An invalid `.phada/` in the repository is skipped with a warning; an invalid config of your own
stops Phada with an error that names the file and the key.

## Cache

Phada keeps a mirror of each repository it reviews or indexes, and the map, in `~/.cache/phada`
(`$XDG_CACHE_HOME/phada` when set; `PHADA_CACHE_HOME` to choose another folder):

- `repos/<owner>/<repo>.git`: a bare git repository with only the commits Phada fetched (the 20
  most recently reviewed pull requests, the last indexed commit and, for a
  [related repository](review-context.md#related-repositories), the head of its default branch),
  without their history and without your token;
- `index/<owner>/<repo>.sqlite`: the map built by reviews and by `phada index`, with its 10 most
  recent commits; a new version of Phada builds it again from scratch;
- `observed/<owner>/<repo>.sqlite`: the relations reviews learned (see
  [Repository graph](review-context.md#repository-graph)); it survives new versions of Phada.

The mirror holds the source code of the repositories you review, private ones included, so Phada
creates these folders readable only by you. Everything there can be deleted at any time
(`rm -rf ~/.cache/phada`); Phada fetches what it needs again.

The history is kept apart from the cache, in `~/.local/share/phada` (see
[History](history-and-lessons.md#history)).

## Repository map

`phada index owner/repo` builds a map of the repository's code on your machine: its files,
functions, classes, methods, parameters, variables, imports, exports, calls and uses of imported
names, for TypeScript, JavaScript, Python and Go. It fetches the default branch (or
`--ref <branch, tag or full commit SHA>`) into the local mirror and parses each file with
[tree-sitter](https://tree-sitter.github.io/). Files are kept by their git blob, so running it
again reads only the files that changed. `--format json` prints the result as JSON. It needs `git`
and a token that can read the repository contents.

```text
$ phada index owner/repo
Indexed owner/repo at 8ff3f28 (default branch) in 3.7s
Files: 170 indexed (170 read, 0 unchanged) · 27 left out
Languages: TypeScript 170
Symbols: 483 functions · 83 methods · 31 classes · 136 interfaces · 45 types · 1,581 variables · 963 parameters
Imports 1,297 · exports 388 · calls 9,830 · uses 2,104
Left out: 26 no grammar (.json 11, .md 6, (none) 5, other 4) · 1 ignored
Index: ~/.cache/phada/index/owner/repo.sqlite (2.4 MB) · mirror 301.2 KB
```

Files in other languages, binary files, files over 1 MB, symbolic links, submodules, dependency
folders committed to the repository (`node_modules`, `bower_components`, `.venv`, `venv`,
`site-packages`, `vendor`) and the files your `ignore` patterns and the defaults leave out of
reviews stay out of the map, and the output says how many and why (`--format json` lists each
one). A file that takes more than 2 seconds to parse, or that the parser cannot read, is left out
too.

The review uses the map for the [repository graph](review-context.md#repository-graph).
