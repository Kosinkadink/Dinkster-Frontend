import assert from 'node:assert/strict'

const requiredNativeBackend = (): string => {
  const value = process.env['DINKSTER_NATIVE_BACKEND']
  if (!value) throw new Error('DINKSTER_NATIVE_BACKEND must identify the hosted native backend')
  return value.replace(/\/$/, '')
}

export default async function waitForNativeComposition(): Promise<void> {
  const backend = requiredNativeBackend()
  const url = `${backend}/api/composition`
  const deadline = Date.now() + 180_000
  let lastFailure = 'native backend did not answer'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) {
        lastFailure = `GET /api/composition returned ${response.status}`
      } else {
        const composition = await response.json() as {
          composing?: boolean
          packs?: Record<string, { state?: string; error?: string }>
        }
        const packs = Object.entries(composition.packs ?? {})
        if (!composition.composing && packs.length > 0) {
          const failed = packs.filter(([, pack]) => pack.state !== 'announced')
          if (failed.length > 0) {
            throw new Error(`native composition failed: ${JSON.stringify(Object.fromEntries(failed))}`)
          }
          const plan = await fetch(`${backend}/api/workflows/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflows: [{
              format: 'dinkster-workflow', formatVersion: 1,
              graphs: { g0: { nodes: {} } },
            }] }),
            signal: AbortSignal.timeout(2_000),
          })
          const body = await plan.text()
          assert.equal(plan.status, 200, `workflow plan failed: ${body}`)
          assert.deepEqual(JSON.parse(body), { packs: [], assets: [], errors: [] })
          const registration = await fetch(`${backend}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'default', name: 'Default' }),
            signal: AbortSignal.timeout(2_000),
          })
          const registered = await registration.text()
          assert.equal(registration.status, 200, registered)
          const { project } = JSON.parse(registered) as { project: { revision: number } }
          const needsResponse = await fetch(`${backend}/api/projects/default/needs`)
          assert(needsResponse.ok, 'Hosted fixture project needs must be available')
          const needs = await needsResponse.json() as { installed: { pack: string }[] }
          assert(Array.isArray(needs.installed), 'Captured packs must be reported as installed')
          // Editing fixtures deliberately use the captured pack set in one project.
          const enabled = await fetch(`${backend}/api/projects/default`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision: project.revision, patch: {
              packs: { extra: needs.installed.map(({ pack }) => pack).sort() },
            } }),
            signal: AbortSignal.timeout(2_000),
          })
          assert.equal(enabled.status, 200, await enabled.text())
          const catalog = await fetch(`${backend}/api/nodes?wire=45`)
          const scoped = await fetch(`${backend}/api/nodes?wire=45&project=default`)
          assert(catalog.ok && scoped.ok, 'Hosted fixture catalogs must be available')
          const globalNodes = await catalog.json() as { nodes: Record<string, unknown> }
          const projectNodes = await scoped.json() as { nodes: Record<string, unknown> }
          assert.deepEqual(Object.keys(projectNodes.nodes).sort(), Object.keys(globalNodes.nodes).sort(),
            'The fixture project must enable every captured node')
          return
        }
        lastFailure = 'native composition is still in progress'
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
      if (error instanceof Error && error.message.startsWith('native composition failed:')) throw error
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`native composition did not settle within 180 seconds: ${lastFailure}`)
}
