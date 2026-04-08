import type {
  ProviderAuthMode,
  CompatibleProviderKind,
  ProviderReasoningConfig,
} from './customApiStorage.js'
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from './effort.js'

export type AnthropicReasoningMode = 'anthropic-effort'
export type OpenAIReasoningMode =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'openai-codex-oauth'
export type ReasoningMode = AnthropicReasoningMode | OpenAIReasoningMode | 'none'

export type OpenAIChatCompletionsReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

export type OpenAIResponsesReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

export type OpenAICodexReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

export type OpenAIResponsesReasoningSummary =
  | 'auto'
  | 'detailed'
  | 'concise'
  | null

export type OpenAICodexReasoningSummary =
  | 'auto'
  | 'concise'
  | 'detailed'
  | 'off'
  | 'on'
  | null

export type ReasoningEffortValue =
  | EffortLevel
  | OpenAIChatCompletionsReasoningEffort
  | OpenAIResponsesReasoningEffort
  | OpenAICodexReasoningEffort

export type ReasoningSelection =
  | {
      mode: 'anthropic-effort'
      effort: EffortLevel
      isDefault: boolean
    }
  | {
      mode: 'openai-chat-completions'
      effort: OpenAIChatCompletionsReasoningEffort
      isDefault: boolean
    }
  | {
      mode: 'openai-responses'
      effort: OpenAIResponsesReasoningEffort
      summary: OpenAIResponsesReasoningSummary
      isDefault: boolean
    }
  | {
      mode: 'openai-codex-oauth'
      effort: OpenAICodexReasoningEffort
      summary: OpenAICodexReasoningSummary
      isDefault: boolean
    }
  | {
      mode: 'none'
    }

export type ReasoningSpec = {
  mode: ReasoningMode
  effortOptions: readonly ReasoningEffortValue[]
  defaultSelection: ReasoningSelection
  supportsAdjustment: boolean
  sourceLabel?: string
  unsupportedLabel?: string
}

const OPENAI_CHAT_COMPLETIONS_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly OpenAIChatCompletionsReasoningEffort[]

const OPENAI_RESPONSES_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly OpenAIResponsesReasoningEffort[]

const OPENAI_CODEX_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly OpenAICodexReasoningEffort[]

function isOpenAIChatCompletionsReasoningEffort(
  value: unknown,
): value is OpenAIChatCompletionsReasoningEffort {
  return (
    typeof value === 'string' &&
    OPENAI_CHAT_COMPLETIONS_EFFORTS.includes(
      value as OpenAIChatCompletionsReasoningEffort,
    )
  )
}

function isOpenAIResponsesReasoningEffort(
  value: unknown,
): value is OpenAIResponsesReasoningEffort {
  return (
    typeof value === 'string' &&
    OPENAI_RESPONSES_EFFORTS.includes(value as OpenAIResponsesReasoningEffort)
  )
}

function isOpenAICodexReasoningEffort(
  value: unknown,
): value is OpenAICodexReasoningEffort {
  return (
    typeof value === 'string' &&
    OPENAI_CODEX_EFFORTS.includes(value as OpenAICodexReasoningEffort)
  )
}

function getAnthropicDefaultEffort(model: string): EffortLevel {
  const defaultValue = getDefaultEffortForModel(model)
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high'
}

export function getReasoningMode(
  providerKind: CompatibleProviderKind | undefined,
  authMode: ProviderAuthMode | undefined,
  model: string,
): ReasoningMode {
  if (providerKind === 'openai-like') {
    if (authMode === 'chat-completions') return 'openai-chat-completions'
    if (authMode === 'responses') return 'openai-responses'
    if (authMode === 'oauth') return 'openai-codex-oauth'
    return 'none'
  }
  if (providerKind === 'gemini-like') {
    return 'none'
  }
  return modelSupportsEffort(model) ? 'anthropic-effort' : 'none'
}

