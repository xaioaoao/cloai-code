import {
  GEMINI_CODE_ASSIST_ENDPOINT,
  GEMINI_OAUTH_API_CLIENT,
  GEMINI_OAUTH_AUTHORIZE_URL,
  GEMINI_OAUTH_CALLBACK_PATH,
  GEMINI_OAUTH_CALLBACK_PORT,
  GEMINI_OAUTH_CLIENT_ID_ENV_VAR,
  GEMINI_OAUTH_CLIENT_SECRET_ENV_VAR,
  GEMINI_OAUTH_REDIRECT_URL,
  GEMINI_OAUTH_SCOPES,
  GEMINI_OAUTH_TOKEN_URL,
  GEMINI_OAUTH_USER_AGENT,
} from '../../constants/geminiOAuth.js'
import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from './auth-code-listener.js'
import * as crypto from './crypto.js'
import type { OAuthTokens } from './types.js'

type GeminiOAuthTokens = OAuthTokens & {
  projectId?: string
  email?: string
}

type LoadCodeAssistPayload = {
  cloudaicompanionProject?: string
  currentTier?: { id?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
}

type LongRunningOperationResponse = {
  name?: string
  done?: boolean
  response?: {
    cloudaicompanionProject?: { id?: string }
  }
}

type GoogleRpcErrorResponse = {
  error?: {
    details?: Array<{ reason?: string }>
  }
}

const TIER_FREE = 'free-tier'
const TIER_LEGACY = 'legacy-tier'

function getGeminiOAuthClientId(): string | undefined {
  const clientId = process.env[GEMINI_OAUTH_CLIENT_ID_ENV_VAR]?.trim()
  return clientId || undefined
}

function requireGeminiOAuthClientId(): string {
  const clientId = getGeminiOAuthClientId()
  if (!clientId) {
    throw new Error(
      `Gemini OAuth requires ${GEMINI_OAUTH_CLIENT_ID_ENV_VAR} to be set.`,
    )
  }
  return clientId
}

function getGeminiOAuthClientSecret(): string | undefined {
  const secret = process.env[GEMINI_OAUTH_CLIENT_SECRET_ENV_VAR]?.trim()
  return secret || undefined
}

function buildGeminiTokenParams(
  params: Record<string, string>,
): URLSearchParams {
  const searchParams = new URLSearchParams(params)
  const clientSecret = getGeminiOAuthClientSecret()
  if (clientSecret) {
    searchParams.set('client_secret', clientSecret)
  }
  return searchParams
}

async function getTokenErrorMessage(response: Response): Promise<string> {
  const body = await response.text()

  try {
    const parsed = JSON.parse(body) as {
      error?: string
      error_description?: string
    }
    if (
      parsed.error === 'invalid_request' &&
      parsed.error_description?.toLowerCase().includes('client_secret is missing')
    ) {
      return `Token exchange failed: Google OAuth client requires a client secret. Set ${GEMINI_OAUTH_CLIENT_SECRET_ENV_VAR}.`
    }
  } catch {}

  return `Token exchange failed: ${body}`
}

export async function refreshGeminiCliTokens(input: {
  refreshToken: string
  projectId: string
}): Promise<GeminiOAuthTokens> {
  const clientId = requireGeminiOAuthClientId()
  const response = await fetch(GEMINI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildGeminiTokenParams({
      client_id: clientId,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    throw new Error(`Google Cloud token refresh failed: ${await getTokenErrorMessage(response)}`)
  }

  const data = (await response.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || input.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId: input.projectId,
  }
}

function parseManualOAuthInput(value: string): {
  authorizationCode?: string
  state?: string
} {
  const trimmed = value.trim()
  if (!trimmed) return {}

  try {
    const url = new URL(trimmed)
    return {
      authorizationCode: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    const [authorizationCode, state] = trimmed.split('#')
    return { authorizationCode, state }
  }
}

function getGeminiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': GEMINI_OAUTH_USER_AGENT,
    'X-Goog-Api-Client': GEMINI_OAUTH_API_CLIENT,
  }
}

function isVpcScAffectedUser(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return false
  const error = (payload as GoogleRpcErrorResponse).error
  if (!error?.details || !Array.isArray(error.details)) return false
  return error.details.some(detail => detail.reason === 'SECURITY_POLICY_VIOLATED')
}

function getDefaultTier(
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>,
): { id?: string } {
  if (!allowedTiers || allowedTiers.length === 0) return { id: TIER_LEGACY }
  return allowedTiers.find(tier => tier.isDefault) ?? { id: TIER_LEGACY }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pollOperation(
  operationName: string,
  headers: Record<string, string>,
): Promise<LongRunningOperationResponse> {
  let attempt = 0
  while (true) {
    if (attempt > 0) {
      await wait(5000)
    }

    const response = await fetch(
      `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`,
      {
        method: 'GET',
        headers,
      },
    )

    if (!response.ok) {
      throw new Error(
        `Failed to poll operation: ${response.status} ${response.statusText}`,
      )
    }

    const data = (await response.json()) as LongRunningOperationResponse
    if (data.done) return data
    attempt += 1
  }
}

async function discoverProject(accessToken: string): Promise<string> {
  const envProjectId =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID
  const headers = getGeminiHeaders(accessToken)

  const loadResponse = await fetch(
    `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cloudaicompanionProject: envProjectId,
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
          duetProject: envProjectId,
        },
      }),
    },
  )

  let data: LoadCodeAssistPayload
  if (!loadResponse.ok) {
    let errorPayload: unknown
    try {
      errorPayload = await loadResponse.clone().json()
    } catch {
      errorPayload = undefined
    }

    if (isVpcScAffectedUser(errorPayload)) {
      data = { currentTier: { id: 'standard-tier' } }
    } else {
      throw new Error(
        `loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${await loadResponse.text()}`,
      )
    }
  } else {
    data = (await loadResponse.json()) as LoadCodeAssistPayload
  }

  if (data.currentTier) {
    if (data.cloudaicompanionProject) return data.cloudaicompanionProject
    if (envProjectId) return envProjectId
    throw new Error(
      'This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
    )
  }

  const tierId = getDefaultTier(data.allowedTiers).id ?? TIER_FREE
  if (tierId !== TIER_FREE && !envProjectId) {
    throw new Error(
      'This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
    )
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  }

  if (tierId !== TIER_FREE && envProjectId) {
    onboardBody.cloudaicompanionProject = envProjectId
    ;(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId
  }

  const onboardResponse = await fetch(
    `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(onboardBody),
    },
  )

  if (!onboardResponse.ok) {
    throw new Error(
      `onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${await onboardResponse.text()}`,
    )
  }

  let operation = (await onboardResponse.json()) as LongRunningOperationResponse
  if (!operation.done && operation.name) {
    operation = await pollOperation(operation.name, headers)
  }

  const projectId = operation.response?.cloudaicompanionProject?.id
  if (projectId) return projectId
  if (envProjectId) return envProjectId
  throw new Error(
    'Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
  )
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(
      'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    )
    if (!response.ok) return undefined
    const data = (await response.json()) as { email?: string }
    return data.email
  } catch {
    return undefined
  }
}

export class GeminiOAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null

  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
  ): Promise<GeminiOAuthTokens> {
    const clientId = requireGeminiOAuthClientId()
    this.authCodeListener = new AuthCodeListener(GEMINI_OAUTH_CALLBACK_PATH)
    await this.authCodeListener.start(GEMINI_OAUTH_CALLBACK_PORT)

    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    const state = crypto.generateState()
    const authUrl = new URL(GEMINI_OAUTH_AUTHORIZE_URL)
    authUrl.searchParams.append('client_id', clientId)
    authUrl.searchParams.append('response_type', 'code')
    authUrl.searchParams.append('redirect_uri', GEMINI_OAUTH_REDIRECT_URL)
    authUrl.searchParams.append('scope', GEMINI_OAUTH_SCOPES.join(' '))
    authUrl.searchParams.append('code_challenge', codeChallenge)
    authUrl.searchParams.append('code_challenge_method', 'S256')
    authUrl.searchParams.append('state', state)
    authUrl.searchParams.append('access_type', 'offline')
    authUrl.searchParams.append('prompt', 'consent')

    const authorizationCode = await this.waitForAuthorizationCode(state, async () => {
      await authURLHandler(authUrl.toString())
      await openBrowser(authUrl.toString())
    })

    const isAutomaticFlow = this.authCodeListener?.hasPendingResponse() ?? false

    try {
      const tokenResponse = await fetch(GEMINI_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildGeminiTokenParams({
          client_id: clientId,
          code: authorizationCode,
          grant_type: 'authorization_code',
          redirect_uri: GEMINI_OAUTH_REDIRECT_URL,
          code_verifier: this.codeVerifier,
        }),
      })

      if (!tokenResponse.ok) {
        throw new Error(await getTokenErrorMessage(tokenResponse))
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
      }

      if (!tokenData.refresh_token) {
        throw new Error('No refresh token received. Please try again.')
      }

      const [email, projectId] = await Promise.all([
        getUserEmail(tokenData.access_token),
        discoverProject(tokenData.access_token),
      ])

      if (isAutomaticFlow) {
        this.authCodeListener?.handleSuccessRedirect([], res => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
          })
          res.end('Google authentication completed. You can close this window.')
        })
      }

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
        projectId,
        email,
      }
    } catch (error) {
      if (isAutomaticFlow) {
        this.authCodeListener?.handleSuccessRedirect([], res => {
          res.writeHead(500, {
            'Content-Type': 'text/html; charset=utf-8',
          })
          res.end('Google authentication failed. Return to the terminal for details.')
        })
      }
      throw error
    } finally {
      this.authCodeListener?.close()
    }
  }

  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.manualAuthCodeResolver = resolve
      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then(authorizationCode => {
          this.manualAuthCodeResolver = null
          resolve(authorizationCode)
        })
        .catch(error => {
          this.manualAuthCodeResolver = null
          reject(error)
        })
    })
  }

  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
      this.authCodeListener?.close()
    }
  }

  parseManualOAuthInput(value: string): {
    authorizationCode?: string
    state?: string
  } {
    return parseManualOAuthInput(value)
  }

  cleanup(): void {
    this.authCodeListener?.close()
    this.manualAuthCodeResolver = null
  }
}
