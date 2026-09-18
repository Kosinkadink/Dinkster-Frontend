# Conditional widget groups

Schema wire 27 can declare widget groups controlled by finite JSON-scalar input values; integer conditions use the JavaScript safe-integer range. The canvas shows a controlled top-level widget when any group matches its primary condition and all of its optional required conditions. Connected widgets remain visible so links are never hidden. This changes presentation only: hidden values remain stored and continue to execute normally.

`packages/e2e/tests/wire27-conditional-widgets.spec.ts` proves the shipped image resize groups in both dimensions and total-pixels modes.