export function getReasoningSpec(input: {
  providerKind?: CompatibleProviderKind
  authMode?: ProviderAuthMode
  model: string
  storedReasoning?: ProviderReasoningConfig
}): ReasoningSpec {
  const { providerKind, authMode, model, storedReasoning } = input
  const mode = getReasoningMode(providerKind, authMode, model)

  if (mode === 'anthropic-effort') {
    const defaultEffort = getAnthropicDefaultEffort(model)
    const supportsMax = modelSupportsMaxEffort(model)
    const effortOptions = supportsMax
      ? (['low', 'medium', 'high', 'max'] as const)
      : (['low', 'medium', 'high'] as const)
    return {
      mode,
      effortOptions,
      defaultSelection: {
        mode,
        effort: defaultEffort,
        isDefault: true,
      },
      supportsAdjustment: true,
    }
  }

  if (mode === 'openai-chat-completions') {
    const effort = isOpenAIChatCompletionsReasoningEffort(
      storedReasoning?.reasoningEffort,
    )
      ? storedReasoning.reasoningEffort
      : 'medium'
    return {
      mode,
      effortOptions: OPENAI_CHAT_COMPLETIONS_EFFORTS,
      defaultSelection: {
        mode,
        effort,
        isDefault: !storedReasoning?.reasoningEffort,
      },
      supportsAdjustment: true,
      sourceLabel: 'Chat Completions',
    }
  }

  if (mode === 'openai-responses') {
    const effort = isOpenAIResponsesReasoningEffort(storedReasoning?.reasoningEffort)
      ? storedReasoning.reasoningEffort
      : 'medium'
    const summary: OpenAIResponsesReasoningSummary =
      storedReasoning?.reasoningSummary === 'detailed' ||
      storedReasoning?.reasoningSummary === 'concise' ||
      storedReasoning?.reasoningSummary === 'auto' ||
      storedReasoning?.reasoningSummary === null
        ? storedReasoning.reasoningSummary
        : 'detailed'
    return {
      mode,
      effortOptions: OPENAI_RESPONSES_EFFORTS,
      defaultSelection: {
        mode,
        effort,
        summary,
        isDefault:
          !storedReasoning?.reasoningEffort &&
          (storedReasoning?.reasoningSummary === undefined ||
            storedReasoning.reasoningSummary === 'detailed'),
      },
      supportsAdjustment: true,
      sourceLabel: 'OpenAI Responses',
    }
  }

  if (mode === 'openai-codex-oauth') {
    const effort = isOpenAICodexReasoningEffort(storedReasoning?.reasoningEffort)
      ? storedReasoning.reasoningEffort
      : 'medium'
    const summary: OpenAICodexReasoningSummary =
      storedReasoning?.reasoningSummary === 'auto' ||
      storedReasoning?.reasoningSummary === 'concise' ||
      storedReasoning?.reasoningSummary === 'detailed' ||
      storedReasoning?.reasoningSummary === 'off' ||
      storedReasoning?.reasoningSummary === 'on' ||
      storedReasoning?.reasoningSummary === null
        ? storedReasoning.reasoningSummary
        : 'detailed'
    return {
      mode,
      effortOptions: OPENAI_CODEX_EFFORTS,
      defaultSelection: {
        mode,
        effort,
        summary,
        isDefault:
          !storedReasoning?.reasoningEffort &&
          (storedReasoning?.reasoningSummary === undefined ||
            storedReasoning.reasoningSummary === 'detailed'),
      },
      supportsAdjustment: true,
      sourceLabel: 'Codex OAuth',
    }
  }

  return {
    mode: 'none',
    effortOptions: [],
    defaultSelection: { mode: 'none' },
    supportsAdjustment: false,
    unsupportedLabel:
      providerKind === 'openai-like'
        ? 'Native reasoning not available for this OpenAI chat-completions model'
        : `Effort not supported${model ? ` for ${model}` : ''}`,
  }
}

export function clampReasoningSelection(
  selection: ReasoningSelection | undefined,
  spec: ReasoningSpec,
): ReasoningSelection {
  if (spec.mode === 'none') return { mode: 'none' }
  if (!selection || selection.mode !== spec.mode) return spec.defaultSelection

  if (spec.mode === 'anthropic-effort') {
    const defaultSelection = spec.defaultSelection as Extract<
      ReasoningSelection,
      { mode: 'anthropic-effort' }
    >
    const effort = spec.effortOptions.includes(selection.effort)
      ? selection.effort
      : defaultSelection.effort
    return {
      mode: spec.mode,
      effort,
      isDefault: effort === defaultSelection.effort,
    }
  }

  if (spec.mode === 'openai-chat-completions') {
    const defaultSelection = spec.defaultSelection as Extract<
      ReasoningSelection,
      { mode: 'openai-chat-completions' }
    >
    const effort = spec.effortOptions.includes(selection.effort)
      ? (selection.effort as OpenAIChatCompletionsReasoningEffort)
      : defaultSelection.effort
    return {
      mode: spec.mode,
      effort,
      isDefault: effort === defaultSelection.effort,
    }
  }

  if (spec.mode === 'openai-responses') {
    const defaultSelection = spec.defaultSelection as Extract<
      ReasoningSelection,
      { mode: 'openai-responses' }
    >
    const effort = spec.effortOptions.includes(selection.effort)
      ? (selection.effort as OpenAIResponsesReasoningEffort)
      : defaultSelection.effort
    return {
      mode: spec.mode,
      effort,
      summary:
        selection.summary === 'auto' ||
        selection.summary === 'detailed' ||
        selection.summary === 'concise' ||
        selection.summary === null
          ? selection.summary
          : defaultSelection.summary,
      isDefault: effort === defaultSelection.effort,
    }
  }

  const defaultSelection = spec.defaultSelection as Extract<
    ReasoningSelection,
    { mode: 'openai-codex-oauth' }
  >
  const effort = spec.effortOptions.includes(selection.effort)
    ? (selection.effort as OpenAICodexReasoningEffort)
    : defaultSelection.effort
  return {
    mode: spec.mode,
    effort,
    summary:
      selection.summary === 'auto' ||
      selection.summary === 'concise' ||
      selection.summary === 'detailed' ||
      selection.summary === 'off' ||
      selection.summary === 'on' ||
      selection.summary === null
        ? selection.summary
        : defaultSelection.summary,
    isDefault: effort === defaultSelection.effort,
  }
}

