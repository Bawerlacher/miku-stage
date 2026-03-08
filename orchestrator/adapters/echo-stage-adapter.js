/**
 * Development backend adapter that simulates assistant streaming for user text.
 */
import crypto from 'node:crypto'

/**
 * Creates the default local echo adapter implementation.
 * @returns {{ name: string, onUserText: (input: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>, void, void> }} Adapter implementation.
 */
export function createEchoStageAdapter() {
  return {
    name: 'echo',

    /**
     * Handles inbound user text and yields simulated assistant + motion events.
     * @param {{ text?: string }} input Adapter request context and message payload.
     * @returns {AsyncGenerator<Record<string, unknown>, void, void>} Stream of adapter events.
     */
    async *onUserText(input) {
      const userText = typeof input?.text === 'string' ? input.text : ''
      const reply = `I heard: ${userText}`
      const [firstChunk, secondChunk] = splitForStreaming(reply)
      const runId = crypto.randomUUID()

      if (firstChunk) {
        yield {
          type: 'assistant_text_delta',
          runId,
          text: firstChunk,
        }
      }

      await sleep(90)

      if (secondChunk) {
        yield {
          type: 'assistant_text_delta',
          runId,
          text: secondChunk,
        }
      }

      yield {
        type: 'assistant_text_done',
        runId,
        text: reply,
      }

      const motion = pickMotionFromText(userText)
      if (motion) {
        yield {
          type: 'stage_command',
          command: 'model_motion',
          payload: {
            motion,
          },
        }
      }
    },
  }
}

/**
 * Splits a string into two chunks so streaming behavior is visible in the UI.
 * @param {string} text Full assistant text response.
 * @returns {[string, string]} Pair of first and second stream chunks.
 */
function splitForStreaming(text) {
  const midpoint = Math.ceil(text.length / 2)
  return [text.slice(0, midpoint), text.slice(midpoint)]
}

/**
 * Selects a simple motion name from user text to demonstrate command mapping.
 * @param {string} text User-entered message.
 * @returns {string | null} Motion name or null when no motion should be emitted.
 */
function pickMotionFromText(text) {
  if (!text) {
    return null
  }

  if (/\b(no|nope|nah|not|never|don't|dont)\b/i.test(text)) {
    return 'negate'
  }

  if (/\b(yes|yep|sure|ok|okay|thanks|great)\b/i.test(text)) {
    return 'confirm'
  }

  return null
}

/**
 * Suspends execution for a short interval.
 * @param {number} delayMs Milliseconds to sleep.
 * @returns {Promise<void>} Promise resolved after the delay.
 */
function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}
