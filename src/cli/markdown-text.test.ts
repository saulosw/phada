import { describe, expect, it } from 'vitest'
import { githubBlock, githubCell, githubLine } from './markdown-text.js'

const ZWSP = '\u200b'

describe('githubBlock', () => {
  it('escapes HTML exposed by a code span that crosses a line break', () => {
    expect(githubBlock('`foo\n`<details>`')).toBe('`foo\n`\\<details>`')
  })

  it('escapes HTML so AI text cannot forge a marker or inject tags', () => {
    expect(githubBlock('see <!-- phada:review sha=x findings=0 --> here')).toBe(
      'see \\<!-- phada:review sha=x findings=0 --> here',
    )
    expect(githubBlock('a <details><summary>x</summary>')).toBe(
      'a \\<details>\\<summary>x\\</summary>',
    )
  })

  it('breaks mentions with a zero-width space', () => {
    expect(githubBlock('ping @octocat and cc @org/team, not a@')).toBe(
      `ping @${ZWSP}octocat and cc @${ZWSP}org/team, not a@`,
    )
  })

  it('breaks a mention hidden behind a control character', () => {
    expect(githubBlock('ping @\u0007octocat and @\u202Eadmin')).toBe(
      `ping @${ZWSP}octocat and @${ZWSP}admin`,
    )
  })

  it('breaks issue and pull request references outside code', () => {
    expect(githubBlock('see #12, saulosw/phada#3 and gh-5, not C#5, `#7` or &#60;')).toBe(
      `see #${ZWSP}12, saulosw/phada#${ZWSP}3 and gh-${ZWSP}5, not C#5, \`#7\` or &#60;`,
    )
  })

  it('keeps inline code as written, but still breaks mentions inside it', () => {
    expect(githubBlock('use `Array<string>` with `@octocat`')).toBe(
      `use \`Array<string>\` with \`@${ZWSP}octocat\``,
    )
  })

  it('escapes HTML after an escaped backtick, which opens no code span', () => {
    expect(githubBlock('\\`<b>\\`')).toBe('\\`\\<b>\\`')
  })

  it('keeps a backslash before < from turning the escape off', () => {
    expect(githubBlock('C:\\<details> and \\\\<!-- x -->')).toBe(
      'C:\\\\\\<details> and \\\\\\\\\\<!-- x -->',
    )
  })

  it('escapes HTML in a code span that opens a line, which the fence escape breaks', () => {
    expect(githubBlock('```<details>``` opens')).toBe('\\```\\<details>``` opens')
    expect(githubBlock('- ```<img src=x>``` here')).toBe('- \\```\\<img src=x>``` here')
  })

  it('escapes block markers at the start of a line like the terminal output', () => {
    expect(githubBlock('# Title\n```js\nx\n```\n---')).toBe('\\# Title\n\\```js\nx\n\\```\n\\---')
  })

  it('removes control and bidi characters', () => {
    expect(githubBlock('a‮b\u0007c')).toBe('abc')
  })
})

describe('githubLine and githubCell', () => {
  it('never pairs backticks across paragraphs, as GitHub never does', () => {
    expect(githubBlock('text `a\n\nx <details> y\n\nb` end')).toBe(
      'text `a\n\nx \\<details> y\n\nb` end',
    )
  })

  it('keeps code spans of a paragraph even when another paragraph has a stray backtick', () => {
    expect(githubBlock('a stray ` here\n\nuse `Array<T>`')).toBe('a stray ` here\n\nuse `Array<T>`')
  })

  it('keeps a code span that sits whole on its line when no backtick is left over', () => {
    expect(githubBlock('use `Array<T>`\nand `Map<K, V>`')).toBe('use `Array<T>`\nand `Map<K, V>`')
  })

  it('joins lines before finding code spans that could expose HTML', () => {
    expect(githubLine('`foo\n`<details>`')).toBe('`foo `\\<details>`')
    expect(githubCell('`foo\n`<details>`')).toBe('`foo `\\<details>`')
  })

  it('join lines and escape like a block', () => {
    expect(githubLine('one\n  <two> @octocat')).toBe(`one \\<two> @${ZWSP}octocat`)
  })

  it('escape pipes in a table cell', () => {
    expect(githubCell('a | <b>')).toBe('a \\| \\<b>')
  })
})
