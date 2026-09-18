import type { LucideIcon } from 'lucide-solid'

/** Consistent decorative Lucide glyph for DOM chrome controls. */
export function Icon(props: { readonly icon: LucideIcon; readonly size?: string | number }) {
  const Glyph = props.icon
  return (
    <Glyph
      aria-hidden="true"
      size={props.size ?? '1em'}
      stroke-width={2}
    />
  )
}