export function cycleReasoningEffort(
  selection: ReasoningSelection | undefined,
  spec: ReasoningSpec,
  direction: 'left' | 'right',
): ReasoningSelection {
  const currentSelection = clampReasoningSelection(selection, spec)
  if (!spec.supportsAdjustment || currentSelection.mode === 'none') {
    return currentSelection
  }

  const levels = [...spec.effortOptions]
  const currentIndex = Math.max(0, levels.indexOf(currentSelection.effort))
  const nextIndex =
    direction === 'right'
      ? (currentIndex + 1) % levels.length
      : (currentIndex - 1 + levels.length) % levels.length
  const nextEffort = levels[nextIndex]!

  if (currentSelection.mode === 'anthropic-effort') {
    const defaultSelection = spec.defaultSelection as Extract<
      ReasoningSelection,
      { mode: 'anthropic-effort' }
    >
    return {
      mode: currentSelection.mode,
      effort: nextEffort as EffortLevel,
      isDefault: nextEffort === defaultSelection.effort,
    }
  }

  if (currentSelection.mode === 'openai-chat-completions') {
    const defaultSelection = spec.defaultSelection as Extract<
      ReasoningSelection,
      { mode: 'openai-chat-completions' }
    >
    return {
      mode: currentSelection.mode,
      effort: nextEffort as OpenAIChatCompletionsReasoningEffort,
      isDefault: nextEffort === defaultSelection.effort,
    }
  }

  if (currentSelection.mode === 'openai-responses') {
    const defaultSelection = spec.defaultSelection as Extract<
      ReasoningSelection,
      { mode: 'openai-responses' }
    >
    return {
      mode: currentSelection.mode,
      effort: nextEffort as OpenAIResponsesReasoningEffort,
      summary: currentSelection.summary,
      isDefault: nextEffort === defaultSelection.effort,
    }
  }

  const defaultSelection = spec.defaultSelection as Extract<
    ReasoningSelection,
    { mode: 'openai-codex-oauth' }
  >
  return {
    mode: currentSelection.mode,
    effort: nextEffort as OpenAICodexReasoningEffort,
    summary: currentSelection.summary,
    isDefault: nextEffort === defaultSelection.effort,
  }
}

export function getReasoningIndicatorLabel(
  selection: ReasoningSelection,
  spec: ReasoningSpec,
): string {
  if (selection.mode === 'anthropic-effort') {
    return `${selection.effort} effort${selection.isDefault ? ' (default)' : ''}`
  }
  if (
    selection.mode === 'openai-chat-completions' ||
    selection.mode === 'openai-responses' ||
    selection.mode === 'openai-codex-oauth'
  ) {
    return `Reasoning: ${selection.effort}${selection.isDefault ? ' (default)' : ''}${spec.sourceLabel ? ` · ${spec.sourceLabel}` : ''}`
  }
  return spec.unsupportedLabel ?? 'Reasoning not supported'
}

export function getOpenAIReasoningConfig(
  providerKind: CompatibleProviderKind | undefined,
  authMode: ProviderAuthMode | undefined,
  model: string,
  storedReasoning?: ProviderReasoningConfig,
): ProviderReasoningConfig | undefined {
  const spec = getReasoningSpec({ providerKind, authMode, model, storedReasoning })
  if (spec.mode === 'openai-chat-completions') {
    const selection = clampReasoningSelection(undefined, spec)
    return {
      reasoningEffort: selection.effort,
    }
  }
  if (spec.mode === 'openai-responses') {
    const selection = clampReasoningSelection(undefined, spec)
    return {
      reasoningEffort: selection.effort,
      reasoningSummary: selection.summary,
    }
  }
  if (spec.mode === 'openai-codex-oauth') {
    const selection = clampReasoningSelection(undefined, spec)
    return {
      reasoningEffort: selection.effort,
      reasoningSummary: selection.summary,
      textVerbosity: storedReasoning?.textVerbosity ?? 'medium',
    }
  }
  return undefined
}
