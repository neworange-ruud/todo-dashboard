/**
 * AI gateway client tests.
 *
 * No live network and no `getEnv()`: credentials are injected, so nothing here depends on a
 * populated `.env` and the key used in assertions is a fixture, not a secret.
 */

// lib/config imports `server-only`, which refuses to load outside a Server Component.
vi.mock('server-only', () => ({}))

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MODELS } from '../config'
import {
  AiError,
  complete,
  completeStructured,
  LOCALE_INSTRUCTION,
  toStrictJsonSchema,
} from './client'

const API_KEY = 'sk-task-desk-do-not-leak-0123456789'
const BASE_URL = 'https://gateway.example.test/v1'

function deps(fetchMock: ReturnType<typeof vi.fn>) {
  return { fetch: fetchMock as never, apiKey: API_KEY, baseUrl: BASE_URL }
}

function chat(content: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    text: async () => content,
  } as unknown as Response
}

function failure(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: '',
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call][1] as RequestInit
  return JSON.parse(init.body as string) as {
    model: string
    messages: Array<{ role: string; content: string }>
    max_completion_tokens?: number
    response_format?: {
      type: string
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> }
    }
  }
}

describe('transport', () => {
  it('posts to ${AI_API_URL}/chat/completions with the documented headers', async () => {
    const fetchMock = vi.fn(async () => chat('Today is a meeting day.'))

    const text = await complete({ system: 'Be terse.', user: 'Summarise.' }, deps(fetchMock))

    expect(text).toBe('Today is a meeting day.')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gateway.example.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    })
  })

  it('defaults to the configured model and omits token caps unless asked', async () => {
    const fetchMock = vi.fn(async () => chat('ok'))

    await complete({ system: 's', user: 'u' }, deps(fetchMock))
    expect(bodyOf(fetchMock).model).toBe(MODELS.synthesis)
    expect(bodyOf(fetchMock).max_completion_tokens).toBeUndefined()

    await complete({ system: 's', user: 'u', model: MODELS.sentence, maxTokens: 120 }, deps(fetchMock))
    expect(bodyOf(fetchMock, 1).model).toBe(MODELS.sentence)
    expect(bodyOf(fetchMock, 1).max_completion_tokens).toBe(120)
  })
})

describe('locale enforcement', () => {
  it('names the output language', () => {
    expect(LOCALE_INSTRUCTION).toMatch(/English/)
  })

  it('prepends the instruction to every system prompt — free text', async () => {
    const fetchMock = vi.fn(async () => chat('ok'))

    await complete({ system: 'Write the daily sentence.', user: 'today' }, deps(fetchMock))

    const [system, user] = bodyOf(fetchMock).messages
    expect(system.role).toBe('system')
    expect(system.content).toContain(LOCALE_INSTRUCTION)
    expect(system.content).toContain('Write the daily sentence.')
    expect(user).toEqual({ role: 'user', content: 'today' })
  })

  it('prepends the instruction to every system prompt — structured', async () => {
    const fetchMock = vi.fn(async () => chat(JSON.stringify({ text: 'hi' })))

    await completeStructured(
      {
        system: 'Extract entities.',
        user: 'today',
        schema: z.object({ text: z.string() }),
        schemaName: 'sentence',
      },
      deps(fetchMock),
    )

    expect(bodyOf(fetchMock).messages[0].content).toContain(LOCALE_INSTRUCTION)
  })
})

