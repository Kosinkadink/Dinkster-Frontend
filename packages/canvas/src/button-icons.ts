/**
 * The icons a declared Button may show: the engine's list
 * (`dinkster_schema.body.BUTTON_ICONS`), from lucide 1.25.0. A name outside it draws no icon.
 */
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonArrowDown from 'lucide/dist/esm/icons/arrow-down.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonArrowLeftRight from 'lucide/dist/esm/icons/arrow-left-right.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonArrowUp from 'lucide/dist/esm/icons/arrow-up.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonCheck from 'lucide/dist/esm/icons/check.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonClipboardPaste from 'lucide/dist/esm/icons/clipboard-paste.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonCopy from 'lucide/dist/esm/icons/copy.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonDice5 from 'lucide/dist/esm/icons/dice-5.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonDownload from 'lucide/dist/esm/icons/download.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonEraser from 'lucide/dist/esm/icons/eraser.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonExternalLink from 'lucide/dist/esm/icons/external-link.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonEye from 'lucide/dist/esm/icons/eye.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonEyeOff from 'lucide/dist/esm/icons/eye-off.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonFolderOpen from 'lucide/dist/esm/icons/folder-open.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonImage from 'lucide/dist/esm/icons/image.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonInfo from 'lucide/dist/esm/icons/info.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonLanguages from 'lucide/dist/esm/icons/languages.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonLink from 'lucide/dist/esm/icons/link.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonList from 'lucide/dist/esm/icons/list.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonLock from 'lucide/dist/esm/icons/lock.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonLockOpen from 'lucide/dist/esm/icons/lock-open.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonMinus from 'lucide/dist/esm/icons/minus.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonPencil from 'lucide/dist/esm/icons/pencil.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonPlay from 'lucide/dist/esm/icons/play.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonPlus from 'lucide/dist/esm/icons/plus.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonRefreshCw from 'lucide/dist/esm/icons/refresh-cw.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonRotateCcw from 'lucide/dist/esm/icons/rotate-ccw.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonSave from 'lucide/dist/esm/icons/save.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonSearch from 'lucide/dist/esm/icons/search.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonShuffle from 'lucide/dist/esm/icons/shuffle.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonSlidersHorizontal from 'lucide/dist/esm/icons/sliders-horizontal.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonSquare from 'lucide/dist/esm/icons/square.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonTrash2 from 'lucide/dist/esm/icons/trash-2.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonUpload from 'lucide/dist/esm/icons/upload.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonWandSparkles from 'lucide/dist/esm/icons/wand-sparkles.mjs'
// @ts-expect-error Lucide ships per-icon ESM data without per-file declarations.
import ButtonX from 'lucide/dist/esm/icons/x.mjs'

import { paintIconNodes, type IconNode } from './icons.js'

const BUTTON_ICONS: Readonly<Record<string, IconNode>> = {
  'arrow-down': ButtonArrowDown,
  'arrow-left-right': ButtonArrowLeftRight,
  'arrow-up': ButtonArrowUp,
  'check': ButtonCheck,
  'clipboard-paste': ButtonClipboardPaste,
  'copy': ButtonCopy,
  'dice-5': ButtonDice5,
  'download': ButtonDownload,
  'eraser': ButtonEraser,
  'external-link': ButtonExternalLink,
  'eye': ButtonEye,
  'eye-off': ButtonEyeOff,
  'folder-open': ButtonFolderOpen,
  'image': ButtonImage,
  'info': ButtonInfo,
  'languages': ButtonLanguages,
  'link': ButtonLink,
  'list': ButtonList,
  'lock': ButtonLock,
  'lock-open': ButtonLockOpen,
  'minus': ButtonMinus,
  'pencil': ButtonPencil,
  'play': ButtonPlay,
  'plus': ButtonPlus,
  'refresh-cw': ButtonRefreshCw,
  'rotate-ccw': ButtonRotateCcw,
  'save': ButtonSave,
  'search': ButtonSearch,
  'shuffle': ButtonShuffle,
  'sliders-horizontal': ButtonSlidersHorizontal,
  'square': ButtonSquare,
  'trash-2': ButtonTrash2,
  'upload': ButtonUpload,
  'wand-sparkles': ButtonWandSparkles,
  'x': ButtonX,
}

export const isButtonIcon = (name: string | undefined): name is string => name !== undefined && Object.hasOwn(BUTTON_ICONS, name)

/** Paint a Button's icon, `size` pixels square at (x, y). */
export function paintButtonIcon(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, color: string): void {
  if (isButtonIcon(name)) paintIconNodes(ctx, BUTTON_ICONS[name]!, x, y, size, color)
}
