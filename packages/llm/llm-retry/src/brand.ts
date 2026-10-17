import type { RetryId as RetryIdentity } from '@deepseek-ai/dsh-agent/types'

/** Stable request retry identity, shared with policy-independent readers. */
export type RetryId = RetryIdentity

/**
 * Brand an implementation-minted retry-chain identity.
 * @param id - opaque retry identity.
 * @returns the same string, branded; no validation is performed.
 */
export function RetryId(id: string): RetryId {
  return id as RetryId
}
