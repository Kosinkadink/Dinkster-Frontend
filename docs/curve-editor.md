# Curve editor

Inputs declared as concrete `CURVE` with the `CURVE` widget render a compact curve summary. Activating the row opens a center editor bound to that input.

Double-click the graph to add a point, drag points to change position and value, and select a point before deleting it. At least one point is retained. Position and value are clamped to 0..1 while editing, and positions stay strictly increasing. Choose Linear or Monotone cubic interpolation, then Apply to create one undoable document command. Legacy values without `interpolation` open as Linear; Apply always stores it explicitly.

Linked inputs are read-only and do not open the editor. Editable curves use
the 0-1 position axis and are independent of audio playback.

If an editable input is linked, removed, or changed while the editor is open,
Apply is refused.

When the node receives an optional 256-bin nonnegative integer histogram, execution publishes it as preview metadata. The editor overlays the histogram from the selected run without storing it in the curve value.
