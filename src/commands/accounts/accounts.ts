import type { LocalCommandCall } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  applyProviderEnvironment,
  buildStorageForActiveProvider,
  getProviderKeyFromConfig,
  isProviderInCooldown,
  isProviderPoolEnabled,
  isProviderPoolPaused,
  isProviderQuotaBlocked,
  readCustomApiStorage,
  type ProviderConfig,
  updateProviderInStorage,
  writeCustomApiStorage,
} from '../../utils/customApiStorage.js'

type ProviderTarget = {
  provider: ProviderConfig
  providerKey: string
  index: number
}

function providerKindLabel(provider: ProviderConfig): string {
  return provider.kind === 'openai-like'
    ? 'openai'
    : provider.kind === 'gemini-like'
      ? 'gemini'
      : 'anthropic'
}

function providerAuthLabel(provider: ProviderConfig): string {
  return provider.authMode === 'api-key'
    ? 'api-key'
    : provider.authMode === 'chat-completions'
      ? 'chat'
      : provider.authMode === 'responses'
        ? 'responses'
        : provider.authMode === 'oauth'
          ? 'oauth'
          : provider.authMode === 'gemini-cli-oauth'
            ? 'gemini-oauth'
            : 'vertex'
}

function providerPoolLabel(provider: ProviderConfig): string {
  if (!isProviderPoolEnabled(provider)) return 'excluded'
  if (isProviderPoolPaused(provider)) return 'paused'
  if (isProviderInCooldown(provider)) {
    const secs = Math.max(
      1,
      Math.ceil(((provider.pool?.cooldownUntil ?? 0) - Date.now()) / 1000),
    )
    return `cooldown(${secs}s)`
  }
  if (isProviderQuotaBlocked(provider)) {
    const secs = Math.max(
      1,
      Math.ceil(((provider.pool?.resetAt ?? 0) - Date.now()) / 1000),
    )
    return `quota(${secs}s)`
  }
  if (provider.pool?.status === 'error') return 'error'
  return 'active'
}

function renderProviderList(storage: ReturnType<typeof readCustomApiStorage>): string {
  const providers = storage.providers ?? []
  if (providers.length === 0) {
    return 'No compatible API accounts configured. Run /login to add one.'
  }
  const lines = providers.map((provider, idx) => {
    const providerKey = getProviderKeyFromConfig(provider)
    const marker = providerKey === storage.activeProviderKey ? '*' : ' '
    const modelCount = provider.models.length
    const oauthAccountId =
      provider.authMode === 'oauth'
        ? (provider.oauth as { accountId?: string } | undefined)?.accountId
        : undefined
    const accountLabel = oauthAccountId
      ? ` · acct=${oauthAccountId.slice(-8)}`
      : ''
    return `${marker} [${idx + 1}] ${provider.id} · ${providerKindLabel(provider)}/${providerAuthLabel(provider)}${accountLabel} · pool=${providerPoolLabel(provider)} · models=${modelCount}`
  })
  return [
    'Accounts:',
    ...lines,
    '',
    'Tips:',
    '/accounts use <index|provider_id>',
    '/accounts pause <index|provider_id>',
    '/accounts resume <index|provider_id>',
    '/accounts include <index|provider_id>',
    '/accounts exclude <index|provider_id>',
  ].join('\n')
}

function resolveProviderTarget(
  providers: ProviderConfig[],
  rawTarget: string,
): ProviderTarget | null {
  const target = rawTarget.trim()
  if (!target) return null
  if (/^\d+$/.test(target)) {
    const index = Number(target)
    if (index >= 1 && index <= providers.length) {
      const provider = providers[index - 1]!
      return { provider, providerKey: getProviderKeyFromConfig(provider), index: index - 1 }
    }
  }
  const byKeyIndex = providers.findIndex(
    provider => getProviderKeyFromConfig(provider) === target,
  )
  if (byKeyIndex >= 0) {
    const provider = providers[byKeyIndex]!
    return {
      provider,
      providerKey: getProviderKeyFromConfig(provider),
      index: byKeyIndex,
    }
  }
  const byId = providers
    .map((provider, index) => ({ provider, index }))
    .filter(item => item.provider.id === target)
  if (byId.length === 1) {
    const match = byId[0]!
    return {
      provider: match.provider,
      providerKey: getProviderKeyFromConfig(match.provider),
      index: match.index,
    }
  }
  return null
}

