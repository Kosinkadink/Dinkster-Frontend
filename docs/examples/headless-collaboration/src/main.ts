import {
  CollabHttpConnection,
  credentialFetch,
  closeCollabSession,
  createCollabSession,
  encodePresence,
  getCollabSession,
  listCollabSessions,
} from '@dinkster/client'
import {
  asGraphDefId,
  asLineageId,
  connectSharedSession,
  coreCommandRegistry,
  type WorkflowDocument,
} from '@dinkster/core'
import { userInfo } from 'node:os'
import { runDemoEdits } from './run.js'

const SCOPE = 'shared'

interface CliOptions {
  readonly token?: string
  readonly baseUrl: string
  readonly actorId: string
  readonly owner: string
  readonly sessionId?: string
  readonly list: boolean
  readonly create: boolean
  readonly endSession: boolean
  readonly type?: string
}

const usage = (): string => `Usage:
  pnpm --filter @dinkster/headless-demo start -- --base-url URL --session ID [options]
  pnpm --filter @dinkster/headless-demo start -- --base-url URL --list [options]
  pnpm --filter @dinkster/headless-demo start -- --base-url URL --create [options]

Options:
  --token TOKEN    Delegation credential (or DINKSTER_AGENT_TOKEN)
  --actor-id ID     Participant id (default: headless-demo)
  --owner NAME      Person running this agent (default: OS username)
  --type TYPE       Node type for an empty workflow
  --end-session     End a session created by this invocation after editing
`

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseArgs(args: readonly string[]): CliOptions {
  let baseUrl: string | undefined
  let token = process.env['DINKSTER_AGENT_TOKEN']
  let actorId = 'headless-demo'
  let owner = userInfo().username
  let sessionId: string | undefined
  let list = false
  let create = false
  let endSession = false
  let type: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    switch (arg) {
      case '--': break
      case '--token': token = readValue(args, index++, arg); break
      case '--base-url': baseUrl = readValue(args, index++, arg); break
      case '--actor-id': actorId = readValue(args, index++, arg); break
      case '--owner': owner = readValue(args, index++, arg); break
      case '--session': sessionId = readValue(args, index++, arg); break
      case '--type': type = readValue(args, index++, arg); break
      case '--list': list = true; break
      case '--create': create = true; break
      case '--end-session': endSession = true; break
      case '--help':
      case '-h': console.log(usage()); process.exit(0)
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (baseUrl === undefined) throw new Error('--base-url is required')
  const modes = Number(sessionId !== undefined) + Number(list) + Number(create)
  if (modes !== 1) throw new Error('choose exactly one of --session, --list, or --create')
  if (endSession && !create) throw new Error('--end-session is only valid with --create')
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    ...(token !== undefined && { token }),
    actorId,
    owner,
    ...(sessionId !== undefined ? { sessionId } : {}),
    list,
    create,
    endSession,
    ...(type !== undefined ? { type } : {}),
  }
}

export function minimalDocument(): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId(`headless-${Date.now().toString(36)}`),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'Headless demo',
        nodes: {},
        links: {},
        nets: {},
        reroutes: {},
        nextOrdinal: 1,
      },
    },
    view: { graphs: {} },
  }
}

async function resolveSession(options: CliOptions): Promise<{ id: string; created: boolean }> {
  if (options.sessionId !== undefined) return { id: options.sessionId, created: false }
  if (options.list) {
    const sessions = await listCollabSessions(options.baseUrl, SCOPE, credentialFetch({ token: options.token, actorKind: 'agent' }))
    const first = sessions[0]
    if (first === undefined) throw new Error(`no sessions found in scope '${SCOPE}'`)
    return { id: first.sessionId, created: false }
  }
  const document = minimalDocument()
  const descriptor = await createCollabSession(options.baseUrl, {
    scope: SCOPE,
    documentId: document.lineage,
    snapshot: document,
  }, credentialFetch({ token: options.token, actorKind: 'agent' }))
  return { id: descriptor.sessionId, created: true }
}

