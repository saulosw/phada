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
`{ kind: 'command', command, args }` or `{ kind: 'editor', file }` (`$VISUAL` › `$EDITOR` › `vi`,
resolved by the CLI). It resolves to `exited` with the exit code, `not-found` with the command, or
`failed` with the error, never throws, and to `undefined` when another hand-off is running; ignore
the key while `running`. Data that the command changes is read again on return: `reload()` of
`useLoaded` forces a slow load past `FRESH_MS`. An exit code other than 0 is a cancel or a failure
to show in one line; the app keeps working.

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

## The setup (`setup/`)

The setup takes the place of the tabs (`AppDeps.start`, `/setup`). Each step is a component of
`SETUP_STEPS` (`setup-steps.ts`) with `{ progress, next }`; `next(plan)` goes on and records what
was written, `s` skips a `skippable` step. A step is written as a screen: `useScreenKeys`,
`useScreenInput`, `useBack` and `useScreenSize` reach the setup, which adds `s` and `Esc`, asks
before leaving and silences the step meanwhile.

A step can be a component another screen also uses: the AI step is `ProviderPicker`
(`provider-picker.tsx`), which checks the AIs, logs in through `useHandOff()`, pulls an Ollama model
with `useModelPull()` (`model-pull.tsx`: `start(model)`, `cancel()` on `Esc`, aborted on unmount)
and proposes the provider and model through `useConfigChange()`; it calls `onSaved(plan)` once
written.

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
  goes through `oneLine()`, or `wrapText()` when it spans lines; every error through
  `failedText(messages, error)` or `<DataView>`. Both strip control and bidi characters.

## Tests

Each screen has a `screens/<name>.test.tsx` that renders the whole app with
`renderApp({ deps, size, screens })` from `test/support/tui.tsx` (fake deps, size and scheduler)
and reads its frames:

- wait on a condition before asserting: `await showing('text', /pattern/)` or
  `await until(() => condition)`; drive keys with `press(KEYS.down)` and `type('text')`, time
  with `clock.advance(ms)`, the size with `resize()`. A fixed pause (`setTimeout`, `settle()`) is
  refused by `src/architecture.test.ts`;
- check the frame fits: at 80×24, every line of `frameLines(frame())` at most 80 columns wide
  (`visibleWidth()`);
- check the screen is the one `SCREENS` registers under its id.
