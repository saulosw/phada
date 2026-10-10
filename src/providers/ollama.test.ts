import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { OllamaProvider } from './ollama.js'
import type { OllamaProviderOptions } from './ollama.js'
import { ProviderError } from './types.js'
import type { ReviewPrompt, Toolbox } from './types.js'

const FAKE_SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const MODEL = 'qwen2.5-coder:7b'
const PROMPT: ReviewPrompt = {
  instructions: 'You are a careful reviewer. Trusted instructions only.',
  data: 'Review this diff, please: +const answer = 42',
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
}
const PROMPT_CHARS = PROMPT.instructions.length + PROMPT.data.length
const UNCOUNTED_CHAT = { prompt_eval_count: undefined, eval_count: undefined }

function show(contextLength = 32768, architecture = 'qwen2'): FakeResponse {
  const modelInfo = {
    'general.architecture': architecture,
    [`${architecture}.context_length`]: contextLength,
  }
  return {
    status: 200,
    body: JSON.stringify({ capabilities: ['completion'], model_info: modelInfo }),
  }
}

function chat(fields: Record<string, unknown> = {}): FakeResponse {
  return {
    status: 200,
    body: JSON.stringify({
      model: MODEL,
      message: { role: 'assistant', content: 'LGTM from fake ollama' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 60,
      eval_count: 12,
      ...fields,
    }),
  }
}

function setup(
  routes: { show?: FakeResponse[]; chat?: FakeResponse[] },
  options: Partial<OllamaProviderOptions> = {},
) {
  const fake = createFakeFetch(
    { '/api/show': routes.show ?? [show()], '/api/chat': routes.chat ?? [chat()] },
    (call) => new URL(call.url).pathname,
  )
  const provider = new OllamaProvider({ model: MODEL, env: {}, fetch: fake.fetch, ...options })
  return { provider, calls: fake.calls }
}

function bodyOf(call: FakeCall | undefined): Record<string, unknown> {
  return JSON.parse(call?.body ?? '{}') as Record<string, unknown>
}

function failingFetch(code: string): typeof globalThis.fetch {
  const cause = Object.assign(new Error(`request failed ${FAKE_SECRET}`), { code })
  return () => Promise.reject(new TypeError('fetch failed', { cause }))
}

async function reviewError(provider: OllamaProvider, prompt = PROMPT): Promise<ProviderError> {
  const error = await provider.review(prompt).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ProviderError)) {
    throw new Error('expected review() to reject with ProviderError')
  }
  return error
}

