import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  getActiveProviderConfig,
  readCustomApiStorage,
  writeCustomApiStorage,
  type ProviderConfig,
} from '../../utils/customApiStorage.js'
import { refreshGeminiCliTokens } from '../oauth/geminiCli.js'

const GEMINI_CLI_HEADERS = {
  'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata': JSON.stringify({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  }),
} as const

const GEMINI_CLI_ENDPOINT_FALLBACKS = [
  'https://cloudcode-pa.googleapis.com',
] as const

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const MAX_EMPTY_STREAM_RETRIES = 2
const EMPTY_STREAM_BASE_DELAY_MS = 500

type AnyBlock = Record<string, unknown>

type GeminiToolChoice = 'AUTO' | 'NONE' | 'ANY'

type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: {
    mimeType: string
    data: string
  }
  functionCall?: {
    name?: string
    args?: Record<string, unknown>
    id?: string
  }
  functionResponse?: {
    name?: string
    response?: Record<string, unknown>
    id?: string
  }
}

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiGenerateContentRequest = {
  contents: GeminiContent[]
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
  }
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description?: string
      parameters?: unknown
      parametersJsonSchema?: unknown
    }>
  }>
  toolConfig?: {
    functionCallingConfig: {
      mode: GeminiToolChoice
    }
  }
}

type GeminiCliRequest = {
  project: string
  model: string
  request: GeminiGenerateContentRequest
  userAgent: string
  requestId: string
}

type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
}

type GeminiCandidate = {
  content?: {
    parts?: GeminiPart[]
  }
  finishReason?: string
}

type GeminiChunk = {
  responseId?: string
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
}

type GeminiCliChunkEnvelope = {
  response?: GeminiChunk
}

function toBlocks(content: BetaMessageParam['content']): AnyBlock[] {
  return Array.isArray(content)
    ? (content as unknown as AnyBlock[])
    : [{ type: 'text', text: content }]
}

function mapAnthropicUserBlocksToGeminiParts(blocks: AnyBlock[]): GeminiPart[] {
  return blocks.flatMap(block => {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return [{ text: sanitizeText(block.text) }]
    }
    if (
      block.type === 'image' &&
      block.source &&
      typeof block.source === 'object' &&
      (block.source as Record<string, unknown>).type === 'base64' &&
      typeof (block.source as Record<string, unknown>).media_type === 'string' &&
      typeof (block.source as Record<string, unknown>).data === 'string'
    ) {
      return [{
        inlineData: {
          mimeType: String((block.source as Record<string, unknown>).media_type),
          data: String((block.source as Record<string, unknown>).data),
        },
      }]
    }
    return []
  })
}

function sanitizeText(text: string): string {
  return text
}

function normalizeModel(model: string): string {
  const configuredModel = process.env.ANTHROPIC_MODEL?.trim()
  return configuredModel || model
}

function requiresLegacyParameters(model: string): boolean {
  return model.startsWith('claude-')
}

function convertTools(
  tools?: BetaToolUnion[],
  useParameters = false,
): GeminiGenerateContentRequest['tools'] {
  if (!tools || tools.length === 0) return undefined
  const functionDeclarations = tools.flatMap(tool => {
    const record = tool as unknown as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : undefined
    if (!name) return []
    return [{
      name,
      description:
        typeof record.description === 'string' ? record.description : undefined,
      ...(useParameters
        ? { parameters: record.input_schema }
        : { parametersJsonSchema: record.input_schema }),
    }]
  })
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
}

function mapToolChoice(
  toolChoice?: BetaToolChoiceAuto | BetaToolChoiceTool,
): GeminiToolChoice | undefined {
  if (!toolChoice) return undefined
  if (toolChoice.type === 'auto') return 'AUTO'
  if (toolChoice.type === 'tool') return 'ANY'
  return undefined
}

