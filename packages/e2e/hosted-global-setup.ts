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
  const reloadAttempts = new Map<string, number>()

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
            const retryable = process.env['DINKSTER_E2E_RELOAD_FAILED_PACKS'] === '1'
              ? failed.filter(([packId]) => (reloadAttempts.get(packId) ?? 0) < 3)
              : []
            if (retryable.length > 0) {
              for (const [packId] of retryable) {
                reloadAttempts.set(packId, (reloadAttempts.get(packId) ?? 0) + 1)
                const response = await fetch(`${backend}/api/packs/${encodeURIComponent(packId)}/reload`, {
                  method: 'POST',
                  signal: AbortSignal.timeout(30_000),
                })
                if (!response.ok) {
                  throw new Error(`reload ${packId} returned ${response.status}: ${await response.text()}`)
                }
              }
              lastFailure = 'retrying packs that announced before their dependencies'
              await new Promise((resolve) => setTimeout(resolve, 100))
              continue
            }
            if (
              process.env['DINKSTER_E2E_RELOAD_FAILED_PACKS'] === '1'
              && failed.every(([packId]) => (reloadAttempts.get(packId) ?? 0) >= 3)
            ) return
            throw new Error(`native composition failed: ${JSON.stringify(Object.fromEntries(failed))}`)
          }
          return
        }
        lastFailure = 'native composition is still in progress'
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('native composition failed:')) throw error
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`native composition did not settle within 180 seconds: ${lastFailure}`)
}