describe('OllamaProvider', () => {
  it('has the ollama id', () => {
    expect(new OllamaProvider({ model: MODEL }).id).toBe('ollama')
  })

  it('rejects an OLLAMA_HOST that is not an address as soon as it is created', () => {
    const create = () => new OllamaProvider({ model: MODEL, env: { OLLAMA_HOST: 'http://' } })

    expect(create).toThrow(ProviderError)
    expect(create).toThrow('OLLAMA_HOST "http://" is not a valid address.')
  })

  it('returns the review, the model that answered, the duration and the token usage', async () => {
    const { provider } = setup({})

    const output = await provider.review(PROMPT)

    expect(output).toEqual({
      text: 'LGTM from fake ollama',
      model: MODEL,
      durationMs: expect.any(Number),
      usage: { inputTokens: 60, outputTokens: 12 },
    })
  })

  it('asks for the model details and then chats with the local Ollama by default', async () => {
    const { provider, calls } = setup({})

    await provider.review(PROMPT)

    expect(calls.map(({ url, method }) => [method, url])).toEqual([
      ['POST', 'http://127.0.0.1:11434/api/show'],
      ['POST', 'http://127.0.0.1:11434/api/chat'],
    ])
    expect(bodyOf(calls[0])).toEqual({ model: MODEL })
    expect(calls[1]?.headers['content-type']).toBe('application/json')
  })

  it('sends the instructions as the system message and the data as the user message', async () => {
    const { provider, calls } = setup({})

    await provider.review(PROMPT)

    expect(bodyOf(calls[1])).toEqual({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'system', content: PROMPT.instructions },
        { role: 'user', content: PROMPT.data },
      ],
      format: PROMPT.outputSchema,
      options: { num_ctx: 9216, num_predict: 8192 },
    })
  })

  it('uses OLLAMA_HOST when it is set', async () => {
    const { provider, calls } = setup({}, { env: { OLLAMA_HOST: 'gpu-box:9000' } })

    await provider.review(PROMPT)

    expect(calls[0]?.url).toBe('http://gpu-box:9000/api/show')
    expect(calls[1]?.url).toBe('http://gpu-box:9000/api/chat')
  })

  it('sizes the context to the prompt, rounded up to the next 1024 tokens', async () => {
    const { provider, calls } = setup({ chat: [chat(UNCOUNTED_CHAT)] })
    const data = 'x'.repeat(20_000)

    await provider.review({ ...PROMPT, data })

    const needed = Math.ceil((PROMPT.instructions.length + data.length) / 2) + 8192
    expect(bodyOf(calls[1])).toMatchObject({
      options: { num_ctx: Math.ceil(needed / 1024) * 1024 },
    })
  })

  it('never asks for more context than the model holds', async () => {
    const { provider, calls } = setup({ show: [show(18_300)], chat: [chat(UNCOUNTED_CHAT)] })
    const data = 'x'.repeat(20_000)

    await provider.review({ ...PROMPT, data })

    expect(bodyOf(calls[1])).toMatchObject({ options: { num_ctx: 18_300 } })
  })

  it('reports prompt-too-large without calling the chat when the prompt does not fit', async () => {
    const { provider, calls } = setup({ show: [show(16_384)] })
    const data = 'x'.repeat(20_000)

    const error = await reviewError(provider, { ...PROMPT, data })

    const needed = Math.ceil((PROMPT.instructions.length + data.length) / 2) + 8192
    expect(error).toMatchObject({ providerId: 'ollama', reason: 'prompt-too-large' })
    expect(error.message).toBe(
      `The review needs about ${needed} tokens but ${MODEL} holds 16384. Use a model with a larger context window (see "ollama show ${MODEL}") or a :cloud model.`,
    )
    expect(calls).toHaveLength(1)
  })

  it('counts every character that is not ASCII as two tokens when sizing the context', async () => {
    const { provider, calls } = setup({ chat: [chat(UNCOUNTED_CHAT)] })

    await provider.review({ ...PROMPT, data: '漢'.repeat(10_000) })

    expect(bodyOf(calls[1])).toMatchObject({ options: { num_ctx: 28_672 } })
  })

  it('reports prompt-too-large for text that is not ASCII and does not fit', async () => {
    const { provider, calls } = setup({ show: [show(16_384)] })

    const error = await reviewError(provider, { ...PROMPT, data: '漢'.repeat(10_000) })

    expect(error.reason).toBe('prompt-too-large')
    expect(error.message).toContain('The review needs about 28219 tokens')
    expect(calls).toHaveLength(1)
  })

  it('reads the context length of any architecture', async () => {
    const { provider, calls } = setup({
      show: [show(262_144, 'kimi-k2')],
      chat: [chat(UNCOUNTED_CHAT)],
    })
    const data = 'x'.repeat(100_000)

    await provider.review({ ...PROMPT, data })

    expect(bodyOf(calls[1])).toMatchObject({ options: { num_ctx: 58_368 } })
  })

  it('falls back to any context_length key when the architecture key is missing', async () => {
    const body = JSON.stringify({ model_info: { 'llama.context_length': 131_072 } })
    const { provider, calls } = setup({
      show: [{ status: 200, body }],
      chat: [chat(UNCOUNTED_CHAT)],
    })

    await provider.review({ ...PROMPT, data: 'x'.repeat(20_000) })

    expect(bodyOf(calls[1])).toMatchObject({ options: { num_ctx: 18_432 } })
  })

  it("prefers the architecture's context length over other context_length keys", async () => {
    const body = JSON.stringify({
      model_info: {
        'clip.vision.context_length': 576,
        'general.architecture': 'qwen2',
        'qwen2.context_length': 32768,
      },
    })
    const { provider, calls } = setup({
      show: [{ status: 200, body }],
      chat: [chat(UNCOUNTED_CHAT)],
    })

    await provider.review({ ...PROMPT, data: 'x'.repeat(20_000) })

    expect(bodyOf(calls[1])).toMatchObject({ options: { num_ctx: 18_432 } })
  })

  it.each([
    ['no context_length', JSON.stringify({ model_info: { 'general.architecture': 'qwen2' } })],
    ['no model_info', JSON.stringify({ capabilities: ['completion'] })],
    ['a model_info that is not an object', JSON.stringify({ model_info: 'qwen2' })],
    [
      'a context_length that is not a positive integer',
      JSON.stringify({ model_info: { 'qwen2.context_length': 0 } }),
    ],
  ])('reports failed without chatting when the model details have %s', async (_case, body) => {
    const { provider, calls } = setup({ show: [{ status: 200, body }] })

    const error = await reviewError(provider)

    expect(error).toMatchObject({ providerId: 'ollama', reason: 'failed' })
    expect(error.message).toBe(`Could not read the context window of "${MODEL}" from Ollama.`)
    expect(calls).toHaveLength(1)
  })

  it('says where it looked when nothing answers at the Ollama address', async () => {
    const provider = new OllamaProvider({
      model: MODEL,
      env: { OLLAMA_HOST: '127.0.0.1:11999' },
      fetch: failingFetch('ECONNREFUSED'),
    })

    const error = await reviewError(provider)

    expect(error).toMatchObject({ providerId: 'ollama', reason: 'failed' })
    expect(error.message).toBe(
      'Ollama is not running at http://127.0.0.1:11999. Start it with "ollama serve" or install it from https://ollama.com/download.',
    )
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN'])(
    'says Ollama is not running when the address does not resolve (%s)',
    async (code) => {
      const provider = new OllamaProvider({ model: MODEL, env: {}, fetch: failingFetch(code) })

      const error = await reviewError(provider)

      expect(error.reason).toBe('failed')
      expect(error.message).toMatch(/^Ollama is not running at http:\/\/127\.0\.0\.1:11434\./)
    },
  )

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])(
    'reports timeout when the HTTP client gives up waiting (%s)',
    async (code) => {
      const provider = new OllamaProvider({
        model: MODEL,
        env: {},
        fetch: failingFetch(code),
        timeoutMs: 1_800_000,
      })

      const error = await reviewError(provider)

      expect(error.reason).toBe('timeout')
      expect(error.message).toBe('Ollama did not answer within 1800s.')
    },
  )

  it('says it could not reach Ollama, with the error code, for any other failure', async () => {
    const provider = new OllamaProvider({
      model: MODEL,
      env: { OLLAMA_HOST: 'gpu-box:9000' },
      fetch: failingFetch('ECONNRESET'),
    })

    const error = await reviewError(provider)

    expect(error.reason).toBe('failed')
    expect(error.message).toBe('Could not reach Ollama at http://gpu-box:9000 (ECONNRESET).')
  })

  it('names the error when a failure has no code', async () => {
    const { provider } = setup({ show: ['network-error'] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('failed')
    expect(error.message).toBe('Could not reach Ollama at http://127.0.0.1:11434 (TypeError).')
  })

  it('tells how to pull a model that Ollama does not have', async () => {
    const body = JSON.stringify({ error: `model '${MODEL}' not found` })
    const { provider } = setup({ show: [{ status: 404, body }] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('failed')
    expect(error.message).toBe(
      `Model "${MODEL}" is not available in Ollama. Run "ollama pull ${MODEL}".`,
    )
  })

  it('reports not-authenticated when Ollama refuses a cloud model', async () => {
    const body = JSON.stringify({ error: 'unauthorized' })
    const { provider } = setup({ chat: [{ status: 401, body }] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('not-authenticated')
    expect(error.message).toBe(`Ollama refused the request for "${MODEL}": unauthorized`)
  })

  it('reports failed with the redacted Ollama error for any other status', async () => {
    const body = JSON.stringify({
      error: `this model is not included in your free usage ${FAKE_SECRET}`,
    })
    const { provider } = setup({ chat: [{ status: 402, body }] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('failed')
    expect(error.message).toBe(
      'Ollama returned HTTP 402: this model is not included in your free usage [REDACTED]',
    )
  })

  it('reports failed with only the status when the error body is empty', async () => {
    const { provider } = setup({ chat: [{ status: 500 }] })

    const error = await reviewError(provider)

    expect(error.message).toBe('Ollama returned HTTP 500.')
  })

  it('reports timeout and stops waiting for an Ollama that never answers', async () => {
    const { provider } = setup({ chat: ['hang'] }, { timeoutMs: 300 })

    const error = await reviewError(provider)

    expect(error.reason).toBe('timeout')
    expect(error.message).toBe('Ollama did not answer within 0.3s.')
  })

  it('reports invalid-output when Ollama answers with something that is not JSON', async () => {
    const { provider } = setup({ chat: [{ status: 200, body: `<html>${FAKE_SECRET}` }] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe('Ollama returned an unexpected response: <html>[REDACTED]')
  })

  it('reports invalid-output when the chat answer has no message', async () => {
    const { provider } = setup({ chat: [{ status: 200, body: JSON.stringify({ model: MODEL }) }] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('invalid-output')
  })

  it('reports invalid-output when Ollama read far fewer tokens than the prompt has', async () => {
    const { provider } = setup({ chat: [chat({ prompt_eval_count: 5 })] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe(
      `Ollama truncated the prompt (read 5 tokens, expected at least ${Math.ceil(PROMPT_CHARS / 6)}).`,
    )
  })

  it('reports invalid-output when the prompt and the review filled the context window', async () => {
    const { provider } = setup({ chat: [chat({ prompt_eval_count: 1024, eval_count: 8192 })] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe('Ollama ran out of context window (used 9216 of 9216 tokens).')
  })

  it('accepts a review that used less than the whole context window', async () => {
    const { provider } = setup({ chat: [chat({ prompt_eval_count: 1023, eval_count: 8192 })] })

    const output = await provider.review(PROMPT)

    expect(output.usage).toEqual({ inputTokens: 1023, outputTokens: 8192 })
  })

  it('skips the truncation check when Ollama does not report the prompt tokens', async () => {
    const { provider } = setup({
      chat: [chat({ prompt_eval_count: undefined, eval_count: undefined })],
    })

    const output = await provider.review(PROMPT)

    expect(output).not.toHaveProperty('usage')
  })

  it('reports invalid-output instead of a review cut at the output limit', async () => {
    const { provider } = setup({ chat: [chat({ done_reason: 'length' })] })

    const error = await reviewError(provider)

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe('Ollama stopped the review at the 8192-token output limit.')
  })

  it('reports invalid-output for an empty review, such as a model that only thought', async () => {
    const { provider } = setup({
      chat: [chat({ message: { role: 'assistant', content: '  ', thinking: 'hmm' } })],
    })

    const error = await reviewError(provider)

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe('Ollama returned an empty review.')
  })

  describe('with the repository tools', () => {
    function recordingToolbox(answer = 'file contents'): { toolbox: Toolbox; calls: unknown[][] } {
      const calls: unknown[][] = []
      return {
        calls,
        toolbox: {
          definitions: [
            { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
          ],
          call: async (name, args) => {
            calls.push([name, args])
            return { text: answer, isError: false }
          },
          touchedPaths: () => [],
        },
      }
    }

    function showWithTools(contextLength = 131072): FakeResponse {
      return {
        status: 200,
        body: JSON.stringify({
          capabilities: ['completion', 'tools'],
          model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': contextLength },
        }),
      }
    }

    function toolCall(name: string, args: unknown): FakeResponse {
      return chat({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name, arguments: args } }],
        },
        done_reason: 'stop',
      })
    }

    it('reviews without tools and warns when the model cannot call them', async () => {
      const { toolbox, calls: toolCalls } = recordingToolbox()
      const { provider, calls } = setup({})

      const output = await provider.review({ ...PROMPT, tools: toolbox })

      expect(output.text).toBe('LGTM from fake ollama')
      expect(output.warnings).toEqual([
        'qwen2.5-coder:7b does not support tool calling: reviewing without investigation.',
      ])
      expect(bodyOf(calls[1])).not.toHaveProperty('tools')
      expect(toolCalls).toEqual([])
    })

    it('runs the tool calls of the model and sends the answers back', async () => {
      const { toolbox, calls: toolCalls } = recordingToolbox()
      const { provider, calls } = setup({
        show: [showWithTools()],
        chat: [
          toolCall('read_file', { path: 'src/a.ts' }),
          chat({ prompt_eval_count: 90, eval_count: 30 }),
        ],
      })

      const output = await provider.review({ ...PROMPT, tools: toolbox })

      expect(output.text).toBe('LGTM from fake ollama')
      expect(toolCalls).toEqual([['read_file', { path: 'src/a.ts' }]])
      const first = bodyOf(calls[1])
      const second = bodyOf(calls[2])
      for (const body of [first, second]) {
        expect(body.tools).toEqual([
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file.',
              parameters: { type: 'object' },
            },
          },
        ])
        expect(body.format).toEqual(PROMPT.outputSchema)
      }
      expect((second.messages as unknown[]).slice(2)).toEqual([
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/a.ts' } } }],
        },
        { role: 'tool', tool_name: 'read_file', content: 'file contents' },
      ])
      expect((first.options as { num_ctx: number }).num_ctx).toBeGreaterThanOrEqual(32768 + 8192)
      expect(output.usage).toEqual({ inputTokens: 150, outputTokens: 42 })
    })

    it('accepts arguments sent as a JSON string', async () => {
      const { toolbox, calls: toolCalls } = recordingToolbox()
      const { provider } = setup({
        show: [showWithTools()],
        chat: [toolCall('read_file', '{"path":"b.ts"}'), chat()],
      })

      await provider.review({ ...PROMPT, tools: toolbox })

      expect(toolCalls).toEqual([['read_file', { path: 'b.ts' }]])
    })

    it('stops running tools before the context window fills up', async () => {
      const { toolbox, calls: toolCalls } = recordingToolbox('x'.repeat(8_600))
      const { provider, calls } = setup({
        show: [showWithTools(16_384)],
        chat: [
          toolCall('read_file', { path: 'a.ts' }),
          toolCall('read_file', { path: 'b.ts' }),
          chat({ prompt_eval_count: 60, eval_count: 12 }),
        ],
      })

      await provider.review({ ...PROMPT, tools: toolbox })

      expect(toolCalls).toEqual([['read_file', { path: 'a.ts' }]])
      expect((bodyOf(calls[3]).messages as unknown[]).at(-1)).toEqual({
        role: 'tool',
        tool_name: 'read_file',
        content: 'Context window is full: finish the review now.',
      })
    })

    it('sends a notice instead of an answer that would not fit in the window', async () => {
      const { toolbox, calls: toolCalls } = recordingToolbox('x'.repeat(20_000))
      const { provider, calls } = setup({
        show: [showWithTools(16_384)],
        chat: [toolCall('read_file', { path: 'a.ts' }), chat()],
      })

      await provider.review({ ...PROMPT, tools: toolbox })

      expect(toolCalls).toHaveLength(1)
      expect((bodyOf(calls[2]).messages as unknown[]).at(-1)).toEqual({
        role: 'tool',
        tool_name: 'read_file',
        content: 'Context window is full: finish the review now.',
      })
    })

    it('gives up when the model keeps calling tools', async () => {
      const { toolbox } = recordingToolbox()
      const { provider } = setup({
        show: [showWithTools()],
        chat: Array.from({ length: 45 }, () => toolCall('read_file', { path: 'a.ts' })),
      })

      const error = await reviewError(provider, { ...PROMPT, tools: toolbox })

      expect(error.reason).toBe('invalid-output')
      expect(error.message).toBe('Ollama kept calling tools for 45 turns without answering.')
    })
  })
})
