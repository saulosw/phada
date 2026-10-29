# The terminal app

The contracts every screen of the app keeps. The imports this folder may use are in
[AGENTS.md](../../AGENTS.md#dependency-rule); [docs/layout.md](../../docs/layout.md) lists each
module.

## A screen

A screen is one file in `screens/` exporting a component without props, registered in `SCREENS`
(`screens.ts`): its place in the array is its tab and its `1`–`9` key. Its title comes from the
catalogs: add the id to `ScreenId` and a `{ full, short }` title under `screens` in each catalog.

A screen imports no other screen (`src/architecture.test.ts` refuses it). Code two screens share
lives in a module of `src/tui/`, as `provider-names.ts` and `setting-lines.tsx` do.

A minimal screen, where `readExample` stands for its read in `AppDeps`:

```tsx
import { Text } from 'ink'
import { useAppDeps, useMessages, useScreenKeys, useScreenSize } from '../app-context.js'
import { usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { ScrollText } from '../scroll-list.js'
import { oneLine } from '../text-fit.js'

export function ExampleScreen() {
  const { readExample } = useAppDeps()
  const messages = useMessages()
  const size = useScreenSize()
  const state = usePolled(readExample)
  useScreenKeys([{ keys: '↑/↓', label: messages.list.scroll }])
  return (
    <DataView state={state}>
      {(example) => (
        <ScrollText
          rows={size.rows}
          lines={example.names.map((name) => (
            <Text>{oneLine(name)}</Text>
          ))}
        />
      )}
    </DataView>
  )
}
```

## Keys (`app-context.ts`)

- **`useScreenKeys(hints)`**: the keys of the screen's current mode (list, detail, a focused
  field), shown by the footer and the `?` help. Change the hints with the mode.
- **`useScreenInput(handler)`**: the screen's own keys, in place of Ink's `useInput`. It is quiet
  while the help or the palette is open, while the terminal is too small and while a text field
  is focused. The shell keeps `q`, `?`, `/`, `1`–`9`, `←`/`→`, `Tab`, `Esc` and `Ctrl-C`.
- **`useArrowKeys(active)`**: while active, `←` and `→` reach the screen (a tree that opens and
  closes nodes) instead of moving between screens; `Tab` still moves, and the footer and the help
  say so.
- **`useBack(handler)`**: what `Esc` does in a nested view, as closing a detail; pass `undefined`
  at the screen's top, where `Esc` quits the app.
- **`useTextField({ initial, emptyOnFocus, onSubmit })`** (`text-field.tsx`): `focus()` it from a
  screen key; while focused it takes every key, `Enter` applies (`value`, `onSubmit`) and `Esc`
  leaves it unchanged. Draw it with `<TextFieldLine>`, show `Enter`/`Esc` with `useScreenKeys`
  and turn the screen's own selection off (`useSelection({ active: false })`) meanwhile.

## Data (`data-hooks.ts`)

Both hooks return a `DataState` (`loading`, `ready` or `failed`), which `<DataView>` draws, and
mark the app as working while they load.

- **`usePolled(read, intervalMs, key)`**: local, cheap reads (the history, the lock, config files):
  read at once, every 2 s on the scheduler, and again when `key` changes.
- **`useLoaded(key, load)`**: slow reads (GitHub, the AI CLI checks, git): through the load cache
  (`load-cache.ts`), shared by every screen under the same `key`, so going back to a screen shows
  the last value at once. It loads again on open when the value is older than `FRESH_MS` (30 s)
  and on `r`, which it binds itself; list `r` in `useScreenKeys` with `messages.keys.refresh`.

The app never starts a timer: periodic work goes through `scheduler.every()` and the clock is
`now()`, both from `useAppDeps()`.

## Handing the terminal over (`hand-off.ts`)

