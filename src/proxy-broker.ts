import { EventEmitter } from "node:events"
import type { ProxyToolCall, ProxyToolResult } from "./proxy-mcp.js"
import { log } from "./logger.js"

export interface PendingProxyCall {
  sessionKey: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

type InternalPending = PendingProxyCall & {
  createdAt: number
  timer: ReturnType<typeof setTimeout>
  resolve(result: ProxyToolResult): void
  reject(error: Error): void
}

const pendingBySession = new Map<string, InternalPending>()
const emitter = new EventEmitter()
const PENDING_PROXY_CALL_TIMEOUT_MS = 10 * 60 * 1000

function eventName(sessionKey: string) {
  return `pending:${sessionKey}`
}

export function onPendingProxyCall(
  sessionKey: string,
  handler: (call: PendingProxyCall) => void,
): () => void {
  const name = eventName(sessionKey)
  emitter.on(name, handler)
  return () => emitter.off(name, handler)
}

export function queuePendingProxyCall(
  sessionKey: string,
  call: ProxyToolCall,
): PendingProxyCall {
  const existing = pendingBySession.get(sessionKey)
  if (existing) {
    if (Date.now() - existing.createdAt < PENDING_PROXY_CALL_TIMEOUT_MS) {
      call.reject(
        new Error(`Another proxy tool call is already pending for ${sessionKey}`),
      )
      log.warn("rejected overlapping proxy call", {
        sessionKey,
        existingToolCallId: existing.toolCallId,
        existingToolName: existing.toolName,
        toolCallId: call.id,
        toolName: call.toolName,
      })
      return existing
    }

    clearTimeout(existing.timer)
    existing.reject(
      new Error(
        `Stale proxy tool call expired after ${PENDING_PROXY_CALL_TIMEOUT_MS}ms for ${sessionKey}`,
      ),
    )
    pendingBySession.delete(sessionKey)
  }

  const timer = setTimeout(() => {
    const current = pendingBySession.get(sessionKey)
    if (!current || current.toolCallId !== call.id) return
    pendingBySession.delete(sessionKey)
    current.reject(
      new Error(
        `Proxy tool call '${call.toolName}' timed out after ${PENDING_PROXY_CALL_TIMEOUT_MS}ms waiting for opencode to resolve the call`,
      ),
    )
    log.warn("timed out pending proxy call", {
      sessionKey,
      toolCallId: call.id,
      toolName: call.toolName,
      timeoutMs: PENDING_PROXY_CALL_TIMEOUT_MS,
    })
  }, PENDING_PROXY_CALL_TIMEOUT_MS)

  const pending: InternalPending = {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    createdAt: Date.now(),
    timer,
    resolve: call.resolve,
    reject: call.reject,
  }
  pendingBySession.set(sessionKey, pending)
  emitter.emit(eventName(sessionKey), pending)
  log.info("queued pending proxy call", {
    sessionKey,
    toolCallId: call.id,
    toolName: call.toolName,
  })
  return pending
}

export function getPendingProxyCall(
  sessionKey: string,
): PendingProxyCall | undefined {
  return pendingBySession.get(sessionKey)
}

export function resolvePendingProxyCall(
  sessionKey: string,
  result: ProxyToolResult,
): boolean {
  const pending = pendingBySession.get(sessionKey)
  if (!pending) return false
  pendingBySession.delete(sessionKey)
  clearTimeout(pending.timer)
  pending.resolve(result)
  log.info("resolved pending proxy call", {
    sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
  })
  return true
}

export function rejectPendingProxyCall(
  sessionKey: string,
  error: Error,
): boolean {
  const pending = pendingBySession.get(sessionKey)
  if (!pending) return false
  pendingBySession.delete(sessionKey)
  clearTimeout(pending.timer)
  pending.reject(error)
  log.warn("rejected pending proxy call", {
    sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    error: error.message,
  })
  return true
}
