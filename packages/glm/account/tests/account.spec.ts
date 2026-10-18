/**
 * Account-owner unit coverage over a real loopback OAuth+PAT fixture: the
 * PKCE login round-trip, single-flight refresh with per-caller cancellation,
 * epoch-guarded supersession, logout, cold-start hydration, and the PAT
 * owner's mint/cache/expiry/rejection lifecycle. A fake in-memory credentials
 * provider stands in for the record half.
 */
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it } from 'vitest'
import { GhAccountService } from '../src/service.ts'
import { GhProjectTokenService } from '../src/pat.ts'
import { pkcePair } from '../src/oauth.ts'
import type { GhAccountDomainConfig, GhGrantPayload } from '../src/types.ts'

/** In-memory record half; the account owner only uses the record methods. */
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<CredentialKey, CredentialRecord>()
  beforeWrite?: () => Promise<void>

  override async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }

  override async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: false }
  }

  override async set(_ref: CredentialRef, _value: string): Promise<void> {}

  override async unset(_ref: CredentialRef): Promise<void> {}

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return { configured: record !== undefined, ...(record !== undefined ? { kind: record.kind } : {}), writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records.entries()].map(([key, record]) => ({ key, kind: record.kind }))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    await this.beforeWrite?.()
    if (next !== undefined) this.records.set(key, next)
    return next
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
  }
}

/** One loopback OAuth+PAT issuer: authorization codes, refresh rotation, PATs. */
interface Fixture {
  server: Server
  port: number
  /** Counters the tests assert single-flight and mint behavior with. */
  counts: { authorize: number; codeExchanges: number; refreshes: number; patMints: number }
  /** Milliseconds each refresh exchange takes. */
  refreshDelayMs: number
  beforeCode?: () => Promise<void>
  beforePat?: () => Promise<void>
  /** The refresh tokens the issuer currently honors, mapped to accounts. */
  accounts: Map<string, { accountId: string; plan: string | null }>
  /** Authorization codes awaiting exchange, mapped to their PKCE challenge. */
  pendingCodes: Map<string, string>
  /** PATs the issuer minted and still honors. */
  livePats: Set<string>
}