export function convertAnthropicRequestToGemini(input: {
  model: string
  system?: string | Array<{ type?: string; text?: string }>
  messages: BetaMessageParam[]
  tools?: BetaToolUnion[]
  tool_choice?: BetaToolChoiceAuto | BetaToolChoiceTool
  temperature?: number
  max_tokens?: number
}): GeminiGenerateContentRequest {
  const targetModel = normalizeModel(input.model)
  const contents: GeminiContent[] = []

  for (const message of input.messages) {
    if (message.role === 'user') {
      const blocks = toBlocks(message.content)
      const toolParts = blocks
        .filter(block => block.type === 'tool_result')
        .map(block => ({
          functionResponse: {
            name: typeof block.tool_name === 'string' ? block.tool_name : 'tool',
            id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
            response:
              block.is_error === true
                ? {
                    error:
                      typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content),
                  }
                : {
                    output:
                      typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content),
                  },
          },
        }))

      const userParts = mapAnthropicUserBlocksToGeminiParts(
        blocks.filter(block => block.type !== 'tool_result') as AnyBlock[],
      )
      const parts = [...toolParts, ...userParts]
      if (parts.length > 0) {
        contents.push({ role: 'user', parts })
      }
      continue
    }

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content)
        ? (message.content as unknown as AnyBlock[])
        : []
      const parts: GeminiPart[] = []

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          parts.push({ text: sanitizeText(block.text) })
        }
        if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking
        ) {
          parts.push({
            text: sanitizeText(block.thinking),
            thought: true,
            thoughtSignature:
              typeof block.signature === 'string' ? block.signature : undefined,
          })
        }
        if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: typeof block.name === 'string' ? block.name : '',
              args:
                typeof block.input === 'object' && block.input !== null
                  ? (block.input as Record<string, unknown>)
                  : {},
              id: typeof block.id === 'string' ? block.id : undefined,
            },
          })
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'model', parts })
      }
    }
  }

  const systemText = Array.isArray(input.system)
    ? input.system.map(block => block.text ?? '').join('\n')
    : input.system

  const tools = convertTools(input.tools, requiresLegacyParameters(targetModel))
  const toolChoice = mapToolChoice(input.tool_choice)

  return {
    contents,
    ...(systemText
      ? { systemInstruction: { parts: [{ text: sanitizeText(systemText) }] } }
      : {}),
    ...((input.temperature !== undefined || input.max_tokens !== undefined)
      ? {
          generationConfig: {
            ...(input.temperature !== undefined
              ? { temperature: input.temperature }
              : {}),
            ...(input.max_tokens !== undefined
              ? { maxOutputTokens: input.max_tokens }
              : {}),
          },
        }
      : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice
      ? {
          toolConfig: {
            functionCallingConfig: {
              mode: toolChoice,
            },
          },
        }
      : {}),
  }
}

function parseSSEChunk(buffer: string): { events: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const remainder = parts.pop() ?? ''
  return { events: parts, remainder }
}

function mapFinishReason(reason: string | undefined): BetaMessage['stop_reason'] {
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  return 'end_turn'
}

function joinBaseUrl(baseURL: string, path: string): string {
  const normalizedBaseURL = baseURL.trim().replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  try {
    return new URL(normalizedPath, `${normalizedBaseURL}/`).toString()
  } catch {
    throw new Error(`Invalid Gemini-compatible base URL: ${normalizedBaseURL}`)
  }
}

function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined {
  const headers = response instanceof Headers ? response : response?.headers
  const retryAfter = headers?.get('retry-after')
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter)
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.ceil(retryAfterSeconds * 1000 + 1000)
    }
  }
  const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i)
  if (retryDelayMatch?.[1]) {
    const value = parseFloat(retryDelayMatch[1])
    if (!Number.isNaN(value) && value > 0) {
      return Math.ceil((retryDelayMatch[2] === 'ms' ? value : value * 1000) + 1000)
    }
  }
  return undefined
}

