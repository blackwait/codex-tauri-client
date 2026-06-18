import React, { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ArrowUp, Loader2, X } from 'lucide-react';
import { ComposerAttachMenu } from './composerAttachMenu';
import { ModelReasoningPicker, type ModelOption } from './modelPicker';
import { PermissionsPicker, type PermissionModeId } from './permissionsPicker';

export type ComposerAttachment = {
  id: string;
  kind: 'image' | 'file';
  previewUrl?: string;
  dataUrl?: string;
  path?: string;
  name: string;
};

export type ComposerSubmitPayload = {
  text: string;
  attachments: ComposerAttachment[];
  planMode: boolean;
  goalMode: boolean;
};

type ChatComposerProps = {
  busy: boolean;
  waitingForReply: boolean;
  streamingText: string;
  replyHint: string | null;
  connected: boolean;
  projectName: string | null;
  draftMode: boolean;
  models: ModelOption[];
  selectedModel: string;
  selectedEffort: string;
  permissionMode: PermissionModeId;
  planMode: boolean;
  goalMode: boolean;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onPermissionModeChange: (mode: PermissionModeId) => void;
  onPlanModeChange: (enabled: boolean) => void;
  onGoalModeChange: (enabled: boolean) => void;
  onOpenSettings?: () => void;
  onOpenPlugins?: () => void;
  onSend: (payload: ComposerSubmitPayload) => boolean | Promise<boolean>;
  onNewThread: () => void;
};

const IMAGE_MIME_PREFIX = 'image/';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(path);
}

function normalizeSendText(value: string) {
  return value.replace(/\r\n/g, '\n').trim();
}

function hasComposerContent(value: string) {
  return value.trim().length > 0;
}

