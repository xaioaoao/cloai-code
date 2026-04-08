import { c as _c } from "react/compiler-runtime";
import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { FAST_MODE_MODEL_DISPLAY, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled } from 'src/utils/fastMode.js';
import type { CompatibleProviderKind, ProviderAuthMode, ProviderReasoningConfig } from '../utils/customApiStorage.js';
import {
  type EffortLevel,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js';
import {
  clampReasoningSelection,
  cycleReasoningEffort,
  getReasoningIndicatorLabel,
  getReasoningSpec,
  type ReasoningSelection,
} from '../utils/modelReasoning.js';
import { getDefaultMainLoopModel, type ModelSetting, modelDisplayString, parseUserSpecifiedModel } from '../utils/model/model.js';
import { getModelOptions } from '../utils/model/modelOptions.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Pane } from './design-system/Pane.js';
import { effortLevelToSymbol } from './EffortIndicator.js';

export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, reasoning: ReasoningSelection | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  headerText?: string;
  skipSettingsWrite?: boolean;
  customOptions?: Array<{
    value: string;
    label: string;
    description: string;
    model?: string;
    isCurrent?: boolean;
    providerKind?: CompatibleProviderKind;
    authMode?: ProviderAuthMode;
    reasoning?: ProviderReasoningConfig;
  }>;
};

type PickerOption = {
  value: string;
  label: string;
  description: string;
  model?: string;
  isCurrent?: boolean;
  providerKind?: CompatibleProviderKind;
  authMode?: ProviderAuthMode;
  reasoning?: ProviderReasoningConfig;
};

