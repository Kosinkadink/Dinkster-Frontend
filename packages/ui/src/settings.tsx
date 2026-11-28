import { createUniqueId, type JSX } from 'solid-js'

/** Related settings share one quiet box without individual row borders. */
export function ProductSettingsSection(props: { title: string; children: JSX.Element }) {
  const heading = createUniqueId()
  return <section class="dinkster-settings-section" aria-labelledby={heading}>
    <h2 id={heading}>{props.title}</h2>
    {props.children}
  </section>
}