A screen that runs an interactive command (an AI CLI's login, a file in the editor) calls
`run(target)` of **`useHandOff()`**: the app leaves the alternate screen and raw mode, the command
owns the terminal (and Ctrl-C) until it ends, then the app redraws. `target` is
`{ kind: 'command', command, args }`, `{ kind: 'ai-login', provider }` (the login of Claude Code or
Codex, run by the CLI without the GitHub tokens) or `{ kind: 'editor', file }` (`$VISUAL` ›
`$EDITOR` › `vi`, resolved by the CLI). It resolves to `exited` with the exit code, `not-found` with the command, or
`failed` with the error, never throws, and to `undefined` when another hand-off is running; ignore
the key while `running`. Data that the command changes is read again on return: `reload()` of
`useLoaded` forces a slow load past `FRESH_MS` (its `loading` is true meanwhile). An exit code
other than 0 is a cancel or a failure to show in one line; the app keeps working. A login is judged
by that check, not by the exit code alone (`codex login` ends with 0 when cancelled):
`aiLoginLines()` (`login-lines.tsx`) says "not completed" while the CLI is still logged out.

## Changing the user config (`config-change.tsx`)

The app writes only the user's own `config.yml`, and only after showing the change.
**`useConfigChange(onSaved)`** gives `propose(changes)` (the `UserConfigChange` operations of
`src/config/user-config-edit.ts`), `cancel()`, `open`, `keys` and `state`. A proposal is planned
through `AppDeps.planConfig`; draw `configChangeLines(state, draw)` under the screen's lines: the
file (under `~`) and one line per value, before → after. The hook takes `Enter` itself (write, or
plan again when the file changed since the plan); the screen wires `Esc` with
`useBack(change.open ? change.cancel : …)`, ignores its own keys while `open` and shows `keys` in
`useScreenKeys`. A refusal or a failed write is one line from the catalogs. After a write the
language is read again at once and `onSaved(plan)` runs; a proposal that changes nothing calls
`onSaved` without writing. `valueChangeLines()` draws a list of written values.

## Indexing from a screen (`repository-indexing.tsx`)

**`useRepositoryIndexing(onEnded)`** indexes repositories one after the other through
`useIndexSeries()`: `start(repos)` (ignored while `busy`), `stop()`, `keys` (`Esc` while busy)
and `lines(width)` (each repository with its progress, then how it ended). The screen wires `Esc` with
`useBack(indexing.busy ? indexing.stop : …)`, draws the lines under its own and reads its data
again in `onEnded` (`reload()` of `useLoaded`). Leaving the screen aborts the indexing.

## Exploring a symbol (`symbol-explorer.tsx`)

**`<SymbolExplorer repo name>`** searches a name in the graph of a repository
(`AppDeps.searchSymbol`, loaded under its key, `r`), lists the definitions to pick when there are
several and draws the tree of one: `Enter`/`→` opens a node one level through
`AppDeps.symbolCallers`/`symbolDependencies`, with loading on that node, and `←` closes it. A name
not found or a repository that is not indexed is one line with `i` to index it, searched again
after. The Graph screen draws it in a `SubView` from `s`; the app keeps the graph of one repository
open (`src/cli/app-graph.ts`).

## An action flow in place of the tabs (`review-flow/`)

An action that takes several steps and runs something long (a review) is a flow drawn by the shell
in place of the tabs, as the setup and `/language` are, and back to the screen it came from. A
screen opens it through a context of `app-context.ts` (`useStartReview()` for `ReviewFlow`, with
the repository to start on), and the palette through an entry of the shell. While it is open,
`/` and `1`–`9` do nothing, so the palette never leaves a running review behind: the flow is left
with `Esc`, which asks while it runs. The setup and `/language` keep the palette.

The flow keeps a stack of steps: each step is a component with its own `useScreenKeys`,
`useScreenInput` and `useBack(back)`, where `back()` pops the stack or, at its first step, leaves
the flow (a step may remember what was picked in it, as the mode, so going back shows it chosen).
The step that runs calls the `AppDeps` function once on mount with a sink for its progress
events (`ReviewProgress`), folds them into lines (`review-steps.ts`), redraws its elapsed times
from `scheduler.every()` and `now()`, marks the app as working (`useWorking`, so the mascot flaps)
and passes an `AbortSignal` it aborts on unmount. While it runs, `Esc` asks before cancelling
(`useBack` never `undefined` there, which would quit the app): `Enter` aborts the signal, `Esc`
keeps it running; once it publishes, `Esc` does nothing. It holds a quit guard while it runs. When
it ends, `Esc` leaves the flow; the result is drawn with the module the screen that lists such
results also uses (`reviewDetailLines()` of `review-detail.tsx`). With a watch holding the lock
(`readQueue`), publishing becomes a request in the queue (`AppDeps.enqueueReview`), and `Enter`
on its result opens the Queue; `reviewPullRequest` reads the lock again before publishing and
answers `watch-running`, which takes the flow back to that confirmation. A view that opens in
place of a step's result and must come back to it without running the step again (publishing
what only look found, `p`) is drawn by that step in place of its lines, while the step's own keys
live in a child component that is unmounted meanwhile, so the two never hold `useBack` or the
footer at once. Each step is its own file in `review-flow/`, as the setup's are in `setup/`.

