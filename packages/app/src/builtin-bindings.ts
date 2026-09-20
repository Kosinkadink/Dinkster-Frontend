import type { EditorBinding } from '@dinkster/core'
import {
  APP_EDITOR_KIND,
  CURVE_EDITOR_KIND,
  GLSL_EDITOR_KIND,
  GRAPH_EDITOR_KIND,
  IMAGE_EDITOR_KIND,
} from './editors.js'

export const builtinEditorBindings: readonly EditorBinding[] = [
  { id: 'builtin.editor-role.graph', editor: GRAPH_EDITOR_KIND, match: { editorRole: 'graph' }, priority: 100 },
  { id: 'builtin.editor-role.app', editor: APP_EDITOR_KIND, match: { editorRole: 'app' }, priority: 100 },
  { id: 'builtin.editor-role.latent-source', editor: GRAPH_EDITOR_KIND, match: { editorRole: 'latent-source' }, priority: 100 },
  { id: 'builtin.editor-role.named-route-switch', editor: GRAPH_EDITOR_KIND, match: { editorRole: 'named-route-switch' }, priority: 100 },
  { id: 'builtin.editor-role.video-trim', editor: GRAPH_EDITOR_KIND, match: { editorRole: 'video-trim' }, priority: 100 },
  { id: 'builtin.editor-role.video-crop', editor: GRAPH_EDITOR_KIND, match: { editorRole: 'video-crop' }, priority: 100 },
  { id: 'builtin.editor-role.image-source', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'image-source' }, priority: 100 },
  { id: 'builtin.editor-role.mask-paint', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'mask-paint' }, priority: 100 },
  { id: 'builtin.editor-role.image-save', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'image-save' }, priority: 100 },
  { id: 'builtin.editor-role.compositor', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'compositor' }, priority: 100 },
  { id: 'builtin.editor-role.layers-load', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'layers-load' }, priority: 100 },
  { id: 'builtin.editor-role.layers-flatten', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'layers-flatten' }, priority: 100 },
  { id: 'builtin.editor-role.layers-edit', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'layers-edit' }, priority: 100 },
  { id: 'builtin.editor-role.curve', editor: CURVE_EDITOR_KIND, match: { editorRole: 'curve' }, priority: 100 },
  { id: 'builtin.editor-role.audio-envelope', editor: CURVE_EDITOR_KIND, match: { editorRole: 'audio-envelope' }, priority: 100 },
  { id: 'builtin.editor-role.glsl', editor: GLSL_EDITOR_KIND, match: { editorRole: 'glsl' }, priority: 100 },
]
