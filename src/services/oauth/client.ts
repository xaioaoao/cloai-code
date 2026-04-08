// OAuth client for handling authentication flows with Claude services
import axios from 'axios'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  getOauthConfig,
  OPENAI_AUTHORIZE_URL,
  OPENAI_CLIENT_ID,
  OPENAI_ORIGINATOR,
  OPENAI_REDIRECT_URL,
  OPENAI_SCOPES,
  OPENAI_TOKEN_URL,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
  saveApiKey,
} from '../../utils/auth.js'
import type { AccountInfo } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
  UserRolesResponse,
} from './types.js'

/**
 * Check if the user has Claude.ai authentication scope
 * @private Only call this if you're OAuth / auth related code!
 */
export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return Boolean(scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE))
}

export function parseScopes(scopeString?: string): string[] {
  return scopeString?.split(' ').filter(Boolean) ?? []
}

export function buildAuthUrl({
  codeChallenge,
  state,
  port,
  isManual,
  loginWithClaudeAi,
  inferenceOnly,
  orgUUID,
  loginHint,
  loginMethod,
  oauthProvider,
  openaiClientId,
}: {
  codeChallenge: string
  state: string
  port: number
  isManual: boolean
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
  oauthProvider?: 'anthropic' | 'openai'
  openaiClientId?: string
}): string {
  // Handle official OpenAI ChatGPT OAuth separately
  if (oauthProvider === 'openai') {
    const clientId = openaiClientId ?? OPENAI_CLIENT_ID
    const authUrl = new URL(OPENAI_AUTHORIZE_URL)
    authUrl.searchParams.append('response_type', 'code')
    authUrl.searchParams.append('client_id', clientId)
    authUrl.searchParams.append('redirect_uri', OPENAI_REDIRECT_URL)
    authUrl.searchParams.append('scope', OPENAI_SCOPES)
    authUrl.searchParams.append('code_challenge', codeChallenge)
    authUrl.searchParams.append('code_challenge_method', 'S256')
    authUrl.searchParams.append('state', state)
    authUrl.searchParams.append('id_token_add_organizations', 'true')
    authUrl.searchParams.append('codex_cli_simplified_flow', 'true')
    authUrl.searchParams.append('originator', OPENAI_ORIGINATOR)
    return authUrl.toString()
  }

  // Anthropic OAuth flow
  const authUrlBase = loginWithClaudeAi
    ? getOauthConfig().CLAUDE_AI_AUTHORIZE_URL
    : getOauthConfig().CONSOLE_AUTHORIZE_URL

  const authUrl = new URL(authUrlBase)
  authUrl.searchParams.append('code', 'true')
  authUrl.searchParams.append('client_id', getOauthConfig().CLIENT_ID)
  authUrl.searchParams.append('response_type', 'code')
  authUrl.searchParams.append(
    'redirect_uri',
    isManual
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
  )
  const scopesToUse = inferenceOnly
    ? [CLAUDE_AI_INFERENCE_SCOPE]
    : ALL_OAUTH_SCOPES
  authUrl.searchParams.append('scope', scopesToUse.join(' '))
  authUrl.searchParams.append('code_challenge', codeChallenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state', state)
  if (orgUUID) authUrl.searchParams.append('orgUUID', orgUUID)
  if (loginHint) authUrl.searchParams.append('login_hint', loginHint)
  if (loginMethod) authUrl.searchParams.append('login_method', loginMethod)
  return authUrl.toString()
}


export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect: boolean = false,
  expiresIn?: number,
  oauthProvider?: 'anthropic' | 'openai',
  openaiClientId?: string,
): Promise<OAuthTokenExchangeResponse> {
  if (oauthProvider === 'openai') {
    const clientId = openaiClientId ?? OPENAI_CLIENT_ID
    const requestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: OPENAI_REDIRECT_URL,
    })

    const response = await axios.post(OPENAI_TOKEN_URL, requestBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(
        response.status === 401
          ? 'Authentication failed: Invalid authorization code'
          : `Token exchange failed (${response.status}): ${response.statusText}`,
      )
    }
    logEvent('tengu_oauth_token_exchange_success', { oauthProvider: 'openai' })
    const data = response.data
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in ?? 3600,
      scope: data.scope ?? OPENAI_SCOPES,
      id_token: data.id_token,
    }
  }

  // Anthropic OAuth token exchange
  const requestBody: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: useManualRedirect
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
    client_id: getOauthConfig().CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  }

  if (expiresIn !== undefined) {
    requestBody.expires_in = expiresIn
  }

  const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  })

  if (response.status !== 200) {
    throw new Error(
      response.status === 401
        ? 'Authentication failed: Invalid authorization code'
        : `Token exchange failed (${response.status}): ${response.statusText}`,
    )
  }
  logEvent('tengu_oauth_token_exchange_success', {})
  return response.data
}


