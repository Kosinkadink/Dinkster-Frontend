import { For, Show } from 'solid-js'
import { actorColor, actorLabel, type PresenceChannel } from './collab-presence.js'
import { useSignal } from './solid-adapter.js'

export function CollabParticipants(props: { presence: PresenceChannel; actorId: string }) {
  const remotes = useSignal(props.presence.remotes)
  return (
    <section class="collab-participant-section" aria-label="Participants">
      <header><h4>Participants</h4><span>{remotes().size + 1} here now</span></header>
      <ul class="collab-participants" data-testid="collab-participants" tabindex="0" aria-label="Participants in this collaboration session">
        <li>
          <span class="collab-swatch" style={{ background: actorColor(props.actorId) }} />
          <code>{actorLabel(props.actorId)}</code><span class="collab-you">You</span>
        </li>
        <For each={[...remotes().values()]}>{(remote) => (
          <li data-testid="collab-participant" data-actor-id={remote.actorId}>
            <span class="collab-swatch" style={{ background: actorColor(remote.actorId) }} />
            <span class="collab-participant-identity">
              <code>{remote.identity?.displayName ?? actorLabel(remote.actorId)}</code>
              <Show when={remote.activity}>{(activity) => (
                <span class="collab-participant-identity" data-testid="agent-activity" aria-live="polite">
                  <small>{activity().tool}: {activity().status}</small>
                  <For each={activity().pendingAsks}>{(ask) => <small>Asks: {ask.prompt}</small>}</For>
                </span>
              )}</Show>
              <Show when={remote.identity?.kind === 'agent' && (remote.identity.owner !== undefined || remote.identity.harness !== undefined)}>
                <small>
                  {remote.identity?.owner !== undefined ? `run by ${remote.identity.owner}` : ''}
                  {remote.identity?.harness !== undefined ? `${remote.identity.owner !== undefined ? ' ' : ''}(${remote.identity.harness})` : ''}
                </small>
              </Show>
            </span>
            <Show when={remote.identity?.kind === 'agent'}><span class="collab-agent">agent</span></Show>
          </li>
        )}</For>
      </ul>
    </section>
  )
}