const NO_PREFERENCE = '__NO_PREFERENCE__';

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
  customOptions,
}: Props) {
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));
  const effortValue = useAppState(s => s.effortValue);
  const [hasToggledReasoning, setHasToggledReasoning] = React.useState(false);
  const [initialReasoning] = React.useState<ReasoningSelection | undefined>(() => {
    if (effortValue === undefined) return undefined;
    return {
      mode: 'anthropic-effort',
      effort: effortValue === 'max' ? 'max' : (effortValue as EffortLevel),
      isDefault: false,
    };
  });
  const [reasoningSelection, setReasoningSelection] = React.useState<ReasoningSelection | undefined>(initialReasoning);

  const rawModelOptions: PickerOption[] = (customOptions !== undefined
    ? customOptions
    : getModelOptions(isFastMode ?? false)) as PickerOption[];
  const initialRawValue = initial === null ? NO_PREFERENCE : initial;
  const initialValue = customOptions !== undefined
    ? (initial === null
        ? NO_PREFERENCE
        : rawModelOptions.find(opt => opt.value === initial)?.value ??
          rawModelOptions.find(opt => (opt.model ?? opt.value) === initial)?.value ??
          initialRawValue)
    : initialRawValue;
  const [focusedValue, setFocusedValue] = React.useState(initialValue);

  const modelOptions = React.useMemo(() => {
    if (initial === null || rawModelOptions.some(opt => opt.value === initialValue)) {
      return rawModelOptions;
    }
    return [
      ...rawModelOptions,
      {
        value: initialValue,
        label: modelDisplayString(initial),
        description: 'Current model',
        model: initial,
      },
    ];
  }, [initial, initialValue, rawModelOptions]);

  const selectOptions = React.useMemo(
    () => modelOptions.map(opt => ({
      ...opt,
      label: opt.isCurrent ? `${opt.label} current` : opt.label,
      value: opt.value === null ? NO_PREFERENCE : opt.value,
    })),
    [modelOptions],
  );

  const initialFocusValue = React.useMemo(
    () => (selectOptions.some(opt => opt.value === initialValue) ? initialValue : selectOptions[0]?.value),
    [initialValue, selectOptions],
  );
  const visibleCount = Math.min(10, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);
  const focusedOption = modelOptions.find(opt => opt.value === focusedValue);
  const focusedModelName = selectOptions.find(opt => opt.value === focusedValue)?.label;
  const focusedModel = resolveOptionModel(focusedValue, modelOptions);
  const focusedSpec = React.useMemo(
    () => getReasoningSpec({
      providerKind: focusedOption?.providerKind,
      authMode: focusedOption?.authMode,
      model: focusedModel ?? getDefaultMainLoopModel(),
      storedReasoning: focusedOption?.reasoning,
    }),
    [focusedModel, focusedOption?.authMode, focusedOption?.providerKind, focusedOption?.reasoning],
  );
  const resolvedSelection = clampReasoningSelection(reasoningSelection, focusedSpec);
  const indicatorLabel = getReasoningIndicatorLabel(resolvedSelection, focusedSpec);

  const handleFocus = React.useCallback((value: string) => {
    setFocusedValue(value);
    const nextOption = modelOptions.find(opt => opt.value === value);
    const nextModel = resolveOptionModel(value, modelOptions) ?? getDefaultMainLoopModel();
    const nextSpec = getReasoningSpec({
      providerKind: nextOption?.providerKind,
      authMode: nextOption?.authMode,
      model: nextModel,
      storedReasoning: nextOption?.reasoning,
    });
    setReasoningSelection(prev => {
      if (!hasToggledReasoning && effortValue === undefined) {
        return nextSpec.defaultSelection;
      }
      return clampReasoningSelection(prev, nextSpec);
    });
  }, [effortValue, hasToggledReasoning, modelOptions]);

  const handleCycleReasoning = React.useCallback((direction: 'left' | 'right') => {
    if (!focusedSpec.supportsAdjustment) return;
    setReasoningSelection(prev => cycleReasoningEffort(prev, focusedSpec, direction));
    setHasToggledReasoning(true);
  }, [focusedSpec]);

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleReasoning('left'),
      'modelPicker:increaseEffort': () => handleCycleReasoning('right'),
    },
    { context: 'ModelPicker' },
  );

  const handleSelect = React.useCallback((value: string) => {
    logEvent('tengu_model_command_menu_effort', {
      effort:
        resolvedSelection.mode === 'none'
          ? 'none'
          : (resolvedSelection.effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
    });
    if (!skipSettingsWrite && resolvedSelection.mode === 'anthropic-effort') {
      const selectedModel = resolveOptionModel(value, modelOptions);
      const defaultEffort = getReasoningSpec({ model: selectedModel ?? getDefaultMainLoopModel() }).defaultSelection;
      const effortLevel = resolvePickerEffortPersistence(
        resolvedSelection.effort,
        defaultEffort.mode === 'anthropic-effort' ? defaultEffort.effort : 'high',
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledReasoning,
      );
      const persistable = toPersistableEffort(effortLevel);
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable });
      }
      setAppState(prev => ({
        ...prev,
        effortValue: effortLevel,
      }));
    }

    const selectedReasoning =
      hasToggledReasoning || resolvedSelection.mode !== 'anthropic-effort'
        ? resolvedSelection
        : undefined;

    if (value === NO_PREFERENCE) {
      onSelect(null, selectedReasoning);
      return;
    }
    onSelect(customOptions !== undefined ? value : (resolveOptionModel(value, modelOptions) ?? value), selectedReasoning);
  }, [customOptions, hasToggledReasoning, modelOptions, onSelect, resolvedSelection, setAppState, skipSettingsWrite]);

  const content = (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold={true}>Select model</Text>
        <Text dimColor={true}>{headerText ?? 'Switch between models. Applies to this session and future Claude Code sessions. For other/previous model names, specify with --model.'}</Text>
        {sessionModel && (
          <Text dimColor={true}>
            Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode). Selecting a model will undo this.
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column">
          <Select
            defaultValue={initialValue}
            defaultFocusValue={initialFocusValue}
            options={selectOptions}
            onChange={handleSelect}
            onFocus={handleFocus}
            onCancel={onCancel ?? (() => {})}
            visibleOptionCount={visibleCount}
          />
        </Box>
        {hiddenCount > 0 && (
          <Box paddingLeft={3}>
            <Text dimColor={true}>and {hiddenCount} more…</Text>
          </Box>
        )}
      </Box>

      <Box marginBottom={1} flexDirection="column">
        {focusedSpec.supportsAdjustment ? (
          <Text dimColor={true}>
            <EffortLevelIndicator effort={resolvedSelection.mode === 'anthropic-effort' ? resolvedSelection.effort : undefined} />{' '}
            {capitalize(indicatorLabel)} <Text color="subtle">← → to adjust</Text>
          </Text>
        ) : (
          <Text color="subtle">
            <EffortLevelIndicator effort={undefined} /> {focusedSpec.unsupportedLabel ?? `Effort not supported${focusedModelName ? ` for ${focusedModelName}` : ''}`}
          </Text>
        )}
      </Box>

      {isFastModeEnabled() ? (showFastModeNotice ? (
        <Box marginBottom={1}>
          <Text dimColor={true}>
            Fast mode is <Text bold={true}>ON</Text> and available with {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models turn off fast mode.
          </Text>
        </Box>
      ) : isFastModeAvailable() && !isFastModeCooldown() ? (
        <Box marginBottom={1}>
          <Text dimColor={true}>Use <Text bold={true}>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).</Text>
        </Box>
      ) : null) : null}

      {isStandaloneCommand && (
        <Text dimColor={true} italic={true}>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" />
            </Byline>
          )}
        </Text>
      )}
    </Box>
  );

  if (!isStandaloneCommand) return content;
  return <Pane color="permission">{content}</Pane>;
}

function resolveOptionModel(value?: string, options?: PickerOption[]): string | undefined {
  if (!value) return undefined;
  if (value === NO_PREFERENCE) return getDefaultMainLoopModel();
  const explicitModel = options?.find(option => option.value === value)?.model;
  return parseUserSpecifiedModel(explicitModel ?? value);
}

function EffortLevelIndicator({ effort }: { effort: EffortLevel | undefined }) {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>;
}
