import { For, Match, Show, Switch, type JSX } from 'solid-js'
import type { MarkdownBlock, MarkdownInline } from './markdownParser.js'

export interface MarkdownAssets {
  readonly [source: string]: { readonly url: string; readonly mediaType: string }
}

export interface MarkdownTemplateAction {
  readonly label: string
  readonly open: (template: string) => void
}

const Inline = (props: { readonly value: MarkdownInline; readonly assets: MarkdownAssets }): JSX.Element => (
  <Switch>
    <Match when={props.value.kind === 'text' ? props.value : undefined}>{(value) => value().text}</Match>
    <Match when={props.value.kind === 'code' ? props.value : undefined}>{(value) => <code>{value().text}</code>}</Match>
    <Match when={props.value.kind === 'emphasis' ? props.value : undefined}>{(value) => <em><Inlines values={value().children} assets={props.assets} /></em>}</Match>
    <Match when={props.value.kind === 'strong' ? props.value : undefined}>{(value) => <strong><Inlines values={value().children} assets={props.assets} /></strong>}</Match>
    <Match when={props.value.kind === 'link' ? props.value : undefined}>{(value) => (
      <a href={value().href} target={value().href.startsWith('https:') ? '_blank' : undefined} rel={value().href.startsWith('https:') ? 'noreferrer' : undefined}>
        <Inlines values={value().children} assets={props.assets} />
      </a>
    )}</Match>
    <Match when={props.value.kind === 'image' ? props.value : undefined}>{(value) => {
      const asset = () => props.assets[value().asset]
      const image = () => {
        return asset()?.mediaType.startsWith('image/') === true ? asset() : undefined
      }
      return <Switch fallback={<span>{value().alt}</span>}><Match when={image()}>{(resolved) => <img src={resolved().url} alt={value().alt} loading="lazy" />}</Match></Switch>
    }}</Match>
  </Switch>
)

const Inlines = (props: { readonly values: readonly MarkdownInline[]; readonly assets: MarkdownAssets }): JSX.Element => (
  <For each={props.values}>{(value) => <Inline value={value} assets={props.assets} />}</For>
)

const Block = (props: { readonly value: MarkdownBlock; readonly assets: MarkdownAssets; readonly templateAction?: MarkdownTemplateAction | undefined }): JSX.Element => (
  <Switch>
    <Match when={props.value.kind === 'heading' ? props.value : undefined}>{(value) => {
      const children = () => {
        return <Inlines values={value().children} assets={props.assets} />
      }
      return <Switch>
        <Match when={value().depth === 1}><h1>{children()}</h1></Match>
        <Match when={value().depth === 2}><h2>{children()}</h2></Match>
        <Match when={value().depth === 3}><h3>{children()}</h3></Match>
        <Match when={value().depth === 4}><h4>{children()}</h4></Match>
        <Match when={value().depth === 5}><h5>{children()}</h5></Match>
        <Match when={value().depth === 6}><h6>{children()}</h6></Match>
      </Switch>
    }}</Match>
    <Match when={props.value.kind === 'paragraph' ? props.value : undefined}>{(value) => <p><Inlines values={value().children} assets={props.assets} /></p>}</Match>
    <Match when={props.value.kind === 'code' ? props.value : undefined}>{(value) => <pre><code class={value().language ? `language-${value().language}` : undefined}>{value().text}</code></pre>}</Match>
    <Match when={props.value.kind === 'quote' ? props.value : undefined}>{(value) => <blockquote><Blocks values={value().children} assets={props.assets} templateAction={props.templateAction} /></blockquote>}</Match>
    <Match when={props.value.kind === 'list' ? props.value : undefined}>{(value) => (
      <Switch>
        <Match when={value().ordered}><ol start={value().start}><For each={value().items}>{(item) => <li><Blocks values={item.children} assets={props.assets} templateAction={props.templateAction} /></li>}</For></ol></Match>
        <Match when={!value().ordered}><ul><For each={value().items}>{(item) => <li><Blocks values={item.children} assets={props.assets} templateAction={props.templateAction} /></li>}</For></ul></Match>
      </Switch>
    )}</Match>
    <Match when={props.value.kind === 'table' ? props.value : undefined}>{(value) => <table><thead><tr><For each={value().head}>{(cell) => <th><Inlines values={cell} assets={props.assets} /></th>}</For></tr></thead><tbody><For each={value().rows}>{(row) => <tr><For each={row}>{(cell) => <td><Inlines values={cell} assets={props.assets} /></td>}</For></tr>}</For></tbody></table>}</Match>
    <Match when={props.value.kind === 'media' ? props.value : undefined}>{(value) => {
      const asset = () => props.assets[value().asset]
      const video = () => asset()?.mediaType.startsWith('video/') === true ? asset() : undefined
      const poster = () => {
        const resolved = value().poster === undefined ? undefined : props.assets[value().poster!]
        return resolved?.mediaType.startsWith('image/') === true ? resolved.url : undefined
      }
      return <Switch fallback={<p>{value().caption ?? value().asset}</p>}><Match when={video()}>{(resolved) => <figure><div class="dinkster-markdown-video"><video controls preload="metadata" src={resolved().url} poster={poster()} /></div><Switch><Match when={value().caption}>{(caption) => <figcaption>{caption()}</figcaption>}</Match></Switch></figure>}</Match></Switch>
    }}</Match>
    <Match when={props.value.kind === 'template' ? props.value : undefined}>{(value) => (
      <Switch fallback={<pre><code class="language-dinkster-example">{value().source}</code></pre>}>
        <Match when={props.templateAction}>{(action) => (
          <aside class="dinkster-markdown-template">
            <Show when={value().caption}>{(caption) => <p>{caption()}</p>}</Show>
            <button type="button" onClick={() => action().open(value().template)}>{action().label}</button>
          </aside>
        )}</Match>
      </Switch>
    )}</Match>
  </Switch>
)

const Blocks = (props: { readonly values: readonly MarkdownBlock[]; readonly assets: MarkdownAssets; readonly templateAction?: MarkdownTemplateAction | undefined }): JSX.Element => (
  <For each={props.values}>{(value) => <Block value={value} assets={props.assets} templateAction={props.templateAction} />}</For>
)

export const Markdown = (props: { readonly blocks: readonly MarkdownBlock[]; readonly assets?: MarkdownAssets; readonly templateAction?: MarkdownTemplateAction | undefined }): JSX.Element => (
  <div class="dinkster-markdown"><Blocks values={props.blocks} assets={props.assets ?? {}} templateAction={props.templateAction} /></div>
)
