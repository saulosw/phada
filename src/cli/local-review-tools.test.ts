import { describe, expect, it } from 'vitest'
import { handleMcpMessage } from '../investigation/mcp/mcp-server.js'
import { localReviewToolbox } from './local-review-tools.js'
import type {
  LocalChangesRequest,
  LocalChangesReview,
  LocalReviewToolsDeps,
} from './local-review-tools.js'

const START = Date.parse('2026-11-07T12:00:00.000Z')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<LocalReviewToolsDeps> = {}) {
  let now = START
  const requests: LocalChangesRequest[] = []
  const reviews: ReturnType<typeof deferred<LocalChangesReview>>[] = []
  const deps: LocalReviewToolsDeps = {
    readToken: async () => 'token',
    review: (request) => {
      requests.push(request)
      const review = deferred<LocalChangesReview>()
      reviews.push(review)
      return review.promise
    },
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms
    },
    ...overrides,
  }
  return {
    toolbox: localReviewToolbox(deps),
    requests,
    reviews,
    waited: () => now - START,
  }
}

async function call(toolbox: ReturnType<typeof localReviewToolbox>, name: string, args: unknown) {
  const result = await toolbox.call(name, args)
  return { ...result, json: result.isError ? undefined : (JSON.parse(result.text) as unknown) }
}

describe('localReviewToolbox', () => {
  it('lists the two tools with their schemas, and only the start one reaches out', async () => {
    const { toolbox } = setup()

    const listed = JSON.parse(
      (await handleMcpMessage(toolbox, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')) ?? '',
    ) as { result: { tools: { name: string; inputSchema: unknown; annotations: unknown }[] } }

    expect(listed.result.tools).toEqual([
      expect.objectContaining({
        name: 'review_local_changes',
        inputSchema: expect.objectContaining({
          properties: {
            base: expect.objectContaining({ type: 'string' }) as unknown,
            uncommitted: expect.objectContaining({ type: 'boolean' }) as unknown,
          },
        }) as unknown,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }),
      expect.objectContaining({
        name: 'wait_for_local_review',
        inputSchema: expect.objectContaining({ required: ['review'] }) as unknown,
        annotations: { readOnlyHint: true, openWorldHint: false },
      }),
    ])
  })

  it('starts a local review of the branch and answers its id at once', async () => {
    const { toolbox, requests } = setup()

    const started = await call(toolbox, 'review_local_changes', { base: 'develop' })

    expect(started.json).toEqual({ review: 1 })
    expect(requests).toEqual([{ token: 'token', base: 'develop', uncommitted: false }])
  })

  it('answers the running review instead of starting a second one, and a new one once it ended', async () => {
    const { toolbox, requests, reviews } = setup()
    await call(toolbox, 'review_local_changes', {})

    const again = await call(toolbox, 'review_local_changes', { uncommitted: true })
    expect(again.json).toEqual({
      review: 1,
      alreadyRunning: true,
      message: expect.stringContaining('already running') as unknown,
    })
    expect(requests).toHaveLength(1)

    reviews[0]?.resolve({ json: '{}', history: { status: 'off' }, warnings: [] })
    await call(toolbox, 'wait_for_local_review', { review: 1 })
    const next = await call(toolbox, 'review_local_changes', { uncommitted: true })
    expect(next.json).toEqual({ review: 2 })
    expect(requests[1]).toEqual({ token: 'token', uncommitted: true })
  })

  it('waits for the review and answers its JSON with the history run it was saved as', async () => {
    const { toolbox, reviews } = setup({
      sleep: async () => {
        reviews[0]?.resolve({
          json: '{"schemaVersion":1,"verdict":"comments"}',
          history: { status: 'saved', runId: 42 },
          warnings: [],
        })
        await Promise.resolve()
      },
    })
    await call(toolbox, 'review_local_changes', {})

    const waited = await call(toolbox, 'wait_for_local_review', { review: 1 })

    expect(waited.json).toEqual({
      timedOut: false,
      review: 1,
      result: { schemaVersion: 1, verdict: 'comments' },
      runId: 42,
    })
  })

  it('tells the warnings of the review with its answer', async () => {
    const { toolbox, reviews } = setup()
    await call(toolbox, 'review_local_changes', { uncommitted: true })
    reviews[0]?.resolve({
      json: '{}',
      history: { status: 'off' },
      warnings: ['Nothing uncommitted: reviewing the commits of feat/spend.'],
    })

    const waited = await call(toolbox, 'wait_for_local_review', { review: 1 })

    expect(waited.json).toEqual({
      timedOut: false,
      review: 1,
      result: {},
      warnings: ['Nothing uncommitted: reviewing the commits of feat/spend.'],
    })
  })

  it('gives up waiting after timeoutSeconds, at most 1800, and answers timedOut', async () => {
    const { toolbox, waited } = setup()
    await call(toolbox, 'review_local_changes', {})

    const short = await call(toolbox, 'wait_for_local_review', { review: 1, timeoutSeconds: 5 })
    expect(short.json).toEqual({ timedOut: true, review: 1 })
    expect(waited()).toBe(5_000)

    await call(toolbox, 'wait_for_local_review', { review: 1, timeoutSeconds: 99_999 })
    expect(waited()).toBe(5_000 + 1_800_000)
  })

  it('fails a wait on a review it did not start', async () => {
    const { toolbox } = setup()

    const waited = await call(toolbox, 'wait_for_local_review', { review: 3 })

    expect(waited).toMatchObject({ isError: true, text: 'There is no local review 3.' })
  })

  it('surfaces the message of a review that failed', async () => {
    const { toolbox, reviews } = setup()
    await call(toolbox, 'review_local_changes', {})
    reviews[0]?.reject(new Error('There is nothing to review: the branch has no changes.'))

    const waited = await call(toolbox, 'wait_for_local_review', { review: 1 })

    expect(waited).toMatchObject({
      isError: true,
      text: 'There is nothing to review: the branch has no changes.',
    })
  })

  it('refuses arguments of the wrong type', async () => {
    const { toolbox, requests } = setup()

    expect(await call(toolbox, 'review_local_changes', { base: 3 })).toMatchObject({
      isError: true,
      text: 'base must be the name of a branch or a commit.',
    })
    expect(await call(toolbox, 'review_local_changes', { uncommitted: 'yes' })).toMatchObject({
      isError: true,
      text: 'uncommitted must be true or false.',
    })
    expect(await call(toolbox, 'wait_for_local_review', { review: '1' })).toMatchObject({
      isError: true,
      text: 'review must be the id review_local_changes answered.',
    })
    expect(requests).toEqual([])
  })

  it('fails to start without a GitHub token', async () => {
    const { toolbox, requests } = setup({ readToken: async () => undefined })

    const started = await call(toolbox, 'review_local_changes', {})

    expect(started.isError).toBe(true)
    expect(started.text).toContain('GITHUB_TOKEN')
    expect(requests).toEqual([])
  })

  it('starts one review when two calls arrive together', async () => {
    const { toolbox, requests } = setup()

    const answers = await Promise.all([
      call(toolbox, 'review_local_changes', {}),
      call(toolbox, 'review_local_changes', {}),
    ])

    expect(answers.map(({ json }) => (json as { review: number }).review)).toEqual([1, 1])
    expect(requests).toHaveLength(1)
  })
})