function isRetryableError(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true
  }
  return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was aborted'))
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(new Error('Request was aborted'))
    })
  })
}

export async function createGeminiVertexStream(input: {
  apiKey: string
  baseURL: string
  model: string
  request: GeminiGenerateContentRequest
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await (input.fetch ?? globalThis.fetch)(
    joinBaseUrl(
      input.baseURL,
      `/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`,
    ),
    {
      method: 'POST',
      signal: input.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': input.apiKey,
        accept: 'text/event-stream',
        ...input.headers,
      },
      body: JSON.stringify(input.request),
    },
  )

  if (!response.ok || !response.body) {
    let responseText = ''
    try {
      responseText = await response.text()
    } catch {
      responseText = ''
    }
    throw new Error(
      `Gemini Vertex-compatible request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`,
    )
  }

  return response.body.getReader()
}

function getActiveGeminiProvider(): ProviderConfig | undefined {
  const storage = readCustomApiStorage()
  const provider = getActiveProviderConfig(storage)
  return provider?.kind === 'gemini-like' ? provider : undefined
}

export async function refreshGeminiProviderOAuthIfNeeded(): Promise<ProviderConfig> {
  const storage = readCustomApiStorage()
  const provider = getActiveGeminiProvider()
  if (!provider || provider.authMode !== 'gemini-cli-oauth') {
    throw new Error('Active Gemini OAuth provider not found')
  }
  const oauth = provider.oauth
  if (!oauth?.accessToken || !oauth.projectId) {
    throw new Error('Gemini OAuth provider is missing access token or project ID')
  }
  if (!oauth.expiresAt || oauth.expiresAt > Date.now()) {
    return provider
  }
  if (!oauth.refreshToken) {
    throw new Error('Gemini OAuth provider is missing refresh token')
  }

  const refreshed = await refreshGeminiCliTokens({
    refreshToken: oauth.refreshToken,
    projectId: oauth.projectId,
  })

  const providers = (storage.providers ?? []).map(item =>
    item.kind === provider.kind &&
    item.id === provider.id &&
    item.authMode === provider.authMode
      ? {
          ...item,
          oauth: {
            ...item.oauth,
            accessToken:
              typeof refreshed.accessToken === 'string'
                ? refreshed.accessToken
                : item.oauth?.accessToken,
            refreshToken:
              typeof refreshed.refreshToken === 'string'
                ? refreshed.refreshToken
                : item.oauth?.refreshToken,
            expiresAt:
              typeof refreshed.expiresAt === 'number'
                ? refreshed.expiresAt
                : item.oauth?.expiresAt,
            projectId:
              typeof refreshed.projectId === 'string'
                ? refreshed.projectId
                : item.oauth?.projectId,
          },
        }
      : item,
  )

  writeCustomApiStorage({
    ...storage,
    providers,
  })

  const nextProvider = providers.find(item =>
    item.kind === provider.kind &&
    item.id === provider.id &&
    item.authMode === provider.authMode,
  )
  if (!nextProvider) {
    throw new Error('Failed to persist refreshed Gemini OAuth tokens')
  }
  return nextProvider
}

