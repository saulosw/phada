import type { ResolvedRule } from '../config/merge-config.js'
import { byteLength } from './byte-cut.js'
import { readFrontmatter } from './frontmatter.js'
import { DOC_LIMIT_BYTES, truncateDoc } from './select-docs.js'

export const CLAUDE_RULES_GLOB = '.claude/rules/**/*.md'

const EVERYWHERE = ['**']
const FENCED_FRONTMATTER = /^﻿?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/
const HTML_COMMENT = /<!--[\s\S]*?-->/g

export interface ClaudeRule {
  rule?: ResolvedRule
  warnings: string[]
}

export function claudeRule(path: string, text: string): ClaudeRule {
  const frontmatter = readFrontmatter(text)
  const warnings: string[] = []
  if (frontmatter.status === 'invalid') {
    warnings.push(`${path}: could not read its front matter; applied to every file.`)
  }
  const paths = frontmatter.status === 'ok' ? (frontmatter.fields.get('paths') ?? []) : []
  const scope = paths.map((pattern) => pattern.replace(/^(?:\.\/|\/)+/, '')).filter(Boolean)
  const body = (frontmatter.status === 'ok' ? text.replace(FENCED_FRONTMATTER, '') : text)
    .replace(HTML_COMMENT, '')
    .trim()
  if (body === '') return { warnings }
  const cut = byteLength(body) > DOC_LIMIT_BYTES
  if (cut) warnings.push(`${path}: over ${DOC_LIMIT_BYTES / 1000} KB; sent cut.`)
  return {
    rule: {
      key: path,
      text: cut ? truncateDoc(body) : body,
      scope: scope.length === 0 ? EVERYWHERE : scope,
      origin: path,
    },
    warnings,
  }
}