export async function refreshOAuthToken(
  refreshToken: string,
  { scopes: requestedScopes }: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const requestBody = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: getOauthConfig().CLIENT_ID,
    // Request specific scopes, defaulting to the full Claude AI set. The
    // backend's refresh-token grant allows scope expansion beyond what the
    // initial authorize granted (see ALLOWED_SCOPE_EXPANSIONS), so this is
    // safe even for tokens issued before scopes were added to the app's
    // registered oauth_scope.
    scope: (requestedScopes?.length
      ? requestedScopes
      : CLAUDE_AI_OAUTH_SCOPES
    ).join(' '),
  }

  try {
    const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(`Token refresh failed: ${response.statusText}`)
    }

    const data = response.data as OAuthTokenExchangeResponse
    const {
      access_token: accessToken,
      refresh_token: newRefreshToken = refreshToken,
      expires_in: expiresIn,
    } = data

    const expiresAt = Date.now() + expiresIn * 1000
    const scopes = parseScopes(data.scope)

    logEvent('tengu_oauth_token_refresh_success', {})

    // Skip the extra /api/oauth/profile round-trip when we already have both
    // the global-config profile fields AND the secure-storage subscription data.
    // Routine refreshes satisfy both, so we cut ~7M req/day fleet-wide.
    //
    // Checking secure storage (not just config) matters for the
    // CLAUDE_CODE_OAUTH_REFRESH_TOKEN re-login path: installOAuthTokens runs
    // performLogout() AFTER we return, wiping secure storage. If we returned
    // null for subscriptionType here, saveOAuthTokensIfNeeded would persist
    // null ?? (wiped) ?? null = null, and every future refresh would see the
    // config guard fields satisfied and skip again, permanently losing the
    // subscription type for paying users. By passing through existing values,
    // the re-login path writes cached ?? wiped ?? null = cached; and if secure
    // storage was already empty we fall through to the fetch.
    const config = getGlobalConfig()
    const existing = getClaudeAIOAuthTokens()
    const haveProfileAlready =
      config.oauthAccount?.billingType !== undefined &&
      config.oauthAccount?.accountCreatedAt !== undefined &&
      config.oauthAccount?.subscriptionCreatedAt !== undefined &&
      existing?.subscriptionType != null &&
      existing?.rateLimitTier != null

    const profileInfo = haveProfileAlready
      ? null
      : await fetchProfileInfo(accessToken)

    // Update the stored properties if they have changed
    if (profileInfo && config.oauthAccount) {
      const updates: Partial<AccountInfo> = {}
      if (profileInfo.displayName !== undefined) {
        updates.displayName = profileInfo.displayName
      }
      if (typeof profileInfo.hasExtraUsageEnabled === 'boolean') {
        updates.hasExtraUsageEnabled = profileInfo.hasExtraUsageEnabled
      }
      if (profileInfo.billingType !== null) {
        updates.billingType = profileInfo.billingType
      }
      if (profileInfo.accountCreatedAt !== undefined) {
        updates.accountCreatedAt = profileInfo.accountCreatedAt
      }
      if (profileInfo.subscriptionCreatedAt !== undefined) {
        updates.subscriptionCreatedAt = profileInfo.subscriptionCreatedAt
      }
      if (Object.keys(updates).length > 0) {
        saveGlobalConfig(current => ({
          ...current,
          oauthAccount: current.oauthAccount
            ? { ...current.oauthAccount, ...updates }
            : current.oauthAccount,
        }))
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      scopes,
      subscriptionType:
        profileInfo?.subscriptionType ?? existing?.subscriptionType ?? null,
      rateLimitTier:
        profileInfo?.rateLimitTier ?? existing?.rateLimitTier ?? null,
      profile: profileInfo?.rawProfile,
      tokenAccount: data.account
        ? {
            uuid: data.account.uuid,
            emailAddress: data.account.email_address,
            organizationUuid: data.organization?.uuid,
          }
        : undefined,
    }
  } catch (error) {
    const responseBody =
      axios.isAxiosError(error) && error.response?.data
        ? JSON.stringify(error.response.data)
        : undefined
    logEvent('tengu_oauth_token_refresh_failure', {
      error: (error as Error)
        .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(responseBody && {
        responseBody:
          responseBody as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
    throw error
  }
}

export async function refreshOpenAIOAuthToken(input: {
  refreshToken: string
  clientId?: string
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const clientId = input.clientId ?? OPENAI_CLIENT_ID
  const requestBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: clientId,
  })

  const response = await axios.post(OPENAI_TOKEN_URL, requestBody.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  })

  if (response.status !== 200) {
    throw new Error(`OpenAI token refresh failed: ${response.statusText}`)
  }

  const data = response.data
  logEvent('tengu_oauth_token_refresh_success', { oauthProvider: 'openai' })

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || input.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
  }
}