describe('structured output', () => {
  const schema = z.object({
    text: z.string(),
    entities: z.array(z.object({ text: z.string(), ref: z.string() })),
  })

  it('sends a strict json_schema response format', async () => {
    const fetchMock = vi.fn(async () => chat(JSON.stringify({ text: 'a', entities: [] })))

    await completeStructured(
      { system: 's', user: 'u', schema, schemaName: 'daily sentence!' },
      deps(fetchMock),
    )

    const format = bodyOf(fetchMock).response_format!
    expect(format.type).toBe('json_schema')
    expect(format.json_schema.strict).toBe(true)
    // The name is sanitised to ^[A-Za-z0-9_-]+$.
    expect(format.json_schema.name).toBe('daily_sentence_')
    expect(format.json_schema.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['text', 'entities'],
    })
    expect(format.json_schema.schema.$schema).toBeUndefined()
  })

  it('parses and validates the JSON in message.content', async () => {
    const payload = { text: 'Today is a meeting day.', entities: [{ text: 'RW-214', ref: 'RW-214' }] }
    const fetchMock = vi.fn(async () => chat(JSON.stringify(payload)))

    const result = await completeStructured(
      { system: 's', user: 'u', schema, schemaName: 'sentence' },
      deps(fetchMock),
    )

    expect(result).toEqual(payload)
  })

  it('rejects a response that does not match the schema', async () => {
    const fetchMock = vi.fn(async () => chat(JSON.stringify({ text: 42 })))

    await expect(
      completeStructured({ system: 's', user: 'u', schema, schemaName: 'sentence' }, deps(fetchMock)),
    ).rejects.toThrow(/did not match schema/)
  })

  it('rejects content that is not JSON at all', async () => {
    const fetchMock = vi.fn(async () => chat('Sorry, I cannot do that.'))

    await expect(
      completeStructured({ system: 's', user: 'u', schema, schemaName: 'sentence' }, deps(fetchMock)),
    ).rejects.toThrow(/invalid JSON/)
  })

  it('accepts a raw JSON Schema and returns it unvalidated', async () => {
    const fetchMock = vi.fn(async () => chat(JSON.stringify({ verdict: 'heavy' })))

    const result = await completeStructured<{ verdict: string }>(
      {
        system: 's',
        user: 'u',
        schema: { type: 'object', properties: { verdict: { type: 'string' } } },
        schemaName: 'verdict',
      },
      deps(fetchMock),
    )

    expect(result).toEqual({ verdict: 'heavy' })
    expect(bodyOf(fetchMock).response_format!.json_schema.schema).toEqual({
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    })
  })

  it('hardens nested objects and arrays', () => {
    expect(
      toStrictJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          entities: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' } } },
          },
        },
        required: [],
      }),
    ).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['entities'],
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: { text: { type: 'string' } },
          },
        },
      },
    })
  })
})

describe('retries', () => {
  it('retries once on a 5xx and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(503, 'upstream unavailable'))
      .mockResolvedValueOnce(chat('recovered'))

    await expect(complete({ system: 's', user: 'u' }, deps(fetchMock))).resolves.toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after exactly one retry', async () => {
    const fetchMock = vi.fn(async () => failure(500, 'boom'))

    await expect(complete({ system: 's', user: 'u' }, deps(fetchMock))).rejects.toThrow(/500/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries once on a network fault', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(chat('recovered'))

    await expect(complete({ system: 's', user: 'u' }, deps(fetchMock))).resolves.toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never retries a 4xx', async () => {
    const fetchMock = vi.fn(async () => failure(400, 'bad request'))

    await expect(complete({ system: 's', user: 'u' }, deps(fetchMock))).rejects.toThrow(AiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('credential hygiene', () => {
  it('never lets the API key reach a thrown error, even when the gateway echoes it', async () => {
    // Gateways do this: the 4xx body repeats the token it rejected.
    const fetchMock = vi.fn(async () =>
      failure(401, `{"error":{"message":"Incorrect API key provided: ${API_KEY}"}}`),
    )

    let thrown: unknown
    try {
      await complete({ system: 's', user: 'u' }, deps(fetchMock))
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(AiError)
    const error = thrown as AiError
    expect(error.message).not.toContain(API_KEY)
    expect(error.message).toContain('«redacted»')
    expect(String(error)).not.toContain(API_KEY)
    expect(error.stack ?? '').not.toContain(API_KEY)
  })

  it('keeps the key out of structured-output errors too', async () => {
    const fetchMock = vi.fn(async () => chat(`not json, key was ${API_KEY}`))

    let thrown: unknown
    try {
      await completeStructured(
        { system: 's', user: 'u', schema: z.object({ a: z.string() }), schemaName: 'a' },
        deps(fetchMock),
      )
    } catch (err) {
      thrown = err
    }

    expect((thrown as Error).message).not.toContain(API_KEY)
  })

  it('does not put the key in the error when the gateway sends no content', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ choices: [] }),
        }) as unknown as Response,
    )

    await expect(complete({ system: 's', user: 'u' }, deps(fetchMock))).rejects.toThrow(
      /no message content/,
    )
  })
})