## Quitting while something runs (`useQuitGuard`)

A screen or flow that runs something the person may lose by quitting (a review, the watch) holds
a **`QuitGuard`** while it runs: `useQuitGuard({ question, stop, abort })`, or `undefined` once it
ended. While any guard is held, `q`, `Esc` at the top and `Ctrl-C` show its `question` (one line
from the catalogs) in place of the screen: `Enter` calls `stop()` on each guard, shows
"Stopping…" while a returned promise is pending and quits once they settled (`quit` for `q` and
`Esc`, `interrupted` for `Ctrl-C`); `Esc` stays. A second `Ctrl-C`, asking or stopping, calls
`abort()` on each and exits `interrupted` at once. `SIGINT` and `SIGTERM` call `abort()` without
asking and exit `interrupted` or `terminated`. `stop()` is the gentle end (cancel before
publishing, or finish the job under way) and `abort()` the immediate one; both keep the screen
mounted until the app exits.

## The watch of the app (`app-watch.tsx`)

The shell holds the watch the app runs (`useWatchSession()`, above the screens, so switching tabs
or opening a flow keeps it and its log) and gives it to the screens through **`useAppWatch()`**:
its `phase` (`idle`, `starting`, `running`, `stopping`), a `notice` (held by another PID, or why it
did not start), its `log` (`WatchLogEntry`, the last 200 on the app clock, drawn with
`watchLogText()` of `watch-log.ts`), the `running` job with its review steps, and the stop
question (`asking`, `toggle(holder)`, `confirmStop()`, `keepRunning()`). It starts through
`AppDeps.startWatch(observer)`, which says when another PID holds the lock; `AppDeps.pid` tells
the lock of this app from another one. While it runs it holds a quit guard: `stop()` waits for the
current review, `abort()` stops at once.

## A picker inside a screen (`sub-view.tsx`)

The pickers the setup uses (`ProviderPicker`, `RepositoryPicker`, `LanguagePicker`) also edit from
a screen. The screen keeps only a mode and draws either its view or the picker inside
**`<SubView onLeave>`**, which gathers the picker's keys and back: `Esc` goes to the picker while
it holds it (a change shown, a model list), else to `onLeave()`, and the footer shows `Esc back`
then. The view and the picker are separate components, so each one has its own
`useScreenKeys`/`useScreenInput`; on return the view reads again what the picker changed
(`reload()` of `useLoaded`, which a `usePolled` read does by itself on mount). The shell draws the
`LanguagePicker` the same way in place of the tabs for `/language` in the palette, and goes back
to the screen it came from.

## The setup (`setup/`)

The setup takes the place of the tabs (`AppDeps.start`, `/setup`). Each step is a component of
`SETUP_STEPS` (`setup-steps.ts`) with `{ progress, next }`; `next(result)` goes on and records
what the step did, `s` skips a `skippable` step while the step leaves `Esc` to the setup (a step
that is indexing or showing a change finishes or backs out first). A step is written as a screen: `useScreenKeys`,
`useScreenInput`, `useBack` and `useScreenSize` reach the setup, which adds `s` and `Esc`, asks
before leaving and silences the step meanwhile.

