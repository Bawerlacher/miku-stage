/**
 * Chat UI state/composable for rendering, streaming, and sending stage messages.
 */
import { nextTick, ref } from 'vue'

export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  streaming?: boolean
}

const CHAT_HISTORY_STORAGE_PREFIX = 'miku-stage.chatHistory'
const CHAT_HISTORY_MAX_SESSIONS = 24
const CHAT_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

/**
 * Builds reactive chat UI state and helpers for message flow/streaming.
 * @param maxMessages Maximum number of messages to keep in memory.
 * @returns Chat state refs and mutation helpers used by the stage UI.
 */
export function useStageChat(maxMessages = 80) {
  const chatInput = ref('')
  const chatMessages = ref<ChatMessage[]>([])
  const chatLog = ref<HTMLDivElement | null>(null)

  let chatMessageSeq = 0
  let activeAssistantMessageId: string | null = null
  let activeAssistantRunId: string | null = null
  let activeSessionId: string | null = null

  /**
   * Creates a chat message object with a sequential local ID.
   * @param role Message role to render.
   * @param text Message body text.
   * @param streaming Whether the message is still streaming.
   * @returns Normalized message record.
   */
  function createChatMessage(role: ChatRole, text: string, streaming = false): ChatMessage {
    chatMessageSeq += 1
    return {
      id: `msg-${chatMessageSeq}`,
      role,
      text,
      streaming,
    }
  }

  /**
   * Drops oldest messages when history exceeds the configured cap.
   * @returns Nothing.
   */
  function trimChatMessages() {
    // Keep chat history bounded so long sessions do not grow memory unbounded.
    const overflow = chatMessages.value.length - maxMessages
    if (overflow > 0) {
      chatMessages.value.splice(0, overflow)
    }
  }

  /**
   * Scrolls the message container to the latest entry on next DOM tick.
   * @returns Nothing.
   */
  function queueChatScroll() {
    // Scroll after DOM updates so new messages are visible immediately.
    void nextTick(() => {
      if (!chatLog.value) {
        return
      }
      chatLog.value.scrollTop = chatLog.value.scrollHeight
    })
  }

  /**
   * Stores the message container element used for auto-scroll.
   * @param element Template ref payload from Vue.
   * @returns Nothing.
   */
  function bindChatLog(element: unknown) {
    chatLog.value = element instanceof HTMLDivElement ? element : null
  }

  /**
   * Builds localStorage key for a stage session chat history snapshot.
   * @param sessionId Stage session identifier.
   * @returns Storage key string.
   */
  function getSessionHistoryStorageKey(sessionId: string) {
    return `${CHAT_HISTORY_STORAGE_PREFIX}:${sessionId}`
  }

  /**
   * Saves current chat history snapshot for the active session.
   * @returns Nothing.
   */
  function persistChatHistory() {
    if (!activeSessionId) {
      return
    }

    try {
      const entries = chatMessages.value.map((message) => ({
        role: message.role,
        text: message.text,
      }))
      window.localStorage.setItem(
        getSessionHistoryStorageKey(activeSessionId),
        JSON.stringify({
          v: 1,
          entries,
          updatedAtMs: Date.now(),
        }),
      )
    } catch {
      // Ignore storage failures in private/restricted browser contexts.
    }
  }

  /**
   * Removes invalid/stale/overflow chat-history entries from localStorage.
   * @returns Nothing.
   */
  function pruneStoredChatHistory() {
    try {
      const now = Date.now()
      const entries: Array<{ key: string; updatedAtMs: number }> = []
      const historyKeys: string[] = []

      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index)
        if (key && key.startsWith(`${CHAT_HISTORY_STORAGE_PREFIX}:`)) {
          historyKeys.push(key)
        }
      }

      for (const key of historyKeys) {
        const raw = window.localStorage.getItem(key)
        if (!raw) {
          window.localStorage.removeItem(key)
          continue
        }

        let parsed: { updatedAtMs?: unknown } | null = null
        try {
          parsed = JSON.parse(raw) as { updatedAtMs?: unknown }
        } catch {
          window.localStorage.removeItem(key)
          continue
        }

        const updatedAtMs =
          typeof parsed?.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
            ? parsed.updatedAtMs
            : 0

        if (!updatedAtMs || now - updatedAtMs > CHAT_HISTORY_MAX_AGE_MS) {
          window.localStorage.removeItem(key)
          continue
        }

        entries.push({ key, updatedAtMs })
      }

      if (entries.length <= CHAT_HISTORY_MAX_SESSIONS) {
        return
      }

      const overflow = [...entries]
        .sort((left, right) => left.updatedAtMs - right.updatedAtMs)
        .slice(0, entries.length - CHAT_HISTORY_MAX_SESSIONS)

      for (const entry of overflow) {
        window.localStorage.removeItem(entry.key)
      }
    } catch {
      // Ignore cleanup failures in restricted browser contexts.
    }
  }

  /**
   * Loads chat history snapshot for a session and replaces current messages.
   * @param sessionId Stage session identifier.
   * @returns Nothing.
   */
  function loadChatHistory(sessionId: string) {
    let loadedMessages: ChatMessage[] = []

    try {
      const raw = window.localStorage.getItem(getSessionHistoryStorageKey(sessionId))
      if (raw) {
        const parsed = JSON.parse(raw) as {
          entries?: Array<{ role?: unknown; text?: unknown }>
        }
        const persistedEntries = Array.isArray(parsed?.entries) ? parsed.entries : []
        loadedMessages = []
        for (const [index, entry] of persistedEntries.entries()) {
          if (
            (entry.role === 'user' || entry.role === 'assistant' || entry.role === 'system') &&
            typeof entry.text === 'string'
          ) {
            loadedMessages.push({
              id: `msg-${index + 1}`,
              role: entry.role,
              text: entry.text,
              streaming: false,
            })
          }
        }
      }
    } catch {
      loadedMessages = []
    }

    chatMessages.value = loadedMessages
    chatMessageSeq = loadedMessages.length
    activeAssistantMessageId = null
    activeAssistantRunId = null
    trimChatMessages()
    queueChatScroll()
  }

  /**
   * Binds chat state to one stage session and restores its history snapshot.
   * @param sessionId Stage session identifier.
   * @returns Nothing.
   */
  function setSessionId(sessionId: string) {
    const trimmed = sessionId.trim()
    if (!trimmed || trimmed === activeSessionId) {
      return
    }

    pruneStoredChatHistory()
    activeSessionId = trimmed
    loadChatHistory(trimmed)
  }

  /**
   * Appends a new message and applies trim/scroll side effects.
   * @param role Message role to append.
   * @param text Message text to append.
   * @param streaming Whether this message is currently streaming.
   * @returns Nothing.
   */
  function appendChatMessage(role: ChatRole, text: string, streaming = false) {
    chatMessages.value.push(createChatMessage(role, text, streaming))
    trimChatMessages()
    persistChatHistory()
    queueChatScroll()
  }

  /**
   * Appends assistant stream chunks to the active assistant message.
   * @param payload Delta payload with optional run identifier.
   * @returns Nothing.
   */
  function appendAssistantDelta(payload: { text: string; runId?: string }) {
    if (!payload.text) {
      return
    }

    // If run IDs switch, start a fresh message so concurrent runs don't merge content.
    const shouldStartNewMessage =
      !activeAssistantMessageId ||
      (payload.runId && activeAssistantRunId && payload.runId !== activeAssistantRunId)

    if (shouldStartNewMessage) {
      appendChatMessage('assistant', payload.text, true)
      const latest = chatMessages.value[chatMessages.value.length - 1]
      activeAssistantMessageId = latest?.id ?? null
      activeAssistantRunId = payload.runId ?? null
      return
    }

    const target = chatMessages.value.find((message) => message.id === activeAssistantMessageId)
    if (!target) {
      appendChatMessage('assistant', payload.text, true)
      const latest = chatMessages.value[chatMessages.value.length - 1]
      activeAssistantMessageId = latest?.id ?? null
      activeAssistantRunId = payload.runId ?? null
      return
    }

    target.text += payload.text
    target.streaming = true
    queueChatScroll()
  }

  /**
   * Marks the active assistant message complete or appends a fallback message.
   * @param payload Final assistant payload with optional run identifier.
   * @returns Nothing.
   */
  function finalizeAssistantMessage(payload: { text: string; runId?: string }) {
    if (payload.runId && activeAssistantRunId && payload.runId !== activeAssistantRunId) {
      appendChatMessage('assistant', payload.text, false)
      return
    }

    const active = activeAssistantMessageId
      ? chatMessages.value.find((message) => message.id === activeAssistantMessageId)
      : null

    if (active) {
      if (payload.text && !active.text) {
        active.text = payload.text
      }
      active.streaming = false
      activeAssistantMessageId = null
      activeAssistantRunId = null
      persistChatHistory()
      queueChatScroll()
      return
    }

    if (payload.text) {
      appendChatMessage('assistant', payload.text, false)
    }
  }

  /**
   * Submits trimmed user input through the provided transport callback.
   * @param send Sender callback; returns true when message is dispatched.
   * @returns Nothing.
   */
  function submitUserText(send: (text: string) => boolean) {
    const text = chatInput.value.trim()
    if (!text) {
      return
    }

    appendChatMessage('user', text)
    chatInput.value = ''
    const sent = send(text)
    if (!sent) {
      // Show a local fallback instead of silently dropping the user message.
      appendChatMessage('system', 'Not connected. Message was not sent.')
    }
  }

  return {
    chatInput,
    chatMessages,
    setSessionId,
    bindChatLog,
    appendAssistantDelta,
    finalizeAssistantMessage,
    submitUserText,
  }
}
