// Solid JSX augmentation for `prop:` directives.
// Solid types `prop:<name>` bindings through JSX.ExplicitProperties, which is
// empty by default; each property we bind must be declared here.
declare module 'solid-js' {
  namespace JSX {
    interface ExplicitProperties {
      /** HTMLInputElement.indeterminate - checkbox tri-state, property-only. */
      indeterminate: boolean
    }
  }
}

export {}