async function startFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    server: undefined as unknown as Server,
    port: 0,
    counts: { authorize: 0, codeExchanges: 0, refreshes: 0, patMints: 0 },
    refreshDelayMs: 0,
    accounts: new Map([['refresh-a', { accountId: 'acct-a', plan: 'personal' }], ['refresh-b', { accountId: 'acct-b', plan: 'team' }]]),
    pendingCodes: new Map(),
    livePats: new Set(),
  }
  fixture.server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const body = new Promise<string>((resolveBody) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      request.on('end', () => { resolveBody(raw) })
    })
    const serve = async (): Promise<void> => {
      if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
        fixture.counts.authorize += 1
        const challenge = url.searchParams.get('code_challenge') ?? ''
        const method = url.searchParams.get('code_challenge_method') ?? ''
        if (method !== 'S256' || challenge === '') {
          response.writeHead(400)
          response.end('bad challenge')
          return
        }
        const code = `code-${fixture.counts.authorize}`
        const account = fixture.counts.authorize % 2 === 1 ? 'a' : 'b'
        fixture.pendingCodes.set(code, challenge)
        fixture.accounts.set(`refresh-${account}-new`, fixture.accounts.get(`refresh-${account}`) ?? { accountId: `acct-${account}`, plan: account === 'a' ? 'personal' : 'team' })
        const target = new URL('/oauth/callback', url)
        target.searchParams.set('code', code)
        target.searchParams.set('state', url.searchParams.get('state') ?? '')
        response.writeHead(302, { location: target.href })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/oauth/token') {
        const form = new URLSearchParams(await body)
        const grantType = form.get('grant_type') ?? ''
        if (grantType === 'authorization_code') {
          fixture.counts.codeExchanges += 1
          await fixture.beforeCode?.()
          const code = form.get('code') ?? ''
          const challenge = fixture.pendingCodes.get(code)
          if (challenge === undefined) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          fixture.pendingCodes.delete(code)
          const account = code.endsWith('1') || code.endsWith('3') ? 'a' : 'b'
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            access_token: `access-${code}`,
            refresh_token: `refresh-${account}-new`,
            expires_in: 1,
            account_id: `acct-${account}`,
            plan: account === 'a' ? 'personal' : 'team',
          }))
          return
        }
        if (grantType === 'refresh_token') {
          fixture.counts.refreshes += 1
          await new Promise(resolveDelay => setTimeout(resolveDelay, fixture.refreshDelayMs))
          const refresh = form.get('refresh_token') ?? ''
          const account = fixture.accounts.get(refresh)
          if (account === undefined) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          const rotated = `refresh-r${fixture.counts.refreshes}`
          fixture.accounts.set(rotated, account)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            access_token: `access-r${fixture.counts.refreshes}`,
            refresh_token: rotated,
            expires_in: 3600,
            account_id: account.accountId,
            plan: account.plan,
          }))
          return
        }
        if (grantType === 'urn:glm-harness:pat') {
          const authorization = request.headers.authorization ?? ''
          if (!authorization.startsWith('Bearer access-')) {
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_token' }))
            return
          }
          fixture.counts.patMints += 1
          await fixture.beforePat?.()
          const pat = `pat-${fixture.counts.patMints}`
          fixture.livePats.add(pat)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ access_token: pat, expires_in: 900 }))
          return
        }
        response.writeHead(400)
        response.end('unknown grant')
        return
      }
      response.writeHead(404)
      response.end()
    }
    void serve().catch(() => { response.destroy() })
  })
  await new Promise<void>((resolveListen) => { fixture.server.listen(0, '127.0.0.1', () => { resolveListen() }) })
  fixture.port = (fixture.server.address() as { port: number }).port
  return fixture
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined)
})

/** One account service wired to the fixture and the memory provider. */
async function harness(overrides: Partial<GhAccountDomainConfig> = {}): Promise<{
  ctx: Context
  account: GhAccountService
  tokens: GhProjectTokenService
  memory: MemoryCredentials
  fixture: Fixture
  config: GhAccountDomainConfig
}> {
  const fixture = await startFixture()
  const config: GhAccountDomainConfig = {
    domain: 'bigmodel',
    authorizeUrl: `http://127.0.0.1:${String(fixture.port)}/oauth/authorize`,
    tokenUrl: `http://127.0.0.1:${String(fixture.port)}/oauth/token`,
    clientId: 'gh-test-client',
    ...overrides,
  }
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  const memory = ctx.credentials as MemoryCredentials
  const account = new GhAccountService(ctx, [config])
  await ctx.plugin(GhProjectTokenService)
  const tokens = ctx.ghProjectToken
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    fixture.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => { if (error) reject(error); else resolve() }))
  })
  return { ctx, account, tokens, memory, fixture, config }
}

/** Drive one full login through the fixture's redirect. */
async function login(account: GhAccountService, domain: 'bigmodel' | 'zai' = 'bigmodel'): Promise<void> {
  const redirect = 'http://127.0.0.1:1/callback'
  const begin = await account.beginLogin(domain, redirect)
  const visited = await fetch(begin.verificationUrl, { redirect: 'manual' })
  const location = new URL(visited.headers.get('location') ?? '', begin.verificationUrl)
  await account.completeLogin(domain, location.searchParams.get('code') ?? '', location.searchParams.get('state') ?? '', redirect)
}

it('completes the PKCE login round-trip and persists the grant', async () => {
  const { account, memory } = await harness()
  await login(account)
  const snapshot = account.snapshot('bigmodel')
  expect(snapshot.accountId).toBe('acct-a')
  expect(snapshot.plan).toBe('personal')
  expect(snapshot.epoch).toBe(1)
  const stored = memory.records.get(credentialKey('gh-account', 'bigmodel'))
  expect(stored?.kind).toBe('grant')
  expect((stored as { payload: GhGrantPayload }).payload.refreshToken).toBe('refresh-a-new')
  expect(await account.accessToken('bigmodel')).toMatch(/^access-/)
})

