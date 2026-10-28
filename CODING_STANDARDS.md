# Coding standards

Read when reviewing a change. These are the judgment rules no test, type or lint catches; the
mechanical ones (the allowed imports, the format, unused exports, a screen importing another, a
fixed pause in the app's tests) already fail the checks. A finding names the rule it breaks.

## External text is cleaned before it reaches the terminal

Text Phada did not write (names, paths, config values, pull request titles and bodies, what
GitHub, git or an AI CLI answered, error messages) can carry control and bidi characters that
rewrite the terminal. It reaches the screen only through `toTerminalText()`
(`src/app/terminal-text.ts`); in the app, through `oneLine()` or `wrapText()`
(`src/tui/text-fit.ts`), `textLines()` (`src/tui/frame-lines.tsx`), and errors through
`failedNodes()`, `failedLines()`, `failedText()` or `<DataView>`. Check each value a change draws
or prints, including the ones inside a message of the catalogs.

## The app only reads what is Phada's own

The history, the index and the observed relations belong to the commands that write them (review,
watch, index). A read never creates or changes Phada's files: the app opens them read-only and
shows a missing, older or newer file as a fact on the screen, never creating, migrating,
rebuilding or pruning one as a side effect of reading. The app writes only the user config (and
the files of `repos/<owner>/<repo>/` it is asked to open), and, when the person asks for it, the
index (through the same use case as `phada index`), the `.phada/` of a repository (as
`phada init`) and the history, when it runs a review or the watch on request (through the same
code as `phada review` and `phada watch`), like the index.

## Shared code lives in a module, never in a screen

When two screens need the same helper, it moves to a module of `src/tui/` named for what it does
(as `provider-names.ts` and `setting-lines.tsx`). A screen exports its component for `SCREENS`
and its own test, and serves as a library to nothing else, a module outside `screens/` included.

## The conventions of AGENTS.md

The [conventions](AGENTS.md#conventions) a reader judges also apply: one responsibility per file,
names that carry the intent, no comment restating the code, external dependencies injectable,
nothing added before something uses it, and never a token printed, logged or committed.
