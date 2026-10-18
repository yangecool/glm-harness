/**
 * Durable prompt admission: the reconciliation facts behind idempotent
 * `session/prompt` and the `session/admission` query. The durable truth is the
 * Session log itself — a user message whose source carries the client-minted
 * `rpcId`; the in-memory journal only closes the check-then-admit window
 * inside one service life and holds the raw-payload fingerprint that the log
 * never stores.
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionRequestId } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One recorded admission inside the service-local journal. */
export interface PromptAdmissionRecord {
  /** Fingerprint of the raw request payload (mode + content shape). */
  readonly fingerprint: string
  /** Epoch milliseconds the admission completed. */
  readonly admittedAt: number
}

/** Per-Session requestIds retained before the oldest evict in favor of log scans. */
const JOURNAL_PER_SESSION_LIMIT = 4096

/**
 * Fingerprint one prompt request for conflict detection: stable over the
 * delivery mode and the content's text and attachment identities, and
 * deliberately independent of transport ordering noise such as time zones or
 * principals — a different principal resubmitting identical content is a
 * duplicate, not a conflict.
 * @param request - the prompt request as submitted.
 * @returns a hex digest of the request's admission-relevant payload.
 */
export function promptRequestFingerprint(request: Pick<SessionPromptRequest, 'mode' | 'content'>): string {
  const digest = createHash('sha256')
  digest.update(request.mode)
  for (const part of request.content) {
    if (part.type === 'text') {
      digest.update(`t:${part.text.length}:${part.text}`)
    } else if (part.type === 'image') {
      digest.update(`i:${part.mediaType}:${createHash('sha256').update(part.data).digest('hex')}`)
    } else {
      digest.update(`f:${part.receiptId}`)
    }
  }
  return digest.digest('hex')
}

/**
 * Fingerprint the text lane of one prompt request for comparison against an
 * admitted message. Returns undefined when any part is an attachment, because
 * the admitted message stores attachment references rather than upload
 * receipts and the lanes are then not comparable.
 * @param request - the prompt request as submitted.
 * @returns the text-lane digest, or undefined for attachment-bearing requests.
 */
export function promptTextFingerprint(request: Pick<SessionPromptRequest, 'content'>): string | undefined {
  if (request.content.some(part => part.type !== 'text')) return undefined
  const digest = createHash('sha256')
  for (const part of request.content) {
    if (part.type === 'text') digest.update(`t:${part.text.length}:${part.text}`)
  }
  return digest.digest('hex')
}

/** The text-lane view of an admitted message's loosely-typed content. */
type TextPart = { readonly type: string; readonly text?: string }

/**
 * Fingerprint the text lane of one admitted user message for the
 * cross-restart comparison. The message stores admitted attachment references
 * rather than upload receipts, so attachment-bearing messages return
 * undefined and reconcile idempotently instead of guessing.
 * @param message - the admitted message recovered from the inbox or the log.
 * @returns the text-lane digest, or undefined when not verifiable.
 */
export function admittedMessageFingerprint(message: UserMessage): string | undefined {
  const parts = (Array.isArray(message.content) ? message.content : []) as readonly TextPart[]
  if (parts.some(part => part.type !== 'text')) return undefined
  const digest = createHash('sha256')
  for (const part of parts) {
    if (part.type === 'text' && part.text !== undefined) digest.update(`t:${part.text.length}:${part.text}`)
  }
  return digest.digest('hex')
}

/**
 * Find the user message a requestId already admitted — inbox first, then the
 * durable event history. This is the reconciliation source that survives
 * service restarts; the journal does not.
 * @param agent - the owning Agent.
 * @param requestId - the client-minted prompt identity.
 * @returns the matching message, or undefined when the request is new.
 */
export function findPromptRequest(agent: Agent, requestId: SessionRequestId): UserMessage | undefined {
  const matches = (message: UserMessage): boolean => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  }
  const queued = agent.inbox.nextTurn.find(matches) ?? agent.inbox.nextStep.find(matches)
  if (queued !== undefined) return queued
  const messages: UserMessage[] = []
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId) messages.push(event.data)
  }
  return messages.at(-1)
}

/**
 * The service-local admission journal. Serial admission keeps every mutation
 * single-threaded per Agent; this map only needs Map semantics plus a bound.
 */
export class PromptAdmissionJournal {
  private readonly bySession = new Map<SessionId, Map<SessionRequestId, PromptAdmissionRecord>>()

  /**
   * Look up one recorded admission.
   * @param sessionId - the owning Session.
   * @param requestId - the client-minted prompt identity.
   * @returns the record, or undefined when this service life never admitted it.
   */
  lookup(sessionId: SessionId, requestId: SessionRequestId): PromptAdmissionRecord | undefined {
    return this.bySession.get(sessionId)?.get(requestId)
  }

  /**
   * Record one completed admission, evicting the oldest entries beyond the
   * per-Session bound so long-lived services stay bounded; older requests
   * still reconcile through the durable log scan.
   * @param sessionId - the owning Session.
   * @param requestId - the client-minted prompt identity.
   * @param fingerprint - the raw-payload fingerprint from {@link promptRequestFingerprint}.
   * @param admittedAt - epoch milliseconds of admission completion.
   */
  record(sessionId: SessionId, requestId: SessionRequestId, fingerprint: string, admittedAt: number): void {
    let entries = this.bySession.get(sessionId)
    if (entries === undefined) {
      entries = new Map()
      this.bySession.set(sessionId, entries)
    }
    entries.delete(requestId)
    entries.set(requestId, { fingerprint, admittedAt })
    if (entries.size > JOURNAL_PER_SESSION_LIMIT) {
      const oldest = entries.keys().next()
      if (!oldest.done) entries.delete(oldest.value)
    }
  }

  /**
   * Drop one Session's records, called when the Session leaves this service.
   * @param sessionId - the Session whose journal entries are dropped.
   */
  forget(sessionId: SessionId): void {
    this.bySession.delete(sessionId)
  }
}
