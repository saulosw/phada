export const MAX_LINKS_PER_MESSAGE = 5

const PULL_LINK = /(?<![\w./-])https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?![\d])/g

export interface PullLink {
  repo: string
  number: number
}

export function pullRequestLinks(text: string): PullLink[] {
  const links: PullLink[] = []
  const seen = new Set<string>()
  for (const [, owner = '', repo = '', number = ''] of text.matchAll(PULL_LINK)) {
    const link = { repo: `${owner}/${repo}`.toLowerCase(), number: Number(number) }
    const key = `${link.repo}#${link.number}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push(link)
    if (links.length === MAX_LINKS_PER_MESSAGE) break
  }
  return links
}
