import type { EditorBinding } from '@dinkster/core'
import {
  APP_EDITOR_KIND,
  CURVE_EDITOR_KIND,
  GLSL_EDITOR_KIND,
  GRAPH_EDITOR_KIND,
  IMAGE_EDITOR_KIND,
} from './editors.js'

export const BUILTIN_EDITOR_NODE_IDS = {
  maskPaint: 'dinkster.mask.paint',
  loadImage: 'dinkster.load_image',
  loadLatent: 'dinkster.load_latent',
  saveImage: 'dinkster.save_image',
  routeSwitchByName: 'dinkster.route.switch_by_name',
  curve: 'dinkster.curve.editor',
  audioEnvelope: 'dinkster.audio.envelope',
  glsl: 'dinkster.image.glsl_shader',
  layersLoad: 'dinkster.layers.load',
  layersFlatten: 'dinkster.layers.flatten',
  layersEdit: 'dinkster.layers.edit',
  videoTrim: 'dinkster.video.trim',
  videoCrop: 'dinkster.video.crop',
} as const

export const builtinEditorBindings: readonly EditorBinding[] = [
  { id: 'builtin.editor-role.graph', editor: GRAPH_EDITOR_KIND, match: { editorRole: 'graph' }, priority: 100 },
  { id: 'builtin.editor-role.app', editor: APP_EDITOR_KIND, match: { editorRole: 'app' }, priority: 100 },
  { id: 'builtin.editor-role.image', editor: IMAGE_EDITOR_KIND, match: { editorRole: 'image' }, priority: 100 },
  { id: 'builtin.editor-role.curve', editor: CURVE_EDITOR_KIND, match: { editorRole: 'curve' }, priority: 100 },
  { id: 'builtin.editor-role.glsl', editor: GLSL_EDITOR_KIND, match: { editorRole: 'glsl' }, priority: 100 },
  { id: 'builtin.widget.compositor', editor: IMAGE_EDITOR_KIND, match: { widgetType: 'COMPOSITOR' }, priority: 50 },
  { id: 'builtin.widget.curve', editor: CURVE_EDITOR_KIND, match: { widgetType: 'CURVE' }, priority: 50 },
  { id: 'builtin.node.mask-paint', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.maskPaint }, priority: 40 },
  { id: 'builtin.node.load-image', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.loadImage }, priority: 40 },
  { id: 'builtin.node.load-latent', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.loadLatent }, priority: 40 },
  { id: 'builtin.node.save-image', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.saveImage }, priority: 40 },
  { id: 'builtin.node.route-switch-by-name', editor: GRAPH_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.routeSwitchByName }, priority: 40 },
  { id: 'builtin.node.curve', editor: CURVE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.curve }, priority: 40 },
  { id: 'builtin.node.audio-envelope', editor: CURVE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.audioEnvelope }, priority: 40 },
  { id: 'builtin.node.glsl', editor: GLSL_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.glsl }, priority: 40 },
  { id: 'builtin.node.layers-load', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.layersLoad }, priority: 40 },
  { id: 'builtin.node.layers-flatten', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.layersFlatten }, priority: 40 },
  { id: 'builtin.node.layers-edit', editor: IMAGE_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.layersEdit }, priority: 40 },
  { id: 'builtin.node.video-trim', editor: GRAPH_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.videoTrim }, priority: 40 },
  { id: 'builtin.node.video-crop', editor: GRAPH_EDITOR_KIND, match: { nodeId: BUILTIN_EDITOR_NODE_IDS.videoCrop }, priority: 40 },
]
