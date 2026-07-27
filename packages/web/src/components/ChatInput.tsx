'use client';

import { KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { usePathCompletion } from '@/hooks/usePathCompletion';
import type { UploadStatus, WhisperOptions } from '@/hooks/useSendMessage';
import type { DeliveryMode } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { compressImage } from '@/utils/compressImage';
import { ChatInputMenus } from './ChatInputMenus';
import { buildCatOptions, type CatOption, detectMenuTrigger, GAME_LIST, WEREWOLF_MODES } from './chat-input-options';
import { deriveImageLifecycleStatus, isImageLifecycleBlockingSend } from './chat-input-upload-state';
import { GameLobby, type GameStartPayload } from './game/GameLobby';
import { HistorySearchModal } from './HistorySearchModal';
import { ImagePreview } from './ImagePreview';
import { AttachIcon } from './icons/AttachIcon';
import { MobileInputToolbar } from './MobileInputToolbar';
import { PathCompletionMenu } from './PathCompletionMenu';
import { SlashCommandPicker, type SlashCommandItem } from './SlashCommandPicker';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { hasPendingThreadDraft, threadDrafts, threadFileDrafts, threadImageDrafts } from './thread-drafts';
import { WhisperCatSelector, WhisperTargetChips } from './WhisperCatSelector';

/** Module-level draft storage — survives component unmount/remount across thread switches */
export { threadDrafts, threadFileDrafts, threadImageDrafts } from './thread-drafts';

const MAX_IMAGE_DRAFT_THREADS = 5;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CVO_MODE_STORAGE_KEY = 'cat-cafe:cvoMode';
const PROMPT_PREFIX_STORAGE_KEY = 'cat-cafe:promptPrefix';
const CVO_MODE_PREFIX = `[CVO_MODE] 在执行任何操作之前，你必须先以采访者身份问我 3 个问题，帮助澄清需求：
① 你希望的最终产物/结果是什么？
② 有什么约束条件或不能动的边界？
③ 完成的标准是什么，怎样算"做好了"？
请等我逐一回答后再开始执行。`;

const PROMPT_PREFIX_OPTIONS = [
  {
    id: 'none',
    label: '无前缀',
    shortLabel: '提示词',
    description: '直接发送当前输入内容',
    prefix: '',
  },
  {
    id: 'requirements',
    label: '需求前置',
    shortLabel: '需求前置',
    description: '先问清目标、边界和验收标准',
    prefix: CVO_MODE_PREFIX,
  },
  {
    id: 'debug',
    label: '问题排查',
    shortLabel: '排查',
    description: '先定位现象、根因、影响面和修复方案',
    prefix:
      '[DEBUG_MODE] 请先按问题排查流程处理：明确现象、复现路径、可能根因、影响范围、最小修复方案和验证方式。不要直接给泛泛建议。',
  },
  {
    id: 'plan',
    label: '方案规划',
    shortLabel: '规划',
    description: '输出目标、范围、步骤、风险和验收点',
    prefix:
      '[PLAN_MODE] 请先做方案规划：明确目标、边界、执行步骤、依赖、风险、验收标准。优先给可落地的最小方案。',
  },
  {
    id: 'review',
    label: '代码审查',
    shortLabel: '审查',
    description: '优先找 bug、回归风险和缺失测试',
    prefix:
      '[REVIEW_MODE] 请以代码审查视角回答：优先指出 bug、行为回归、边界风险和缺失测试，再给修改建议。不要只做总结。',
  },
  {
    id: 'summary',
    label: '总结提炼',
    shortLabel: '总结',
    description: '提炼结论、关键点和下一步行动',
    prefix:
      '[SUMMARY_MODE] 请做结构化总结：先给一句核心结论，再提炼关键点、决策、待办和下一步行动。避免长篇复述。',
  },
] as const;

type PromptPrefixId = (typeof PROMPT_PREFIX_OPTIONS)[number]['id'];

function isPromptPrefixId(value: string | null): value is PromptPrefixId {
  return PROMPT_PREFIX_OPTIONS.some((option) => option.id === value);
}

interface ChatInputProps {
  /** Thread ID for draft persistence — drafts are saved per-thread */
  threadId?: string;
  onSend: (
    content: string,
    images?: File[],
    attachments?: File[],
    whisper?: WhisperOptions,
    deliveryMode?: DeliveryMode,
  ) => Promise<{ userMessageId?: string } | string | void> | { userMessageId?: string } | string | void;
  onStop?: () => void;
  disabled?: boolean;
  hasActiveInvocation?: boolean;
  uploadStatus?: UploadStatus;
  uploadError?: string | null;
}

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const ACCEPTED_TYPES = ACCEPTED_IMAGE_TYPES.join(',');
const ACCEPTED_IMAGE_TYPE_SET = new Set<string>(ACCEPTED_IMAGE_TYPES);

function detectSlashCommand(value: string, cursor: number): string | null {
  if (!value.startsWith('/') || cursor <= 0) return null;
  const token = value.match(/^\/[^\s]*/)?.[0] ?? '';
  if (cursor > token.length) return null;
  return value.slice(1, cursor);
}

function ImageUploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="14" height="12" rx="2.5" />
      <circle cx="7.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <path d="M5.5 14l3.2-3.3 2.2 2.1 1.6-1.7L16 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatInput({
  threadId,
  onSend,
  onStop,
  disabled,
  hasActiveInvocation,
  uploadStatus = 'idle',
  uploadError = null,
}: ChatInputProps) {
  const { cats } = useCatData();
  const ime = useIMEGuard();
  const currentThreadMembers = useChatStore((s) => s.threads.find((thread) => thread.id === threadId)?.participatingCats);
  const mentionCats = useMemo(() => {
    if (!currentThreadMembers?.length) return cats;
    const allowed = new Set(currentThreadMembers);
    return cats.filter((cat) => allowed.has(cat.id));
  }, [cats, currentThreadMembers]);
  const catOptions = useMemo(() => buildCatOptions(mentionCats), [mentionCats]);
  // F108 Scene 2: whisper-eligible cats (CatData[] for WhisperCatSelector)
  const whisperCats = useMemo(() => cats.filter((c) => c.roster?.available !== false), [cats]);

  // F122B AC-B10: track which cats are actively executing (for whisper disable)
  const activeInvocations = useChatStore((s) => s.activeInvocations);
  const storeTargetCats = useChatStore((s) => s.targetCats);
  const catStatuses = useChatStore((s) => s.catStatuses);
  const activeCatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const inv of Object.values(activeInvocations ?? {})) {
      ids.add(inv.catId);
    }
    // Defensive fallback: legacy paths set hasActiveInvocation=true without
    // populating activeInvocations slots. Use targetCats as degraded source.
    if (ids.size === 0 && hasActiveInvocation && storeTargetCats?.length) {
      for (const catId of storeTargetCats) ids.add(catId);
    }
    return ids;
  }, [activeInvocations, hasActiveInvocation, storeTargetCats]);

  const [input, setInput] = useState(() => (threadId ? (threadDrafts.get(threadId) ?? '') : ''));
  const [showMentions, setShowMentions] = useState(false);
  const [showGameMenu, setShowGameMenu] = useState(false);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [slashItems, setSlashItems] = useState<SlashCommandItem[]>([]);
  const [gameStep, setGameStep] = useState<'list' | 'modes'>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [images, setImages] = useState<File[]>(() => (threadId ? (threadImageDrafts.get(threadId) ?? []) : []));
  const [attachments, setAttachments] = useState<File[]>(() => (threadId ? (threadFileDrafts.get(threadId) ?? []) : []));
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [whisperMode] = useState(false);
  const [whisperTargets, setWhisperTargets] = useState<Set<string>>(new Set());
  const [sendAsTask, setSendAsTask] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [promptPrefixId, setPromptPrefixId] = useState<PromptPrefixId>('none');
  const [showPromptPrefixMenu, setShowPromptPrefixMenu] = useState(false);
  const selectedPromptPrefix = useMemo(
    () => PROMPT_PREFIX_OPTIONS.find((option) => option.id === promptPrefixId) ?? PROMPT_PREFIX_OPTIONS[0],
    [promptPrefixId],
  );
  const activeUiReady = isHydrated && Boolean(hasActiveInvocation);

  useEffect(() => {
    setIsHydrated(true);
    try {
      const storedPrefix = window.localStorage.getItem(PROMPT_PREFIX_STORAGE_KEY);
      if (isPromptPrefixId(storedPrefix)) {
        setPromptPrefixId(storedPrefix);
        return;
      }
      if (window.localStorage.getItem(CVO_MODE_STORAGE_KEY) === '1') {
        setPromptPrefixId('requirements');
      }
    } catch {
      // Keep the SSR-safe default when localStorage is unavailable.
    }
  }, []);

  const updatePromptPrefix = useCallback((next: PromptPrefixId) => {
    setPromptPrefixId(next);
    if (typeof window === 'undefined') return;
    try {
      if (next === 'none') {
        window.localStorage.removeItem(PROMPT_PREFIX_STORAGE_KEY);
        window.localStorage.removeItem(CVO_MODE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(PROMPT_PREFIX_STORAGE_KEY, next);
        window.localStorage.removeItem(CVO_MODE_STORAGE_KEY);
      }
    } catch {
      // LocalStorage is a convenience preference; sending should not depend on it.
    }
  }, []);

  // F108B AC-B7: In whisper mode, check if SELECTED targets are busy (not thread-level).
  // When all whisper targets are idle → show Send button, not Queue.

  const [mobileToolbar, setMobileToolbar] = useState(false);
  const [ghostSuggestion, setGhostSuggestion] = useState<string | null>(null);
  const ghostRef = useRef<string | null>(null);
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [lobbyMode, setLobbyMode] = useState<'player' | 'god-view' | 'detective' | null>(null);
  const addToast = useToastStore((s) => s.addToast);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gameBtnRef = useRef<HTMLButtonElement>(null);
  const promptPrefixMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const imageLifecycleStatus = deriveImageLifecycleStatus(isPreparingImages, uploadStatus);
  const sendTemporarilyDisabled = isImageLifecycleBlockingSend(imageLifecycleStatus);
  const usedAttachmentSlots = images.length + attachments.length;
  const hasReachedAttachmentLimit = usedAttachmentSlots >= MAX_ATTACHMENTS_PER_MESSAGE;

  const showAttachmentError = useCallback(
    (message: string) => {
      addToast({
        type: 'error',
        title: '附件未添加',
        message,
        duration: 4200,
      });
    },
    [addToast],
  );

  // F63-AC15: consume pendingChatInsert from workspace (thread-guarded)
  const pendingChatInsert = useChatStore((s) => s.pendingChatInsert);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const setThreadHasDraft = useChatStore((s) => s.setThreadHasDraft);
  useEffect(() => {
    if (!pendingChatInsert) return;
    if (pendingChatInsert.threadId !== threadId) return;
    setInput((prev) => {
      const separator = prev && !prev.endsWith('\n') ? '\n' : '';
      return prev + separator + pendingChatInsert.text;
    });
    setPendingChatInsert(null);
    textareaRef.current?.focus();
  }, [pendingChatInsert, setPendingChatInsert, threadId]);

  const filteredCatOptions = useMemo(() => {
    if (!mentionFilter) return catOptions;
    const lower = mentionFilter.toLowerCase();
    return catOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lower) ||
        opt.insert.toLowerCase().includes(lower) ||
        opt.id.toLowerCase().includes(lower),
    );
  }, [catOptions, mentionFilter]);

  const activeMenu = showMentions ? 'mention' : showGameMenu ? 'game' : null;
  const gameMenuItems = gameStep === 'list' ? GAME_LIST : WEREWOLF_MODES;
  const activeOptions = activeMenu === 'mention' ? filteredCatOptions : (gameMenuItems as unknown as CatOption[]);

  const addHistoryEntry = useInputHistoryStore((s) => s.addEntry);
  const findHistoryMatch = useInputHistoryStore((s) => s.findMatch);

  // F080-P2: path completion
  const pathCompletion = usePathCompletion(input);

  const doSend = useCallback(
    async (deliveryMode?: DeliveryMode) => {
      if (sendTemporarilyDisabled) return;
      if (whisperMode && whisperTargets.size === 0) return;
      const trimmed = input.trim();
      const hasPayload = trimmed.length > 0 || images.length > 0 || attachments.length > 0;
      if (hasPayload && !disabled) {
        if (trimmed) addHistoryEntry(trimmed);
        const fallbackContent = attachments.length > 0 ? '上传文件' : '上传图片';
        const userContent = trimmed || fallbackContent;
        const contentToSend = selectedPromptPrefix.prefix
          ? `${selectedPromptPrefix.prefix}\n\n用户原始需求：\n${userContent}`
          : userContent;
        const whisper =
          whisperMode && whisperTargets.size > 0
            ? { visibility: 'whisper' as const, whisperTo: [...whisperTargets] }
            : undefined;
        const sendImages = images.length > 0 ? images : undefined;
        const sendAttachments = attachments.length > 0 ? attachments : undefined;
        setInput('');
        ghostRef.current = null;
        setGhostSuggestion(null);
        setImages([]);
        setAttachments([]);
        setShowMentions(false);
        setShowGameMenu(false);
        setShowPromptPrefixMenu(false);
        setSendAsTask(false);
        if (selectedPromptPrefix.prefix) updatePromptPrefix('none');

        const sendResult = await onSend(contentToSend, sendImages, sendAttachments, whisper, deliveryMode);
        const sentMessageId =
          typeof sendResult === 'string'
            ? sendResult
            : sendResult && typeof sendResult.userMessageId === 'string'
              ? sendResult.userMessageId
              : undefined;

        if (sendAsTask && sentMessageId && threadId) {
          try {
            const res = await apiFetch('/api/tasks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                threadId,
                title: (trimmed || attachments[0]?.name || fallbackContent).slice(0, 100),
                why: '',
                createdBy: 'user',
                sourceMessageId: sentMessageId,
              }),
            });
            if (res.ok) {
              const task = (await res.json()) as TaskItem;
              useTaskStore.getState().addTask(task);
            }
          } catch {
            // Message send already succeeded. Task creation can be retried from the task panel later.
          }
        }
      }
    },
    [
      input,
      disabled,
      onSend,
      images,
      attachments,
      sendTemporarilyDisabled,
      whisperMode,
      whisperTargets,
      addHistoryEntry,
      sendAsTask,
      threadId,
      selectedPromptPrefix,
      updatePromptPrefix,
    ],
  );

  const handleSend = useCallback(() => doSend(undefined), [doSend]);
  const handlePrimarySend = useCallback(() => {
    handleSend();
  }, [handleSend]);

  const closeMenus = useCallback(() => {
    setShowMentions(false);
    setShowGameMenu(false);
    setShowSlashCommands(false);
  }, []);

  const [gameStarting, setGameStarting] = useState(false);

  const startGame = useCallback(
    async (payload: GameStartPayload) => {
      closeMenus();
      if (disabled || sendTemporarilyDisabled || gameStarting) return;
      setGameStarting(true);
      try {
        const res = await apiFetch('/api/game/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          useChatStore.getState().addMessage({
            id: `game-err-${Date.now()}`,
            type: 'system',
            variant: 'error',
            content: `开局失败: ${data.error ?? `HTTP ${res.status}`}`,
            timestamp: Date.now(),
          });
          // Restore lobby so user can retry without re-selecting
          setLobbyMode(payload.humanRole);
          return;
        }
        // Success — dismiss lobby and navigate
        setLobbyMode(null);
        pushThreadRouteWithHistory(data.gameThreadId, typeof window !== 'undefined' ? window : undefined);
        // Hydrate game state immediately (socket reconnect won't fire for same connection)
        reconnectGame(data.gameThreadId).catch(() => {});
      } catch (err) {
        useChatStore.getState().addMessage({
          id: `game-err-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `开局失败: ${err instanceof Error ? err.message : '网络异常'}`,
          timestamp: Date.now(),
        });
        // Restore lobby so user can retry
        setLobbyMode(payload.humanRole);
      } finally {
        setGameStarting(false);
      }
    },
    [closeMenus, disabled, sendTemporarilyDisabled, gameStarting],
  );

  const insertMention = useCallback(
    (option: CatOption) => {
      const before = input.slice(0, mentionStart);
      const after = input.slice(textareaRef.current?.selectionStart ?? mentionStart + 1);
      setInput(before + option.insert + after);
      setShowMentions(false);
      setMentionStart(-1);
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [input, mentionStart],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInput(val);
      const slashQuery = detectSlashCommand(val, e.target.selectionStart);
      if (slashQuery !== null) {
        setShowSlashCommands(true);
        setSlashQuery(slashQuery);
        setSlashSelectedIdx(0);
        setShowMentions(false);
        setShowGameMenu(false);
        return;
      }
      const trigger = detectMenuTrigger(val, e.target.selectionStart);
      if (trigger?.type === 'game') {
        setShowSlashCommands(false);
        setShowGameMenu(true);
        setGameStep('list');
        setShowMentions(false);
        setSelectedIdx(0);
      } else if (trigger?.type === 'mention') {
        setShowSlashCommands(false);
        setShowMentions(true);
        setShowGameMenu(false);
        setMentionStart(trigger.start);
        setMentionFilter(trigger.filter);
        setSelectedIdx(0);
      } else {
        closeMenus();
        setMentionFilter('');
      }
    },
    [closeMenus],
  );

  const insertSlashCommand = useCallback(
    (item: SlashCommandItem) => {
      const rest = input.replace(/^\/[^\s]*/, '');
      const next = `${item.command}${rest}`;
      setInput(next);
      setShowSlashCommands(false);
      setSlashQuery('');
      setSlashSelectedIdx(0);
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(item.command.length, item.command.length);
      }, 0);
    },
    [input],
  );

  const handleHistorySelect = useCallback(
    (text: string) => {
      setInput(text);
      setShowHistorySearch(false);
      ghostRef.current = null;
      setGhostSuggestion(null);
      closeMenus();
      setMentionFilter('');
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [closeMenus],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ime.isComposing()) return;

    // F080: Ctrl+R opens history search (clear any active menus first)
    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      closeMenus();
      setMentionFilter('');
      setShowHistorySearch(true);
      return;
    }

    if (showSlashCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (slashItems.length > 0) setSlashSelectedIdx((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (slashItems.length > 0) setSlashSelectedIdx((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = slashItems[slashSelectedIdx];
        if (item) insertSlashCommand(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashCommands(false);
        return;
      }
    }

    if (activeMenu) {
      if (activeOptions.length === 0) {
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab' || e.key === 'Escape') {
          e.preventDefault();
        }
        closeMenus();
        setMentionFilter('');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % activeOptions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + activeOptions.length) % activeOptions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (activeMenu === 'mention') {
          const opt = filteredCatOptions[selectedIdx];
          if (!opt) {
            closeMenus();
            return;
          }
          insertMention(opt);
        } else if (gameStep === 'list') {
          // Layer 1: drill into mode selection
          setGameStep('modes');
          setSelectedIdx(0);
        } else {
          // Layer 2: open lobby for mode configuration
          const mode = WEREWOLF_MODES[selectedIdx];
          const role = mode.id === 'detective' ? 'detective' : mode.id.startsWith('god') ? 'god-view' : 'player';
          closeMenus();
          setLobbyMode(role as 'player' | 'god-view' | 'detective');
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenus();
        return;
      }
    }

    // F080-P2: path completion menu keyboard navigation
    if (pathCompletion.isOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        pathCompletion.setSelectedIdx((pathCompletion.selectedIdx + 1) % pathCompletion.entries.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        pathCompletion.setSelectedIdx(
          (pathCompletion.selectedIdx - 1 + pathCompletion.entries.length) % pathCompletion.entries.length,
        );
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const entry = pathCompletion.entries[pathCompletion.selectedIdx];
        if (entry) {
          const newText = pathCompletion.selectEntry(entry);
          setInput(newText);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pathCompletion.close();
        return;
      }
    }

    // F080: Tab or ArrowRight accepts ghost suggestion (only when no menu is active)
    // ArrowRight only accepts when cursor is at end of input (no selection)
    if (e.key === 'Tab' || e.key === 'ArrowRight') {
      const ta = textareaRef.current;
      const currentVal = ta?.value ?? '';
      const cursorAtEnd = !ta || (ta.selectionStart === ta.selectionEnd && ta.selectionStart === currentVal.length);
      if (e.key === 'ArrowRight' && !cursorAtEnd) {
        // Let ArrowRight move cursor normally when not at end
      } else {
        const match = useInputHistoryStore.getState().findMatch(currentVal);
        if (match) {
          e.preventDefault();
          setInput(match);
          ghostRef.current = null;
          setGhostSuggestion(null);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const capacity = MAX_ATTACHMENTS_PER_MESSAGE - images.length - attachments.length;
      if (capacity <= 0) {
        showAttachmentError(`每条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
        e.target.value = '';
        return;
      }
      setIsPreparingImages(true);
      try {
        const toAdd: File[] = [];
        let rejectedTooLarge = 0;
        let rejectedType = 0;
        for (let i = 0; i < files.length && toAdd.length < capacity; i++) {
          const file = files[i];
          if (!ACCEPTED_IMAGE_TYPE_SET.has(file.type)) {
            rejectedType += 1;
            continue;
          }
          if (file.size > MAX_ATTACHMENT_BYTES) {
            rejectedTooLarge += 1;
            continue;
          }
          toAdd.push(await compressImage(file));
        }
        if (rejectedType > 0 || rejectedTooLarge > 0 || files.length > capacity) {
          const reasons = [
            rejectedType > 0 ? `${rejectedType} 个图片类型不支持` : '',
            rejectedTooLarge > 0 ? `${rejectedTooLarge} 个文件超过 10MB` : '',
            files.length > capacity ? `最多还能添加 ${capacity} 个附件` : '',
          ].filter(Boolean);
          showAttachmentError(reasons.join('，'));
        }
        setImages((prev) => [...prev, ...toAdd].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
      } finally {
        setIsPreparingImages(false);
      }
      e.target.value = '';
    },
    [attachments.length, images.length, showAttachmentError],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      const capacity = MAX_ATTACHMENTS_PER_MESSAGE - images.length - attachments.length;
      if (capacity <= 0) {
        showAttachmentError(`每条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
        return;
      }
      setIsPreparingImages(true);
      try {
        const toAdd: File[] = [];
        let rejectedTooLarge = 0;
        let rejectedType = 0;
        for (const file of imageFiles) {
          if (toAdd.length >= capacity) break;
          if (!ACCEPTED_IMAGE_TYPE_SET.has(file.type)) {
            rejectedType += 1;
            continue;
          }
          if (file.size > MAX_ATTACHMENT_BYTES) {
            rejectedTooLarge += 1;
            continue;
          }
          toAdd.push(await compressImage(file));
        }
        if (rejectedType > 0 || rejectedTooLarge > 0 || imageFiles.length > capacity) {
          const reasons = [
            rejectedType > 0 ? `${rejectedType} 个图片类型不支持` : '',
            rejectedTooLarge > 0 ? `${rejectedTooLarge} 个文件超过 10MB` : '',
            imageFiles.length > capacity ? `最多还能添加 ${capacity} 个附件` : '',
          ].filter(Boolean);
          showAttachmentError(reasons.join('，'));
        }
        setImages((prev) => [...prev, ...toAdd].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
      } finally {
        setIsPreparingImages(false);
      }
    },
    [attachments.length, images.length, showAttachmentError],
  );

  const handleRemoveImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAttachmentSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? []);
      if (selected.length === 0) {
        e.target.value = '';
        return;
      }
      const capacity = MAX_ATTACHMENTS_PER_MESSAGE - images.length - attachments.length;
      if (capacity <= 0) {
        showAttachmentError(`每条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
        e.target.value = '';
        return;
      }
      const accepted: File[] = [];
      let rejectedTooLarge = 0;
      for (const file of selected) {
        if (accepted.length >= capacity) break;
        if (file.size > MAX_ATTACHMENT_BYTES) {
          rejectedTooLarge += 1;
          continue;
        }
        accepted.push(file);
      }
      if (rejectedTooLarge > 0 || selected.length > capacity) {
        const reasons = [
          rejectedTooLarge > 0 ? `${rejectedTooLarge} 个文件超过 10MB` : '',
          selected.length > capacity ? `最多还能添加 ${capacity} 个附件` : '',
        ].filter(Boolean);
        showAttachmentError(reasons.join('，'));
      }
      if (accepted.length > 0) {
        setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
      }
      e.target.value = '';
    },
    [attachments.length, images.length, showAttachmentError],
  );

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const toggleWhisperTarget = useCallback((catId: string) => {
    setWhisperTargets((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }, []);

  // Clamp selectedIdx when catOptions shrink — only when mention menu is active.
  // selectedIdx is shared by mention/game menus; clamping to catOptions.length
  // when game menu is open would corrupt game selection.
  useEffect(() => {
    if (!showMentions) return;
    setSelectedIdx((i) => Math.min(i, Math.max(0, filteredCatOptions.length - 1)));
  }, [filteredCatOptions, showMentions]);

  // Reconcile whisperTargets: remove invalid ids + remove newly-active cats (B10)
  useEffect(() => {
    if (!whisperMode) return;
    const validIds = new Set(whisperCats.map((c) => c.id));
    setWhisperTargets((prev) => {
      const filtered = new Set([...prev].filter((id) => validIds.has(id) && !activeCatIds.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [whisperCats, whisperMode, activeCatIds]);

  // Sync input text + images to module-level draft maps (covers all sources: typing, voice, mentions)
  // useLayoutEffect runs synchronously before browser paint and before unmount,
  // ensuring the draft is written to the Map before the component is destroyed
  // on thread switch (key={threadId}). useEffect would lose the final keystroke.
  useLayoutEffect(() => {
    if (!threadId) return;
    const hasDraft = input.trim().length > 0 || images.length > 0 || attachments.length > 0;
    if (input) threadDrafts.set(threadId, input);
    else threadDrafts.delete(threadId);
    if (images.length > 0) {
      threadImageDrafts.delete(threadId); // move to end (Map insertion order)
      threadImageDrafts.set(threadId, images);
      // LRU eviction: keep only the most recent N threads with image drafts
      while (threadImageDrafts.size > MAX_IMAGE_DRAFT_THREADS) {
        const oldest = threadImageDrafts.keys().next().value;
        if (oldest !== undefined) {
          threadImageDrafts.delete(oldest);
          setThreadHasDraft(oldest, hasPendingThreadDraft(oldest));
        }
      }
    } else {
      threadImageDrafts.delete(threadId);
    }
    if (attachments.length > 0) {
      threadFileDrafts.delete(threadId);
      threadFileDrafts.set(threadId, attachments);
      while (threadFileDrafts.size > MAX_IMAGE_DRAFT_THREADS) {
        const oldest = threadFileDrafts.keys().next().value;
        if (oldest !== undefined) {
          threadFileDrafts.delete(oldest);
          setThreadHasDraft(oldest, hasPendingThreadDraft(oldest));
        }
      }
    } else {
      threadFileDrafts.delete(threadId);
    }
    setThreadHasDraft(threadId, hasDraft);
  }, [input, images, attachments, threadId, setThreadHasDraft]);

  // F080: recalculate ghost suggestion whenever input changes (covers all setInput paths)
  useEffect(() => {
    const match = input.trim() ? findHistoryMatch(input) : null;
    ghostRef.current = match;
    setGhostSuggestion(match);
  }, [input, findHistoryMatch]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const isMobile = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)').matches : false;
    const maxH = isMobile ? 120 : 200; // ~5 lines mobile, ~8 lines desktop
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }, [input]);

  useEffect(() => {
    if (!activeMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // React 18 may flush state synchronously during event bubbling,
      // detaching the original target (e.g. layer 1 unmounts when drilling
      // into layer 2). A detached target is not a genuine outside click.
      if (!target.isConnected) return;
      if (menuRef.current && !menuRef.current.contains(target) && !gameBtnRef.current?.contains(target)) {
        closeMenus();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeMenu, closeMenus]);

  useEffect(() => {
    if (!showPromptPrefixMenu) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!target.isConnected) return;
      if (promptPrefixMenuRef.current && !promptPrefixMenuRef.current.contains(target)) {
        setShowPromptPrefixMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPromptPrefixMenu]);

  return (
    <div className="slock-composer-shell relative border-t border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] safe-area-bottom">

      {pathCompletion.isOpen && !activeMenu && !showSlashCommands && (
        <PathCompletionMenu
          entries={pathCompletion.entries}
          selectedIdx={pathCompletion.selectedIdx}
          onSelectIdx={pathCompletion.setSelectedIdx}
          onSelect={(entry) => {
            const newText = pathCompletion.selectEntry(entry);
            setInput(newText);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
        />
      )}

      <ChatInputMenus
        catOptions={filteredCatOptions}
        showMentions={showMentions}
        showGameMenu={showGameMenu}
        gameStep={gameStep}
        onGameStepChange={setGameStep}
        selectedIdx={selectedIdx}
        onSelectIdx={setSelectedIdx}
        onInsertMention={insertMention}
        onSendCommand={(command) => {
          // Open lobby instead of sending directly
          const role = command.includes('detective')
            ? 'detective'
            : command.includes('god-view')
              ? 'god-view'
              : 'player';
          closeMenus();
          setLobbyMode(role as 'player' | 'god-view' | 'detective');
        }}
        menuRef={menuRef}
        catStatuses={catStatuses}
      />

      {whisperMode && !showMentions && !showGameMenu && (
        <WhisperCatSelector
          cats={whisperCats}
          selected={whisperTargets}
          activeCatIds={activeCatIds}
          onToggle={toggleWhisperTarget}
        />
      )}

      {imageLifecycleStatus === 'preparing' && (
        <div className="px-4 pt-2 text-xs text-cafe-secondary" role="status">
          图片处理中，完成后可发送
        </div>
      )}
      {imageLifecycleStatus === 'uploading' && (
        <div className="px-4 pt-2 text-xs text-cocreator-primary" role="status">
          图片上传中，请稍候...
        </div>
      )}
      {imageLifecycleStatus === 'failed' && uploadError && (
        <div className="px-4 pt-2 text-xs text-conn-red-text" role="alert">
          图片发送失败：{uploadError}
        </div>
      )}

      {whisperMode && (
        <WhisperTargetChips cats={whisperCats} selected={whisperTargets} onToggle={toggleWhisperTarget} />
      )}

      <ImagePreview files={images} onRemove={handleRemoveImage} />

      {attachments.length > 0 && (
        <div className="mx-4 mb-2 flex flex-wrap gap-2">
          {attachments.map((file, index) => (
            <div
              key={`${file.name}-${file.size}-${index}`}
              className="flex max-w-[240px] items-center gap-2 rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-2 py-1.5 text-xs text-cafe-primary"
            >
              <span className="shrink-0 rounded bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-[10px] text-cafe-muted">
                FILE
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{file.name}</span>
                <span className="block text-cafe-muted">{formatFileSize(file.size)}</span>
              </span>
              <button
                type="button"
                onClick={() => handleRemoveAttachment(index)}
                className="shrink-0 rounded px-1 text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-primary"
                aria-label={`移除文件 ${file.name}`}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
      <input ref={attachmentInputRef} type="file" multiple className="hidden" onChange={handleAttachmentSelect} />

      {/* Mobile expanded toolbar (above input row) */}
      {mobileToolbar && (
        <MobileInputToolbar
          onAttach={() => attachmentInputRef.current?.click()}
          onClose={() => setMobileToolbar(false)}
          disabled={disabled}
          sendDisabled={sendTemporarilyDisabled}
          maxImages={hasReachedAttachmentLimit}
        />
      )}

      <div className="flex items-center gap-2 px-4 pb-3 pt-1.5">
        {/* Mobile: + toggle button */}
        <button
          onClick={() => setMobileToolbar((v) => !v)}
          className={`p-3 rounded-xl transition-all md:hidden ${
            mobileToolbar
              ? 'rotate-45 bg-[var(--console-active-bg)] text-cafe-accent'
              : 'text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent'
          }`}
          aria-label="展开工具栏"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <div
          className={`slock-composer-frame group relative flex min-h-[var(--slock-input-height-min)] flex-1 flex-col rounded-[var(--slock-radius-lg)] border bg-[var(--clowder-input-bg)] transition-colors focus-within:ring-1 ${
            whisperMode
              ? 'border-conn-amber-text/30 bg-conn-amber-bg/50 focus-within:ring-conn-amber-text'
              : 'border-[var(--console-input-stroke)] focus-within:ring-[var(--console-input-stroke)]'
          }`}
          data-bootcamp-step="chat-input"
          data-guide-id="chat.input"
        >
          {showSlashCommands && (
            <SlashCommandPicker
              query={slashQuery}
              selectedIdx={slashSelectedIdx}
              onSelectIdx={setSlashSelectedIdx}
              onPick={insertSlashCommand}
              onItemsChange={setSlashItems}
            />
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onPaste={handlePaste}
            placeholder={
              whisperMode
                ? '悄悄话...'
                : '输入消息 #当前对话'
            }
            className="max-h-[260px] min-h-[2.75rem] flex-1 resize-none bg-transparent px-3 pt-2.5 pb-1 [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-body)] text-cafe-text placeholder:text-cafe-muted focus:outline-none"
            rows={1}
            disabled={disabled}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1 border-t border-transparent">
            <div className="hidden items-center gap-1 md:flex">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || sendTemporarilyDisabled || hasReachedAttachmentLimit}
                className="slock-tool-button flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="上传图片"
                title="上传图片"
              >
                <ImageUploadIcon className="h-[18px] w-[18px]" />
              </button>

              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={disabled || sendTemporarilyDisabled || hasReachedAttachmentLimit}
                className="slock-tool-button flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="上传文件"
                title="上传文件"
              >
                <AttachIcon className="h-[18px] w-[18px]" />
              </button>
            </div>

            <div className="ml-auto flex items-center gap-1">
              <label
                className="slock-inline-control hidden cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-text md:flex"
                title="发送后创建任务"
              >
                <input
                  type="checkbox"
                  checked={sendAsTask}
                  onChange={(event) => setSendAsTask(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--console-input-stroke)]"
                />
                <span className="whitespace-nowrap">As Task</span>
              </label>

              <div ref={promptPrefixMenuRef} className="relative hidden md:block">
                <button
                  type="button"
                  onClick={() => {
                    closeMenus();
                    setShowPromptPrefixMenu((open) => !open);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={showPromptPrefixMenu}
                  title="选择发送前自动追加的提示词前缀"
                  className={`slock-inline-control flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors ${
                    selectedPromptPrefix.id !== 'none'
                      ? 'bg-[var(--console-input-stroke)] text-[var(--cafe-surface)]'
                      : 'text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe-text'
                  }`}
                >
                  <span aria-hidden="true">⌁</span>
                  <span className="whitespace-nowrap">{selectedPromptPrefix.shortLabel}</span>
                </button>

                {showPromptPrefixMenu && (
                  <div
                    role="menu"
                    className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-[var(--slock-border-color)] bg-[var(--cafe-surface)] p-1 shadow-[var(--clowder-shadow-medium)]"
                    data-testid="prompt-prefix-menu"
                  >
                    {PROMPT_PREFIX_OPTIONS.map((option) => {
                      const selected = option.id === selectedPromptPrefix.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            updatePromptPrefix(option.id);
                            setShowPromptPrefixMenu(false);
                            textareaRef.current?.focus();
                          }}
                          className={`flex w-full flex-col rounded-lg border-l-2 px-3 py-2 text-left transition-colors ${
                            selected
                              ? 'border-[var(--console-active-fg)] bg-[var(--console-active-bg)] text-[var(--console-active-fg)]'
                              : 'border-transparent text-cafe-text hover:bg-[var(--console-hover-bg)]'
                          }`}
                        >
                          <span className="text-xs font-semibold">{option.label}</span>
                          <span
                            className={`mt-0.5 text-[11px] leading-snug ${
                              selected ? 'text-[var(--console-active-muted)]' : 'text-cafe-muted'
                            }`}
                          >
                            {option.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {activeUiReady && !disabled && onStop && (
                <button
                  type="button"
                  onClick={() => onStop()}
                  className="slock-tool-button slock-stop-button flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--console-stop)] text-[var(--cafe-surface)] transition-colors hover:opacity-80"
                  title="停止生成"
                  aria-label="Stop generation"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <rect x="4" y="4" width="12" height="12" rx="2" />
                  </svg>
                </button>
              )}

              <button
                type="button"
                onClick={handlePrimarySend}
                disabled={Boolean(disabled || sendTemporarilyDisabled || !input.trim())}
                className="slock-tool-button slock-send-button flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--console-input-stroke)] text-[var(--cafe-surface)] transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                title="发送消息"
                aria-label="Send message"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 2L11 13" />
                  <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                </svg>
              </button>
            </div>
          </div>
          {ghostSuggestion && !pathCompletion.isOpen && (
            <div
              data-testid="ghost-suggestion"
              className="absolute inset-0 pointer-events-none p-3 text-sm whitespace-pre-wrap break-words overflow-hidden rounded-xl"
              aria-hidden="true"
            >
              <span className="invisible">{input}</span>
              <span className="text-cafe-muted">{ghostSuggestion.slice(input.length)}</span>
            </div>
          )}
        </div>

      </div>

      {showHistorySearch && (
        <HistorySearchModal onSelect={handleHistorySelect} onClose={() => setShowHistorySearch(false)} />
      )}

      {lobbyMode && (
        <GameLobby
          mode={lobbyMode}
          cats={cats}
          onConfirm={(payload) => {
            startGame(payload);
          }}
          onCancel={() => setLobbyMode(null)}
        />
      )}
    </div>
  );
}