const OPENAI_CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const OPENAI_CODEX_CLIENT_VERSION = '0.118.0'

/**
 * Extract the ChatGPT account ID from an OpenAI OAuth access token JWT.
 */
export function extractAccountIdFromToken(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    )
    return (
      payload?.['https://api.openai.com/auth']?.chatgpt_account_id ??
      undefined
    )
  } catch {
    return undefined
  }
}

/**
 * Fetch the curated Codex model list from OpenAI's backend API.
 * Returns model slugs sorted by priority (ascending), filtered to visible + API-supported.
 */
export async function fetchOpenAICodexModels(input: {
  accessToken: string
  accountId: string
}): Promise<string[]> {
  const response = await axios.get(OPENAI_CODEX_MODELS_URL, {
    params: { client_version: OPENAI_CODEX_CLIENT_VERSION },
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'ChatGPT-Account-Id': input.accountId,
    },
    timeout: 15000,
  })

  if (response.status !== 200) {
    throw new Error(`Failed to fetch OpenAI Codex models: ${response.statusText}`)
  }

  const models = (response.data?.models ?? []) as Array<{
    slug: string
    visibility?: string
    supported_in_api?: boolean
    priority?: number
  }>

  return models
    .filter(m => m.visibility === 'list' && m.supported_in_api !== false)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map(m => m.slug)
}

export async function fetchAndStoreUserRoles(
  accessToken: string,
): Promise<void> {
  const response = await axios.get(getOauthConfig().ROLES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status !== 200) {
    throw new Error(`Failed to fetch user roles: ${response.statusText}`)
  }
  const data = response.data as UserRolesResponse
  const config = getGlobalConfig()

  if (!config.oauthAccount) {
    throw new Error('OAuth account information not found in config')
  }

  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: current.oauthAccount
      ? {
          ...current.oauthAccount,
          organizationRole: data.organization_role,
          workspaceRole: data.workspace_role,
          organizationName: data.organization_name,
        }
      : current.oauthAccount,
  }))

  logEvent('tengu_oauth_roles_stored', {
    org_role:
      data.organization_role as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function createAndStoreApiKey(
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await axios.post(getOauthConfig().API_KEY_URL, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    const apiKey = response.data?.raw_key
    if (apiKey) {
      await saveApiKey(apiKey)
      logEvent('tengu_oauth_api_key', {
        status:
          'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        statusCode: response.status,
      })
      return apiKey
    }
    return null
  } catch (error) {
    logEvent('tengu_oauth_api_key', {
      status:
        'failure' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error: (error instanceof Error
        ? error.message
        : String(
            error,
          )) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    throw error
  }
}

export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) {
    return false
  }

  const bufferTime = 5 * 60 * 1000
  const now = Date.now()
  const expiresWithBuffer = now + bufferTime
  return expiresWithBuffer >= expiresAt
}

export async function fetchProfileInfo(accessToken: string): Promise<{
  subscriptionType: SubscriptionType | null
  displayName?: string
  rateLimitTier: RateLimitTier | null
  hasExtraUsageEnabled: boolean | null
  billingType: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  rawProfile?: OAuthProfileResponse
}> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const orgType = profile?.organization?.organization_type

  // Reuse the logic from fetchSubscriptionType
  let subscriptionType: SubscriptionType | null = null
  switch (orgType) {
    case 'claude_max':
      subscriptionType = 'max'
      break
    case 'claude_pro':
      subscriptionType = 'pro'
      break
    case 'claude_enterprise':
      subscriptionType = 'enterprise'
      break
    case 'claude_team':
      subscriptionType = 'team'
      break
    default:
      // Return null for unknown organization types
      subscriptionType = null
      break
  }

  const result: {
    subscriptionType: SubscriptionType | null
    displayName?: string
    rateLimitTier: RateLimitTier | null
    hasExtraUsageEnabled: boolean | null
    billingType: BillingType | null
    accountCreatedAt?: string
    subscriptionCreatedAt?: string
  } = {
    subscriptionType,
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
    hasExtraUsageEnabled:
      profile?.organization?.has_extra_usage_enabled ?? null,
    billingType: profile?.organization?.billing_type ?? null,
  }

  if (profile?.account?.display_name) {
    result.displayName = profile.account.display_name
  }

  if (profile?.account?.created_at) {
    result.accountCreatedAt = profile.account.created_at
  }

  if (profile?.organization?.subscription_created_at) {
    result.subscriptionCreatedAt = profile.organization.subscription_created_at
  }

  logEvent('tengu_oauth_profile_fetch_success', {})

  return { ...result, rawProfile: profile }
}

/**
 * Gets the organization UUID from the OAuth access token
 * @returns The organization UUID or null if not authenticated
 */
export async function getOrganizationUUID(): Promise<string | null> {
  // Check global config first to avoid unnecessary API call
  const globalConfig = getGlobalConfig()
  const orgUUID = globalConfig.oauthAccount?.organizationUuid
  if (orgUUID) {
    return orgUUID
  }

  // Restored/dev builds may have token metadata populated without the full
  // config write path. Prefer local token-derived values before making a
  // profile request or giving up.
  const cachedTokens = getClaudeAIOAuthTokens()
  const tokenOrgUUID =
    cachedTokens?.tokenAccount?.organizationUuid ??
    cachedTokens?.profile?.organization?.uuid
  if (tokenOrgUUID) {
    return tokenOrgUUID
  }

  // Fall back to fetching from profile (requires user:profile scope)
  const accessToken = cachedTokens?.accessToken
  if (accessToken === undefined || !hasProfileScope()) {
    return null
  }
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const profileOrgUUID = profile?.organization?.uuid
  if (!profileOrgUUID) {
    return null
  }
  return profileOrgUUID
}

/**
 * Populate the OAuth account info if it has not already been cached in config.
 * @returns Whether or not the oauth account info was populated.
 */
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  // Check env vars first (synchronous, no network call needed).
  // SDK callers like Cowork can provide account info directly, which also
  // eliminates the race condition where early telemetry events lack account info.
  // NB: If/when adding additional SDK-relevant functionality requiring _other_ OAuth account properties,
  // please reach out to #proj-cowork so the team can add additional env var fallbacks.
  const envAccountUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID
  const envUserEmail = process.env.CLAUDE_CODE_USER_EMAIL
  const envOrganizationUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
  const hasEnvVars = Boolean(
    envAccountUuid && envUserEmail && envOrganizationUuid,
  )
  if (envAccountUuid && envUserEmail && envOrganizationUuid) {
    if (!getGlobalConfig().oauthAccount) {
      storeOAuthAccountInfo({
        accountUuid: envAccountUuid,
        emailAddress: envUserEmail,
        organizationUuid: envOrganizationUuid,
      })
    }
  }

  // Wait for any in-flight token refresh to complete first, since
  // refreshOAuthToken already fetches and stores profile info
  await checkAndRefreshOAuthTokenIfNeeded()

  const config = getGlobalConfig()
  if (
    (config.oauthAccount &&
      config.oauthAccount.billingType !== undefined &&
      config.oauthAccount.accountCreatedAt !== undefined &&
      config.oauthAccount.subscriptionCreatedAt !== undefined) ||
    !isClaudeAISubscriber() ||
    !hasProfileScope()
  ) {
    return false
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
    if (profile) {
      if (hasEnvVars) {
        logForDebugging(
          'OAuth profile fetch succeeded, overriding env var account info',
          { level: 'info' },
        )
      }
      storeOAuthAccountInfo({
        accountUuid: profile.account.uuid,
        emailAddress: profile.account.email,
        organizationUuid: profile.organization.uuid,
        displayName: profile.account.display_name || undefined,
        hasExtraUsageEnabled:
          profile.organization.has_extra_usage_enabled ?? false,
        billingType: profile.organization.billing_type ?? undefined,
        accountCreatedAt: profile.account.created_at,
        subscriptionCreatedAt:
          profile.organization.subscription_created_at ?? undefined,
      })
      return true
    }
  }
  return false
}