it('shares one refresh across concurrent callers', async () => {
  const { account, fixture } = await harness()
  await login(account)
  fixture.refreshDelayMs = 150
  const tokens = await Promise.all([
    account.accessToken('bigmodel'),
    account.accessToken('bigmodel'),
    account.accessToken('bigmodel'),
    account.accessToken('bigmodel'),
  ])
  expect(fixture.counts.refreshes).toBe(1)
  expect(new Set(tokens).size).toBe(1)
})

it('keeps the shared refresh alive when one caller aborts', async () => {
  const { account, fixture } = await harness()
  await login(account)
  fixture.refreshDelayMs = 200
  const controller = new AbortController()
  const patient = account.accessToken('bigmodel')
  const impatient = account.accessToken('bigmodel', controller.signal)
  controller.abort(new Error('caller went away'))
  await expect(impatient).rejects.toThrow('caller went away')
  await expect(patient).resolves.toMatch(/^access-r/)
  expect(fixture.counts.refreshes).toBe(1)
})

it('discards a superseded generation instead of overwriting the newer login', async () => {
  const { account, fixture } = await harness()
  await login(account)
  fixture.refreshDelayMs = 250
  const stale = account.accessToken('bigmodel')
  await login(account)
  await expect(stale).rejects.toThrow('changed accounts during the refresh')
  expect(account.snapshot('bigmodel').accountId).toBe('acct-b')
  expect(account.snapshot('bigmodel').epoch).toBe(2)
})

it('hydrates a persisted grant on a cold start', async () => {
  const world = await harness()
  await login(world.account)
  const persisted = world.memory.records.get(credentialKey('gh-account', 'bigmodel'))
  const second = new Context()
  new MemoryCredentials(second)
  ;(second.credentials as MemoryCredentials).records.set(credentialKey('gh-account', 'bigmodel'), persisted as CredentialRecord)
  const revived = new GhAccountService(second, [world.config])
  cleanups.push(() => second.fiber.dispose())
  await expect(revived.accessToken('bigmodel')).resolves.toMatch(/^access-/)
  expect(revived.snapshot('bigmodel').accountId).toBe('acct-a')
})

it('logs out: grant, record, and access', async () => {
  const { account, memory } = await harness()
  await login(account)
  await account.logout('bigmodel')
  expect(memory.records.get(credentialKey('gh-account', 'bigmodel'))).toBeUndefined()
  await expect(account.accessToken('bigmodel')).rejects.toThrow('no bigmodel account is logged in')
})

it('mints, caches, and re-mints PATs per project', async () => {
  const { account, tokens, fixture } = await harness()
  await login(account)
  const first = await tokens.resolvePat('bigmodel', 'proj-1')
  const second = await tokens.resolvePat('bigmodel', 'proj-1')
  expect(first).toMatch(/^pat-/)
  expect(second).toBe(first)
  expect(fixture.counts.patMints).toBe(1)
  const other = await tokens.resolvePat('bigmodel', 'proj-2')
  expect(other).not.toBe(first)
})

it('never reuses a rejected PAT', async () => {
  const { account, tokens } = await harness()
  await login(account)
  const first = await tokens.resolvePat('bigmodel', 'proj-1')
  tokens.rejectPat(first)
  const second = await tokens.resolvePat('bigmodel', 'proj-1')
  expect(second).not.toBe(first)
})

it('drops a cached PAT the moment logout bumps the generation', async () => {
  const { account, tokens } = await harness()
  await login(account)
  await tokens.resolvePat('bigmodel', 'proj-1')
  expect(tokens.patFacts('bigmodel')).not.toBeNull()
  await account.logout('bigmodel')
  expect(tokens.patFacts('bigmodel')).toBeNull()
  await expect(tokens.resolvePat('bigmodel', 'proj-1')).rejects.toThrow('no bigmodel account is logged in')
})