export const ChatComposer = React.memo(function ChatComposer({
  busy,
  waitingForReply,
  streamingText,
  replyHint,
  connected,
  projectName,
  draftMode,
  models,
  selectedModel,
  selectedEffort,
  permissionMode,
  planMode,
  goalMode,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onPlanModeChange,
  onGoalModeChange,
  onOpenSettings,
  onOpenPlugins,
  onSend,
  onNewThread,
}: ChatComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const justEndedCompositionRef = useRef(false);
  const submittingRef = useRef(false);
  const sendingRef = useRef(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [hasText, setHasText] = useState(false);
  const sending = busy;
  const placeholder = draftMode && projectName ? '随心输入' : 'Ask for follow-up changes';

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  const syncInputState = useCallback((node: HTMLTextAreaElement | null) => {
    setHasText(hasComposerContent(node?.value ?? ''));
  }, []);

  const resizeComposer = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, []);

  const addImageAttachment = useCallback(async (file: File) => {
    if (!file.type.startsWith(IMAGE_MIME_PREFIX)) return;
    const dataUrl = await readFileAsDataUrl(file);
    setAttachments((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: 'image',
        previewUrl: dataUrl,
        dataUrl,
        name: file.name || 'image',
      },
    ]);
  }, []);

  const addImageFromPath = useCallback((path: string) => {
    const name = path.split(/[/\\]/).pop() ?? path;
    const previewUrl = path.startsWith('data:') ? path : convertFileSrc(path);
    setAttachments((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: 'image',
        previewUrl,
        dataUrl: path.startsWith('data:') ? path : undefined,
        path: path.startsWith('data:') ? undefined : path,
        name,
      },
    ]);
  }, []);

  const addFilesFromPicker = useCallback(async () => {
    try {
      const selection = await openDialog({
        multiple: true,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      for (const path of paths) {
        if (typeof path !== 'string') continue;
        if (isImagePath(path)) addImageFromPath(path);
        else {
          setAttachments((current) => [
            ...current,
            { id: crypto.randomUUID(), kind: 'file', path, name: path.split(/[/\\]/).pop() ?? path },
          ]);
        }
      }
    } catch {
      fileInputRef.current?.click();
    }
  }, [addImageFromPath]);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith(IMAGE_MIME_PREFIX));
      if (imageItems.length === 0) return;
      event.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) await addImageAttachment(file);
      }
    },
    [addImageAttachment],
  );

  const handleHiddenFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    for (const file of files) {
      if (file.type.startsWith(IMAGE_MIME_PREFIX)) await addImageAttachment(file);
      else {
        setAttachments((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'file', name: file.name, path: file.name },
        ]);
      }
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  };

  const clearComposer = useCallback(() => {
    const node = inputRef.current;
    if (node) {
      node.value = '';
      node.style.height = 'auto';
    }
    setHasText(false);
  }, []);

  const restoreComposerText = useCallback(
    (text: string) => {
      const node = inputRef.current;
      if (!node || node.value.trim()) return;
      node.value = text;
      syncInputState(node);
      resizeComposer(node);
      node.focus();
    },
    [resizeComposer, syncInputState],
  );

  const submitWithText = useCallback(
    async (rawText: string) => {
      if (submittingRef.current) return;
      const text = normalizeSendText(rawText);
      if (!text && attachments.length === 0) return;

      const payload = {
        text,
        attachments: [...attachments],
        planMode,
        goalMode,
      };
      submittingRef.current = true;
      try {
        const accepted = await onSend(payload);
        if (accepted !== true) {
          restoreComposerText(text);
          return;
        }
        clearComposer();
        setAttachments([]);
      } finally {
        submittingRef.current = false;
      }
    },
    [attachments, clearComposer, goalMode, onSend, planMode],
  );

  const submitFromDom = useCallback(() => {
    const node = inputRef.current;
    if (!node) return;
    void submitWithText(node.value);
  }, [submitWithText]);

  const handleEnterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
      if (justEndedCompositionRef.current) {
        justEndedCompositionRef.current = false;
        return;
      }
      event.preventDefault();
      const snapshot = event.currentTarget.value;
      window.setTimeout(() => {
        const latest = inputRef.current?.value ?? snapshot;
        void submitWithText(latest);
      }, 0);
    },
    [submitWithText],
  );

  const canSend = hasText || attachments.length > 0;

  return (
    <div className="codex-composer">
      <div className="codex-composer-surface">
        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((item) => (
              <div key={item.id} className="composer-attachment">
                {item.kind === 'image' && item.previewUrl ? (
                  <img src={item.previewUrl} alt={item.name} />
                ) : (
                  <div className="composer-attachment-file">{item.name}</div>
                )}
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => removeAttachment(item.id)}
                  title="移除"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="codex-composer-input"
          rows={attachments.length > 0 ? 1 : 2}
          placeholder={placeholder}
          defaultValue=""
          onInput={(event) => {
            syncInputState(event.currentTarget);
            resizeComposer(event.currentTarget);
          }}
          onPaste={(event) => {
            void handlePaste(event);
            window.setTimeout(() => {
              const node = inputRef.current;
              syncInputState(node);
              resizeComposer(node);
            }, 0);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            justEndedCompositionRef.current = false;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            justEndedCompositionRef.current = true;
            syncInputState(event.currentTarget);
            resizeComposer(event.currentTarget);
            window.setTimeout(() => {
              justEndedCompositionRef.current = false;
            }, 150);
          }}
          onKeyDown={handleEnterKeyDown}
        />

        <input
          ref={fileInputRef}
          className="composer-hidden-input"
          type="file"
          accept="image/*"
          multiple
          onChange={handleHiddenFileInput}
        />

        <div className="codex-composer-footer">
          <div className="codex-composer-left">
            <ComposerAttachMenu
              disabled={sending}
              planMode={planMode}
              goalMode={goalMode}
              onAddFiles={() => void addFilesFromPicker()}
              onNewThread={onNewThread}
              onPlanModeChange={onPlanModeChange}
              onGoalModeChange={onGoalModeChange}
              onOpenPlugins={onOpenPlugins}
            />
            <PermissionsPicker
              mode={permissionMode}
              disabled={sending || !connected}
              onChange={onPermissionModeChange}
              onOpenCustom={onOpenSettings}
            />
          </div>
          <div className="codex-composer-right">
            <ModelReasoningPicker
              models={models}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              disabled={sending}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
            />
            <button className="send-circle" onClick={submitFromDom} disabled={!canSend} type="button" title="发送">
              {sending ? <Loader2 size={14} className="spin" /> : <ArrowUp size={14} />}
            </button>
          </div>
        </div>
      </div>

      {waitingForReply || streamingText ? (
        <div className="composer-hint">{streamingText || replyHint || '思考中…'}</div>
      ) : null}
    </div>
  );
});

export function buildTurnInput(attachments: ComposerAttachment[], text: string) {
  const input: Array<Record<string, unknown>> = [];
  for (const item of attachments) {
    if (item.kind === 'image') {
      if (item.dataUrl) input.push({ type: 'image', url: item.dataUrl });
      else if (item.path) input.push({ type: 'localImage', path: item.path });
    } else if (item.path) {
      input.push({ type: 'localImage', path: item.path });
    }
  }
  const normalized = normalizeSendText(text);
  if (normalized) {
    input.push({ type: 'text', text: normalized, text_elements: [] });
  }
  return input;
}