export async function createGeminiCliStream(input: {
  provider: ProviderConfig
  model: string
  request: GeminiGenerateContentRequest
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const oauth = input.provider.oauth
  if (!oauth?.accessToken || !oauth.projectId) {
    throw new Error('Gemini CLI OAuth provider is missing access token or project ID')
  }

  const requestBody: GeminiCliRequest = {
    project: oauth.projectId,
    model: input.model,
    request: input.request,
    userAgent: 'pi-coding-agent',
    requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
  }
  const body = JSON.stringify(requestBody)
  const endpoints = input.provider.baseURL?.trim()
    ? [input.provider.baseURL.trim()]
    : [...GEMINI_CLI_ENDPOINT_FALLBACKS]

  let response: Response | undefined
  let endpointIndex = 0
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (input.signal?.aborted) {
      throw new Error('Request was aborted')
    }
    try {
      const endpoint = endpoints[endpointIndex]!
      response = await (input.fetch ?? globalThis.fetch)(
        `${endpoint.replace(/\/+$/, '')}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          signal: input.signal,
          headers: {
            Authorization: `Bearer ${oauth.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...GEMINI_CLI_HEADERS,
            ...input.headers,
          },
          body,
        },
      )

      if (response.ok && response.body) {
        return response.body.getReader()
      }

      const errorText = await response.text()
      if ((response.status === 403 || response.status === 404) && endpointIndex < endpoints.length - 1) {
        endpointIndex += 1
        continue
      }
      if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
        const delayMs = extractRetryDelay(errorText, response) ?? BASE_DELAY_MS * 2 ** attempt
        await sleep(delayMs, input.signal)
        continue
      }
      throw new Error(
        `Gemini CLI request failed with status ${response.status}${errorText ? `: ${errorText}` : ''}`,
      )
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError' || error.message === 'Request was aborted') {
          throw new Error('Request was aborted')
        }
        lastError = error
      } else {
        lastError = new Error(String(error))
      }
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt, input.signal)
        continue
      }
      throw lastError
    }
  }

  throw lastError ?? new Error('Failed to get Gemini CLI response')
}

function unwrapGeminiChunk(raw: unknown): GeminiChunk | null {
  if (!raw || typeof raw !== 'object') return null
  const envelope = raw as GeminiCliChunkEnvelope & GeminiChunk
  if (envelope.response && typeof envelope.response === 'object') {
    return envelope.response
  }
  return envelope as GeminiChunk
}

function mapGeminiUsage(usage?: GeminiUsageMetadata) {
  return {
    input_tokens: (usage?.promptTokenCount ?? 0) - (usage?.cachedContentTokenCount ?? 0),
    output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage?.cachedContentTokenCount ?? 0,
  }
}

