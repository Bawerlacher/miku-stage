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
   * Appends a new message and applies trim/scroll side effects.
   * @param role Message role to append.
   * @param text Message text to append.
   * @param streaming Whether this message is currently streaming.
   * @returns Nothing.
   */
  function appendChatMessage(role: ChatRole, text: string, streaming = false) {
    chatMessages.value.push(createChatMessage(role, text, streaming))
    trimChatMessages()
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
    bindChatLog,
    appendAssistantDelta,
    finalizeAssistantMessage,
    submitUserText,
  }
}
