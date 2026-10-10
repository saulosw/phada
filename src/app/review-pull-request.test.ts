import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import type { ContextSources } from '../context/types.js'
import type { Checkout } from '../investigation/checkout/checkout.js'
import { CheckoutUnavailableError } from '../investigation/checkout/git-checkout.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { reviewPullRequest } from './review-pull-request.js'
import type { PullRequestReviewDeps } from './review-pull-request.js'

const OUTPUT: ReviewOutput = {
  text: reviewReportJson({ findings: [findingFixture({ line: 3, confidence: 95 })] }),
  durationMs: 10,
}

const sources: ContextSources = {
  readTree: async () => ({ entries: [], truncated: false }),
  readRepoFile: async () => null,
  readLocalFile: async () => null,
  listLocalDocs: async () => null,
}

function checkout(onClose: () => void): Checkout {
  return {
    commit: 'abc',
    readText: async () => 'text\n',
    grep: async () => [],
    listDir: async () => [],
    close: async () => onClose(),
  }
}

function setup(overrides: Partial<PullRequestReviewDeps> = {}) {
  const events: string[] = []
  const prompts: ReviewPrompt[] = []
  const servers: (readonly string[])[] = []
  let closed = 0
  const provider: ReviewProvider = {
    id: 'fake',
    review: async (prompt) => {
      events.push('review')
      prompts.push(prompt)
      return OUTPUT
    },
  }
  const deps: PullRequestReviewDeps = {
    env: {},
    contextSources: sources,
    openCheckout: async () =>
      checkout(() => {
        closed += 1
      }),
    createProvider: (userMcpServers) => {
      servers.push(userMcpServers)
      return provider
    },
    events: {
      contextLoaded: () => events.push('context'),
      warning: (message) => events.push(`warning: ${message}`),
    },
    ...overrides,
  }
  return { deps, events, prompts, servers, closed: () => closed }
}

const input = {
  pullRequest: pullRequestFixture(),
  token: 'token',
  userLayers: [],
  userMcpServers: ['linear'],
  options: { verify: false },
}

describe('reviewPullRequest', () => {
  it('loads the context, investigates, reviews and reports what the AI read', async () => {
    const h = setup()

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toEqual([
      'context',
      'warning: acme/shop is public: what the AI reads from linear may end up in the published review.',
      'review',
    ])
    expect(h.prompts[0]?.tools?.definitions.map((tool) => tool.name)).toEqual([
      'read_file',
      'grep',
      'list',
    ])
    expect(h.servers).toEqual([['linear']])
    expect(h.closed()).toBe(1)
    expect(result.outcome.status).toBe('reviewed')
    expect(result.investigation).toMatchObject({ status: 'used', totals: { calls: 0 } })
  })

  it("reviews without tools or the user's servers when the head cannot be fetched", async () => {
    const h = setup({
      openCheckout: () =>
        Promise.reject(new CheckoutUnavailableError('git-missing', 'git was not found')),
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toEqual([
      'context',
      'warning: git was not found: reviewing without investigation.',
      'review',
    ])
    expect(h.prompts[0]?.tools).toBeUndefined()
    expect(h.servers).toEqual([[]])
    expect(result.investigation).toMatchObject({
      status: 'unavailable',
      reason: 'git was not found',
    })
  })

  it('closes the checkout when the provider cannot be created', async () => {
    const h = setup()
    h.deps.createProvider = () => {
      throw new Error('no provider')
    }

    await expect(reviewPullRequest(input, h.deps)).rejects.toThrow('no provider')
    expect(h.closed()).toBe(1)
  })

  it('names the review and the verification passes for whoever watches the provider', async () => {
    const passes: string[] = []
    const h = setup()
    h.deps.watchProvider = (provider, pass) => {
      passes.push(pass)
      return provider
    }

    await reviewPullRequest({ ...input, options: { investigate: false, verify: false } }, h.deps)

    expect(passes).toEqual(['review', 'verify'])
  })
})