export async function* createAnthropicStreamFromGemini(input: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  model: string
}): AsyncGenerator<BetaRawMessageStreamEvent, BetaMessage, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let started = false
  let promptTokens = 0
  let completionTokens = 0
  let stopReason: BetaMessage['stop_reason'] = 'end_turn'
  let responseId = 'gemini-compat'
  let nextContentIndex = 0
  let currentTextIndex: number | null = null
  let currentThinkingIndex: number | null = null
  const openContentIndices: number[] = []
  const toolIndices = new Set<number>()
  let empty = true

  function allocateContentIndex(): number {
    return nextContentIndex++
  }

  function markOpen(index: number) {
    openContentIndices.push(index)
  }

  while (true) {
    const { done, value } = await input.reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseSSEChunk(buffer)
    buffer = parsed.remainder

    for (const rawEvent of parsed.events) {
      const dataLines = rawEvent
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue
        const chunk = unwrapGeminiChunk(JSON.parse(data))
        if (!chunk) continue

        if (!started) {
          started = true
          yield {
            type: 'message_start',
            message: {
              id: responseId,
              type: 'message',
              role: 'assistant',
              model: input.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
              },
            },
          } as BetaRawMessageStreamEvent
        }

        if (chunk.responseId) {
          responseId = chunk.responseId
        }

        const candidate = chunk.candidates?.[0]
        const parts = candidate?.content?.parts ?? []
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            empty = false
            const isThinking = part.thought === true
            if (isThinking) {
              if (currentTextIndex !== null) {
                yield { type: 'content_block_stop', index: currentTextIndex } as BetaRawMessageStreamEvent
                currentTextIndex = null
              }
              if (currentThinkingIndex === null) {
                currentThinkingIndex = allocateContentIndex()
                markOpen(currentThinkingIndex)
                yield {
                  type: 'content_block_start',
                  index: currentThinkingIndex,
                  content_block: {
                    type: 'thinking',
                    thinking: '',
                    signature: part.thoughtSignature ?? '',
                  },
                } as BetaRawMessageStreamEvent
              }
              yield {
                type: 'content_block_delta',
                index: currentThinkingIndex,
                delta: {
                  type: 'thinking_delta',
                  thinking: part.text,
                },
              } as BetaRawMessageStreamEvent
              if (part.thoughtSignature) {
                yield {
                  type: 'content_block_delta',
                  index: currentThinkingIndex,
                  delta: {
                    type: 'signature_delta',
                    signature: part.thoughtSignature,
                  },
                } as BetaRawMessageStreamEvent
              }
            } else {
              if (currentThinkingIndex !== null) {
                yield { type: 'content_block_stop', index: currentThinkingIndex } as BetaRawMessageStreamEvent
                currentThinkingIndex = null
              }
              if (currentTextIndex === null) {
                currentTextIndex = allocateContentIndex()
                markOpen(currentTextIndex)
                yield {
                  type: 'content_block_start',
                  index: currentTextIndex,
                  content_block: {
                    type: 'text',
                    text: '',
                  },
                } as BetaRawMessageStreamEvent
              }
              yield {
                type: 'content_block_delta',
                index: currentTextIndex,
                delta: {
                  type: 'text_delta',
                  text: part.text,
                },
              } as BetaRawMessageStreamEvent
            }
          }

          if (part.functionCall) {
            empty = false
            if (currentTextIndex !== null) {
              yield { type: 'content_block_stop', index: currentTextIndex } as BetaRawMessageStreamEvent
              currentTextIndex = null
            }
            if (currentThinkingIndex !== null) {
              yield { type: 'content_block_stop', index: currentThinkingIndex } as BetaRawMessageStreamEvent
              currentThinkingIndex = null
            }
            const toolIndex = allocateContentIndex()
            toolIndices.add(toolIndex)
            markOpen(toolIndex)
            yield {
              type: 'content_block_start',
              index: toolIndex,
              content_block: {
                type: 'tool_use',
                id:
                  part.functionCall.id ??
                  `toolu_${part.functionCall.name ?? 'gemini'}_${toolIndex}`,
                name: part.functionCall.name ?? '',
                input: '',
              },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_delta',
              index: toolIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(part.functionCall.args ?? {}),
              },
            } as BetaRawMessageStreamEvent
            stopReason = 'tool_use'
          }
        }

        if (chunk.usageMetadata) {
          promptTokens = mapGeminiUsage(chunk.usageMetadata).input_tokens
          completionTokens = mapGeminiUsage(chunk.usageMetadata).output_tokens
        }

        if (candidate?.finishReason && stopReason !== 'tool_use') {
          stopReason = mapFinishReason(candidate.finishReason)
        }
      }
    }
  }

  if (!started) {
    yield {
      type: 'message_start',
      message: {
        id: responseId,
        type: 'message',
        role: 'assistant',
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    } as BetaRawMessageStreamEvent
  }

  if (empty) {
    throw new Error('Gemini-compatible API returned an empty response')
  }

  for (const index of openContentIndices) {
    yield {
      type: 'content_block_stop',
      index,
    } as BetaRawMessageStreamEvent
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: completionTokens,
    },
  } as BetaRawMessageStreamEvent

  yield {
    type: 'message_stop',
  } as BetaRawMessageStreamEvent

  return {
    id: responseId,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content: [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
    },
  } as BetaMessage
}

export async function createGeminiCliStreamWithEmptyRetry(input: {
  provider: ProviderConfig
  model: string
  request: GeminiGenerateContentRequest
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= MAX_EMPTY_STREAM_RETRIES; attempt++) {
    try {
      return await createGeminiCliStream(input)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < MAX_EMPTY_STREAM_RETRIES) {
        await sleep(EMPTY_STREAM_BASE_DELAY_MS * 2 ** attempt, input.signal)
      }
    }
  }
  throw lastError ?? new Error('Failed to create Gemini CLI stream')
}