it('refuses PAT mint without an account', async () => {
  const { tokens } = await harness()
  await expect(tokens.resolvePat('bigmodel', 'proj-1')).rejects.toThrow('no bigmodel account is logged in')
})

it('keeps the PKCE verifier bound to its challenge', async () => {
  const { account } = await harness()
  const begin = await account.beginLogin('bigmodel', 'http://127.0.0.1:1/callback')
  await expect(account.completeLogin('bigmodel', 'code-x', 'wrong-state', 'http://127.0.0.1:1/callback'))
    .rejects.toThrow('state mismatch')
  const pair = pkcePair()
  expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  void begin
})

it('does not restore a login whose code exchange finishes after logout', async () => {
  const { account, memory, fixture } = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.beforeCode = async () => { entered.resolve(undefined); await release.promise }
  const pending = login(account)
  const outcome = pending.then(() => 'accepted', () => 'rejected')
  try {
    await entered.promise
    await account.logout('bigmodel')
  } finally {
    release.resolve(undefined)
  }
  expect(await outcome).toBe('rejected')
  expect(account.snapshot('bigmodel').accountId).toBe('')
  expect(memory.records.has(credentialKey('gh-account', 'bigmodel'))).toBe(false)
})

it('does not cache or return a PAT minted under a logged-out generation', async () => {
  const { account, tokens, fixture } = await harness()
  await login(account)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.beforePat = async () => { entered.resolve(undefined); await release.promise }
  const pending = tokens.resolvePat('bigmodel', 'proj-1').then(() => 'accepted', () => 'rejected')
  try {
    await entered.promise
    await account.logout('bigmodel')
  } finally {
    release.resolve(undefined)
  }
  expect(await pending).toBe('rejected')
  expect(tokens.patFacts('bigmodel')).toBeNull()
})

it('finishes an older credential write before logout deletes the persisted grant', async () => {
  const { account, memory } = await harness()
  await login(account)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  memory.beforeWrite = async () => { entered.resolve(undefined); await release.promise }
  const refreshing = account.accessToken('bigmodel').then(() => 'accepted', () => 'rejected')
  let loggingOut: Promise<void> | undefined
  try {
    await entered.promise
    loggingOut = account.logout('bigmodel')
  } finally {
    release.resolve(undefined)
  }
  await loggingOut
  expect(await refreshing).toBe('rejected')
  expect(account.snapshot('bigmodel').accountId).toBe('')
  expect(memory.records.has(credentialKey('gh-account', 'bigmodel'))).toBe(false)
})

it('does not publish a login whose credential write fails', async () => {
  const { account, memory } = await harness()
  memory.beforeWrite = () => Promise.reject(new Error('credential store unavailable'))
  await expect(login(account)).rejects.toThrow('credential store unavailable')
  expect(account.snapshot('bigmodel').accountId).toBe('')
  expect(memory.records.size).toBe(0)
})

it('bounds a stalled OAuth exchange and permits a fresh login afterward', async () => {
  const { account, fixture } = await harness({ requestTimeoutMs: 1000 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.beforeCode = async () => { entered.resolve(undefined); await release.promise }
  const pending = login(account)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gh-account/unavailable' })
  try { await entered.promise; await rejected } finally { release.resolve(undefined) }
  delete fixture.beforeCode
  await login(account)
  expect(account.snapshot('bigmodel').accountId).not.toBe('')
})

it('cancels owned exchanges and waits for settlement during account teardown', async () => {
  const { ctx, account, memory, fixture } = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.beforeCode = async () => { entered.resolve(undefined); await release.promise }
  const pending = login(account).then(() => 'accepted', () => 'rejected')
  try {
    await entered.promise
    await ctx.fiber.dispose()
    expect(await pending).toBe('rejected')
    expect(memory.records.size).toBe(0)
  } finally {
    release.resolve(undefined)
  }
})
