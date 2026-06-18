import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { FloatingMenuPortal, isOutsideFloatingMenu, useFloatingAnchor } from './floatingMenu';

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  supportedEfforts: string[];
  defaultEffort: string;
};

export const FALLBACK_MODELS: ModelOption[] = [
  {
    id: 'gpt-5.5-codex',
    model: 'gpt-5.5-codex',
    displayName: 'GPT-5.5',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'gpt-5.4-codex',
    model: 'gpt-5.4-codex',
    displayName: 'GPT-5.4',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex',
    model: 'gpt-5.3-codex',
    displayName: 'GPT-5.3-Codex',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.2-codex',
    model: 'gpt-5.2-codex',
    displayName: 'GPT-5.2',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const REASONING_ORDER = ['low', 'medium', 'high', 'xhigh', 'minimal', 'max'] as const;

const REASONING_LABELS: Record<string, string> = {
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

export function reasoningLabel(effort: string) {
  return REASONING_LABELS[effort] ?? effort;
}

export function shortModelLabel(model: string, displayName?: string) {
  if (displayName) {
    const stripped = displayName.replace(/^GPT-/i, '');
    if (stripped) return stripped;
  }
  const match = model.match(/gpt-(\d+(?:\.\d+)?(?:-[\w-]+)?)/i);
  if (match?.[1]) return match[1];
  return model;
}

export function parseModelsFromList(result: unknown): ModelOption[] {
  const data = (result as { data?: unknown[] })?.data;
  if (!Array.isArray(data) || data.length === 0) return FALLBACK_MODELS;
  const parsed = data
    .map((entry) => {
      const row = entry as {
        id?: string;
        model?: string;
        displayName?: string;
        hidden?: boolean;
        supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
        defaultReasoningEffort?: string;
      };
      if (!row.model || row.hidden) return null;
      const supportedEfforts = (row.supportedReasoningEfforts ?? [])
        .map((item) => item.reasoningEffort)
        .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0);
      return {
        id: row.id ?? row.model,
        model: row.model,
        displayName: row.displayName || row.model,
        supportedEfforts: supportedEfforts.length > 0 ? supportedEfforts : ['low', 'medium', 'high'],
        defaultEffort: row.defaultReasoningEffort || supportedEfforts[0] || 'medium',
      } satisfies ModelOption;
    })
    .filter(Boolean) as ModelOption[];
  return parsed.length > 0 ? parsed : FALLBACK_MODELS;
}

type ModelReasoningPickerProps = {
  models: ModelOption[];
  selectedModel: string;
  selectedEffort: string;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
};

export const ModelReasoningPicker = React.memo(function ModelReasoningPicker({
  models,
  selectedModel,
  selectedEffort,
  disabled,
  onModelChange,
  onEffortChange,
}: ModelReasoningPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const { anchorRef, menuStyle } = useFloatingAnchor<HTMLButtonElement>(open, 'top-end', menuRef, showModels);

  const activeModel = useMemo(
    () => models.find((item) => item.model === selectedModel) ?? models[0] ?? FALLBACK_MODELS[0],
    [models, selectedModel],
  );

  const effortOptions = useMemo(() => {
    const supported = new Set(activeModel.supportedEfforts);
    return REASONING_ORDER.filter((effort) => supported.has(effort));
  }, [activeModel.supportedEfforts]);

  const pillLabel = `${shortModelLabel(activeModel.model, activeModel.displayName)} ${reasoningLabel(selectedEffort)}`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (isOutsideFloatingMenu(event.target as Node, [rootRef.current, anchorRef.current], [menuRef.current])) {
        setOpen(false);
        setShowModels(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!effortOptions.includes(selectedEffort as (typeof REASONING_ORDER)[number])) {
      onEffortChange(activeModel.defaultEffort);
    }
  }, [activeModel.defaultEffort, effortOptions, onEffortChange, selectedEffort]);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={anchorRef}
        type="button"
        className="model-pill model-pill-trigger"
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
          setShowModels(false);
        }}
      >
        <span>{pillLabel}</span>
        <ChevronDown size={12} />
      </button>

      <FloatingMenuPortal open={open} menuStyle={menuStyle} menuRef={menuRef} className="model-picker-anchor">
        <div className="model-picker-stack">
          <div className="model-picker-panel">
            <div className="model-picker-title">推理</div>
            {effortOptions.map((effort) => (
              <button
                key={effort}
                type="button"
                className={effort === selectedEffort ? 'model-picker-item active' : 'model-picker-item'}
                onClick={() => {
                  onEffortChange(effort);
                  setOpen(false);
                  setShowModels(false);
                }}
              >
                <span>{reasoningLabel(effort)}</span>
                {effort === selectedEffort ? <span className="model-picker-check">✓</span> : null}
              </button>
            ))}
            <button
              type="button"
              className={showModels ? 'model-picker-item model-picker-item-nested active' : 'model-picker-item model-picker-item-nested'}
              onMouseEnter={() => setShowModels(true)}
              onFocus={() => setShowModels(true)}
            >
              <span>{activeModel.displayName}</span>
              <ChevronRight size={12} />
            </button>
          </div>

          {showModels ? (
            <div className="model-picker-panel model-picker-panel-sub" onMouseLeave={() => setShowModels(false)}>
              <div className="model-picker-title">模型</div>
              {models.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.model === selectedModel ? 'model-picker-item active' : 'model-picker-item'}
                  onClick={() => {
                    onModelChange(item.model);
                    if (!item.supportedEfforts.includes(selectedEffort)) {
                      onEffortChange(item.defaultEffort);
                    }
                    setOpen(false);
                    setShowModels(false);
                  }}
                >
                  <span>{item.displayName}</span>
                  {item.model === selectedModel ? <span className="model-picker-check">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </FloatingMenuPortal>
    </div>
  );
});
