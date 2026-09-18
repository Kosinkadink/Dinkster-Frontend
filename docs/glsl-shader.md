# GLSL shader editor

`dinkster.image.glsl_shader` uses its ordinary multiline `fragment_shader` string as the saved source. The expanded editor is session-only: Apply performs a guarded document command, and document undo/reopen use the same value as every other widget.

The browser preview requires WebGL2 and is only an estimate. It supports GLSL ES 3.00, five image uniforms, typed float/int/bool uniforms, four 256-sample curve textures, four `fragColor` outputs, and `#pragma passes N` for 1 through 32 passes. A later pass reads the prior `fragColor0` as `u_image0`. Sources above 65,536 UTF-8 bytes, invalid shaders, and previews above 2048x2048 are refused with diagnostics rather than modified. Native execution remains authoritative.

Runtime `dinkster.glsl.state` is strictly decoded and attached to its runtime node. Its named `glsl-input-u_imageN` preview streams provide browser input images.