const waitForLive = async (
  session: Awaited<ReturnType<typeof connectSharedSession>>,
  targetRevision: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = session.status.get()
    if (status === 'live' && session.revision >= targetRevision) return
    if (status === 'closed' || status === 'error') {
      throw new Error(`session became ${status} before it was live`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`session did not catch up to revision ${targetRevision}`)
}

const settleEdits = async (
  session: Awaited<ReturnType<typeof connectSharedSession>>,
  baseUrl: string,
  sessionId: string,
  token?: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await session.settle()
    const status = session.status.get()
    if (status === 'live') return
    if (status === 'closed' || status === 'error') {
      throw new Error(`session became ${status} while acknowledging edits`)
    }
    const descriptor = await getCollabSession(baseUrl, sessionId, credentialFetch({ token, actorKind: 'agent' }))
    if (descriptor === undefined) throw new Error('session ended while acknowledging edits')
    await waitForLive(session, descriptor.revision)
  }
  throw new Error('session did not finish acknowledging edits')
}

async function main(): Promise<void> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  if (major < 22) throw new Error(`Node 22 or newer is required; found ${process.versions.node}`)
  const options = parseArgs(process.argv.slice(2))
  const selected = await resolveSession(options)
  try {
    console.log(`joining session ${selected.id} as ${options.actorId}`)
    const connection = new CollabHttpConnection({
      baseUrl: options.baseUrl,
      token: options.token,
      actorKind: 'agent',
      sessionId: selected.id,
      actorId: options.actorId,
    })
    let session: Awaited<ReturnType<typeof connectSharedSession>>
    let conflicts = 0
    try {
      session = await connectSharedSession(connection, coreCommandRegistry(), {
        actorId: options.actorId,
        onConflict: (conflict) => {
          conflicts += 1
          console.error('conflict:', conflict)
        },
        onError: (message) => console.error('session error:', message),
      })
    } catch (error) {
      connection.close()
      throw error
    }
    const presence = encodePresence({
      graph: session.doc.root,
      cursor: undefined,
      selection: [],
      identity: { kind: 'agent', displayName: 'headless-demo', harness: 'cli', owner: options.owner },
    })
    let presenceHeartbeat: ReturnType<typeof setInterval> | undefined
    try {
      const descriptor = await getCollabSession(options.baseUrl, selected.id, credentialFetch({ token: options.token, actorKind: 'agent' }))
      if (descriptor === undefined) throw new Error('session ended while joining')
      await waitForLive(session, descriptor.revision)
      session.sendPresence(presence)
      presenceHeartbeat = setInterval(() => session.sendPresence(presence), 2000)
      console.log('session is live')
      const result = await runDemoEdits(session, {
        ...(options.type !== undefined ? { type: options.type } : {}),
        onDispatch: (invocation, outcome) => {
          console.log(`${invocation.command}: ${outcome.ok ? 'ok' : 'failed'}`, JSON.stringify(invocation.params))
          if (!outcome.ok) console.error(outcome.diagnostics)
        },
      })
      await settleEdits(session, options.baseUrl, selected.id, options.token)
      if (conflicts > 0) throw new Error(`${conflicts} edit${conflicts === 1 ? '' : 's'} conflicted during acknowledgement`)
      console.log(`acknowledged ${result.dispatchCount} edits; nodes ${result.firstNodeId}${result.secondNodeId === undefined ? '' : `, ${result.secondNodeId}`}`)
    } finally {
      if (presenceHeartbeat !== undefined) clearInterval(presenceHeartbeat)
      session.close()
    }
    if (!options.endSession) console.log(`left session ${selected.id}; it remains available`)
  } finally {
    if (selected.created && options.endSession) {
      await closeCollabSession(options.baseUrl, selected.id, credentialFetch({ token: options.token, actorKind: 'agent' }))
      console.log(`ended session ${selected.id}`)
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage())
  process.exitCode = 1
})