export function storeOAuthAccountInfo({
  accountUuid,
  emailAddress,
  organizationUuid,
  displayName,
  hasExtraUsageEnabled,
  billingType,
  accountCreatedAt,
  subscriptionCreatedAt,
}: {
  accountUuid: string
  emailAddress: string
  organizationUuid: string | undefined
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}): void {
  const accountInfo: AccountInfo = {
    accountUuid,
    emailAddress,
    organizationUuid,
    hasExtraUsageEnabled,
    billingType,
    accountCreatedAt,
    subscriptionCreatedAt,
  }
  if (displayName) {
    accountInfo.displayName = displayName
  }
  saveGlobalConfig(current => {
    // For oauthAccount we need to compare content since it's an object
    if (
      current.oauthAccount?.accountUuid === accountInfo.accountUuid &&
      current.oauthAccount?.emailAddress === accountInfo.emailAddress &&
      current.oauthAccount?.organizationUuid === accountInfo.organizationUuid &&
      current.oauthAccount?.displayName === accountInfo.displayName &&
      current.oauthAccount?.hasExtraUsageEnabled ===
        accountInfo.hasExtraUsageEnabled &&
      current.oauthAccount?.billingType === accountInfo.billingType &&
      current.oauthAccount?.accountCreatedAt === accountInfo.accountCreatedAt &&
      current.oauthAccount?.subscriptionCreatedAt ===
        accountInfo.subscriptionCreatedAt
    ) {
      return current
    }
    return { ...current, oauthAccount: accountInfo }
  })
}
