import type { FreshDefinitionInitializer } from '../lifecycle/planner.js'

export const coreRegionDefinitions: Readonly<Record<'map' | 'fold' | 'while', FreshDefinitionInitializer>> = {
  map: {
    nodes: { n0: { id: 'n0' as never, type: 'dinkster.utilities.primitive_float', values: {} } },
    links: {}, nets: {}, reroutes: {},
    boundary: {
      inputs: [{ id: 'item' as never, displayName: 'Item', binds: { kind: 'port', node: 'n0' as never, port: 'value' as never } }],
      outputs: [{ id: 'result' as never, displayName: 'Result', binds: { kind: 'port', node: 'n0' as never, port: 'FLOAT' as never } }],
    },
    nextOrdinal: 1,
  },
  fold: {
    nodes: { n0: { id: 'n0' as never, type: 'std.math.add_ints', values: {} } },
    links: {}, nets: {}, reroutes: {},
    boundary: {
      inputs: [
        { id: 'item' as never, displayName: 'Item', binds: { kind: 'port', node: 'n0' as never, port: 'a' as never } },
        { id: 'state' as never, displayName: 'State', binds: { kind: 'port', node: 'n0' as never, port: 'b' as never } },
      ],
      outputs: [{ id: 'result' as never, displayName: 'Result', binds: { kind: 'port', node: 'n0' as never, port: 'sum' as never } }],
    },
    nextOrdinal: 1,
  },
  while: {
    nodes: {
      n0: { id: 'n0' as never, type: 'dinkster.utilities.primitive_float', values: {} },
      n1: { id: 'n1' as never, type: 'dinkster.utilities.primitive_boolean', values: { value: true } },
    },
    links: {}, nets: {}, reroutes: {},
    boundary: {
      inputs: [{ id: 'state' as never, displayName: 'State', binds: { kind: 'port', node: 'n0' as never, port: 'value' as never } }],
      outputs: [
        { id: 'result' as never, displayName: 'Result', binds: { kind: 'port', node: 'n0' as never, port: 'FLOAT' as never } },
        { id: 'continue' as never, displayName: 'Continue', binds: { kind: 'port', node: 'n1' as never, port: 'BOOLEAN' as never } },
      ],
    },
    nextOrdinal: 2,
  },
}
