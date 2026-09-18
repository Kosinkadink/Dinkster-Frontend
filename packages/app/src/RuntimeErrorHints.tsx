import { For, Show } from 'solid-js'
import type { RuntimeErrorHint } from '@dinkster/core'
import { useAppMessage } from './locale.js'

export function RuntimeErrorHints(props: { readonly hints: readonly RuntimeErrorHint[] | undefined }) {
  const message = useAppMessage()
  return (
    <Show when={props.hints?.length}>
      <div class="runtime-error-hints">
        <For each={props.hints}>
          {(hint) => (
            <div class="runtime-error-hint">
              <div>
                <span
                  class="runtime-error-hint-code"
                  tabindex="0"
                  aria-label={message('problems.hint.code', { code: hint.code })}
                  data-tooltip-label={message('problems.hint.code', { code: hint.code })}
                >[{hint.code}]</span>{' '}
                {hint.message}
              </div>
              <Show when={hint.suggestion !== undefined}>
                <div class="runtime-error-hint-suggestion">{hint.suggestion}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