A step can be a component another screen also uses: the AI step is `ProviderPicker`
(`provider-picker.tsx`), which checks the AIs, logs in through `useHandOff()`, pulls an Ollama model
with `useModelPull()` (`model-pull.tsx`: `start(model)`, `cancel()` on `Esc`, aborted on unmount)
and proposes the provider and model through `useConfigChange()`; it calls `onSaved(plan)` once
written. The repositories step is `RepositoryPicker` (`repository-picker.tsx`): the repositories
of the token owner (`AppDeps.readUserRepositories`, loaded under `user-repos`) with `watch.repos`
marked, a filter on `f`, `Space` to mark, `a` for a typed `owner/repo`, and `Enter` proposing the
`watch`/`unwatch` changes; `onContinue` runs when nothing changed or there is no token. The graph
step indexes the watched repositories one after the other with `useIndexSeries()`
(`index-series.ts`: `AppDeps.indexRepository` with an `AbortController`, `stop()` on `Esc`,
aborted on unmount), and the repository step offers `phada init` (`AppDeps.initRepository`) when
the app's folder is a git repository without `.phada/`. A step ends with `next(result)`: the
config it wrote (`written`), the indexing or the init, which the summary shows.

## Growing `AppDeps`

A screen reads only through `AppDeps` (`app-context.ts`): a function returning the data of a use
case of `src/app/`, never text. A new read is added in three places:

1. the field in `AppDeps`, typed with the use case's types (`import type`);
2. its wiring in `appDeps()` of `src/cli/app-command.ts`, with any reader the test needs to replace
   added as an optional field of `AppCommandDeps`;
3. a fake default in `fakeAppDeps()` of `test/support/tui.tsx`.

## Fitting in 80×24

Below 80×24 the shell shows a warning instead of the screen. `useScreenSize()` gives the screen
its area (the terminal without the tab bar and the footer); draw at most `rows` lines no wider
than `columns`. Long content goes through `ScrollList`/`ScrollText` and `useSelection`
(`scroll-list.tsx`); lines are cut with `fit()`, `wrapText()`, `namesText()` and `shortenHome()`
(`text-fit.ts`).

## Text

- Every word the app writes comes from the catalogs in `i18n/`: the key in `UiMessages`
  (`messages.ts`) and its text in `en.ts`, `pt.ts` and `es.ts`, read with `useMessages()`.
- Every text from outside (names, paths, config values, what GitHub, git or an AI CLI answered)
  goes through `oneLine()`, or `wrapText()` (`textLines()` for drawn lines) when it spans lines;
  every error through `failedNodes(draw, error)` (wrapped over `ERROR_LINES`, so a config error
  shows its key and reason), `failedText(messages, error, say?)` where one line is all there is (`say` puts the
  reason in a sentence of the catalogs, as the watch log does), or
  `<DataView>`. They strip control and bidi characters.
- A frame drawn as lines takes a `DrawContext` (the catalog, the theme and the width) and draws
  them with the helpers of `frame-lines.tsx` (`textLines()`, `failedNodes()`, `spaced()`,
  `<Lines>`).

## Tests

Each screen has a `screens/<name>.test.tsx` that renders the whole app with
`renderApp({ deps, size, screens })` from `test/support/tui.tsx` (fake deps, size and scheduler)
and reads its frames:

- wait on a condition before asserting: `await showing('text', /pattern/)` or
  `await until(() => condition)`, which fail with what they awaited and the last frame when it
  does not come within 3 s; drive keys with `press(KEYS.down)` and `type('text')`, time
  with `clock.advance(ms)`, the size with `resize()`. A fixed pause (`setTimeout`, `settle()`) is
  refused by `src/architecture.test.ts`;
- check the frame fits: at 80×24, every line of `frameLines(frame())` at most 80 columns wide
  (`visibleWidth()`);
- check the screen is the one `SCREENS` registers under its id.
