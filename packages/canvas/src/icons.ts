// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Ban from 'lucide/dist/esm/icons/ban.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Play from 'lucide/dist/esm/icons/play.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Trash2 from 'lucide/dist/esm/icons/trash-2.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import VolumeX from 'lucide/dist/esm/icons/volume-x.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Circle from 'lucide/dist/esm/icons/circle.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import EllipsisVertical from 'lucide/dist/esm/icons/ellipsis-vertical.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Lock from 'lucide/dist/esm/icons/lock.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Plus from 'lucide/dist/esm/icons/plus.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Minus from 'lucide/dist/esm/icons/minus.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Dice5 from 'lucide/dist/esm/icons/dice-5.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Boxes from 'lucide/dist/esm/icons/boxes.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import FolderOpen from 'lucide/dist/esm/icons/folder-open.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Group from 'lucide/dist/esm/icons/group.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import Ungroup from 'lucide/dist/esm/icons/ungroup.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import SlidersHorizontal from 'lucide/dist/esm/icons/sliders-horizontal.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import PanelTopClose from 'lucide/dist/esm/icons/panel-top-close.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import PanelTopOpen from 'lucide/dist/esm/icons/panel-top-open.mjs'

import type { ToolboxButton } from './toolbox.js'

type IconNode = readonly (readonly [string, Readonly<Record<string, string>>])[]

export type SeedControllerMode = 'fixed' | 'increment' | 'decrement' | 'randomize'

const CONTROLLER_ICONS: Record<SeedControllerMode, IconNode> = {
  fixed: Lock,
  increment: Plus,
  decrement: Minus,
  randomize: Dice5,
}

const ICONS: Record<NonNullable<ToolboxButton['icon']>, IconNode> = {
  'volume-x': VolumeX,
  ban: Ban,
  play: Play,
  'play-to': [
    ['path', { d: 'M5 5a2 2 0 0 1 3-1.7l8 6.7a2 2 0 0 1 0 3l-8 6.7A2 2 0 0 1 5 18z' }],
    ['line', { x1: '20', y1: '5', x2: '20', y2: '19' }],
  ],
  'play-from': [
    ['line', { x1: '4', y1: '5', x2: '4', y2: '19' }],
    ['path', { d: 'M8 5a2 2 0 0 1 3-1.7l8 6.7a2 2 0 0 1 0 3l-8 6.7A2 2 0 0 1 8 18z' }],
  ],
  'play-between': [
    ['line', { x1: '3', y1: '5', x2: '3', y2: '19' }],
    ['path', { d: 'M7 5a2 2 0 0 1 3-1.7l6 6.7a2 2 0 0 1 0 3l-6 6.7A2 2 0 0 1 7 18z' }],
    ['line', { x1: '21', y1: '5', x2: '21', y2: '19' }],
  ],
  'trash-2': Trash2,
  circle: Circle,
  'ellipsis-vertical': EllipsisVertical,
  'folder-open': FolderOpen,
  group: Group,
  ungroup: Ungroup,
  boxes: Boxes,
  'sliders-horizontal': SlidersHorizontal,
  'panel-top-close': PanelTopClose,
  'panel-top-open': PanelTopOpen,
}

/** Paint Lucide's 24px SVG node data into a square canvas button. */
export function paintToolboxIcon(
  ctx: CanvasRenderingContext2D,
  icon: NonNullable<ToolboxButton['icon']>,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  if (icon === 'circle') {
    const radius = size * 0.22
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
    return
  }
  paintIcon(ctx, ICONS[icon], x, y, size, color)
}

/** Paint the icon-only status for an after-generate controller chip. */
export function paintSeedControllerIcon(
  ctx: CanvasRenderingContext2D,
  mode: SeedControllerMode,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  paintIcon(ctx, CONTROLLER_ICONS[mode], x, y, size, color)
}

function paintIcon(ctx: CanvasRenderingContext2D, nodes: IconNode, x: number, y: number, size: number, color: string): void {
  const pad = size * 0.2
  const scale = (size - pad * 2) / 24
  ctx.save()
  ctx.translate(x + pad, y + pad)
  ctx.scale(scale, scale)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [tag, attrs] of nodes) {
    ctx.beginPath()
    if (tag === 'path') {
      ctx.stroke(new Path2D(attrs.d))
    } else if (tag === 'circle') {
      ctx.arc(Number(attrs.cx), Number(attrs.cy), Number(attrs.r), 0, Math.PI * 2)
      ctx.stroke()
    } else if (tag === 'line') {
      ctx.moveTo(Number(attrs.x1), Number(attrs.y1))
      ctx.lineTo(Number(attrs.x2), Number(attrs.y2))
      ctx.stroke()
    } else if (tag === 'rect') {
      const rx = Number(attrs.rx ?? 0)
      const ry = Number(attrs.ry ?? attrs.rx ?? 0)
      if (rx > 0 || ry > 0) {
        ctx.roundRect(
          Number(attrs.x ?? 0), Number(attrs.y ?? 0), Number(attrs.width), Number(attrs.height),
          { x: rx, y: ry },
        )
      } else {
        ctx.rect(Number(attrs.x ?? 0), Number(attrs.y ?? 0), Number(attrs.width), Number(attrs.height))
      }
      ctx.stroke()
    } else if (tag === 'ellipse') {
      ctx.ellipse(Number(attrs.cx), Number(attrs.cy), Number(attrs.rx), Number(attrs.ry), 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (tag === 'polyline' || tag === 'polygon') {
      const points = attrs.points!.trim().split(/\s+/).map((point) => point.split(',').map(Number))
      const first = points[0]
      if (!first) continue
      ctx.moveTo(first[0]!, first[1]!)
      for (const point of points.slice(1)) ctx.lineTo(point[0]!, point[1]!)
      if (tag === 'polygon') ctx.closePath()
      ctx.stroke()
    }
  }
  ctx.restore()
}