function applyStorageToGlobalConfig(
  storage: ReturnType<typeof readCustomApiStorage>,
): void {
  const endpoint = storage.providerKind
    ? {
        kind: storage.providerKind,
        provider: storage.provider,
        providerId: storage.providerId,
        baseURL: storage.baseURL,
        apiKey: storage.apiKey,
        model: storage.model,
        savedModels: storage.savedModels,
      }
    : undefined
  saveGlobalConfig(current => ({
    ...current,
    customApiEndpoint: endpoint,
  }))
}

function usageText(): string {
  return [
    'Usage:',
    '/accounts',
    '/accounts list',
    '/accounts use <index|provider_id>',
    '/accounts pause <index|provider_id>',
    '/accounts resume <index|provider_id>',
    '/accounts include <index|provider_id>',
    '/accounts exclude <index|provider_id>',
  ].join('\n')
}

export const call: LocalCommandCall = async (args, _context) => {
  const trimmed = args.trim()
  const [subcommandRaw, ...rest] = trimmed.length > 0 ? trimmed.split(/\s+/) : []
  const subcommand = (subcommandRaw ?? 'list').toLowerCase()
  const targetRaw = rest.join(' ').trim()

  const storage = readCustomApiStorage()
  const providers = storage.providers ?? []

  if (subcommand === 'list' || subcommand === '') {
    return {
      type: 'text',
      value: renderProviderList(storage),
    }
  }

  if (providers.length === 0) {
    return {
      type: 'text',
      value: 'No compatible API accounts configured. Run /login to add one.',
    }
  }

  const target = resolveProviderTarget(providers, targetRaw)
  if (!target) {
    return {
      type: 'text',
      value: `Account not found: ${targetRaw || '<empty>'}\n\n${usageText()}`,
    }
  }

  if (subcommand === 'use') {
    const activeModel = storage.activeModel
    const nextModel = activeModel && target.provider.models.includes(activeModel)
      ? activeModel
      : target.provider.models[0] ?? activeModel
    const nextStorage = buildStorageForActiveProvider(
      storage,
      target.provider,
      nextModel,
    )
    writeCustomApiStorage(nextStorage)
    applyStorageToGlobalConfig(nextStorage)
    applyProviderEnvironment(target.provider, nextModel)
    return {
      type: 'text',
      value: `Active account set to [${target.index + 1}] ${target.provider.id}`,
    }
  }

  if (subcommand === 'pause') {
    const nextStorage = updateProviderInStorage(
      storage,
      target.providerKey,
      provider => ({
        ...provider,
        pool: {
          ...provider.pool,
          paused: true,
          updatedAt: Date.now(),
        },
      }),
    )
    writeCustomApiStorage(nextStorage)
    return {
      type: 'text',
      value: `Paused account [${target.index + 1}] ${target.provider.id}`,
    }
  }

  if (subcommand === 'resume') {
    const nextStorage = updateProviderInStorage(
      storage,
      target.providerKey,
      provider => ({
        ...provider,
        pool: {
          ...provider.pool,
          paused: false,
          status: 'active',
          cooldownUntil: undefined,
          resetAt: undefined,
          lastError: undefined,
          errorCount: 0,
          updatedAt: Date.now(),
        },
      }),
    )
    writeCustomApiStorage(nextStorage)
    return {
      type: 'text',
      value: `Resumed account [${target.index + 1}] ${target.provider.id}`,
    }
  }

  if (subcommand === 'include') {
    const nextStorage = updateProviderInStorage(
      storage,
      target.providerKey,
      provider => ({
        ...provider,
        pool: {
          ...provider.pool,
          enabled: true,
          updatedAt: Date.now(),
        },
      }),
    )
    writeCustomApiStorage(nextStorage)
    return {
      type: 'text',
      value: `Included account [${target.index + 1}] ${target.provider.id} in pool`,
    }
  }

  if (subcommand === 'exclude') {
    const nextStorage = updateProviderInStorage(
      storage,
      target.providerKey,
      provider => ({
        ...provider,
        pool: {
          ...provider.pool,
          enabled: false,
          updatedAt: Date.now(),
        },
      }),
    )
    writeCustomApiStorage(nextStorage)
    return {
      type: 'text',
      value: `Excluded account [${target.index + 1}] ${target.provider.id} from pool`,
    }
  }

  return {
    type: 'text',
    value: usageText(),
  }
}
