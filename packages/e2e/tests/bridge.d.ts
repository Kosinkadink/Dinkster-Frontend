/**
 * Minimal structural view of the window.__dinksterTest bridge, shared by all
 * specs. Kept intentionally narrow: specs should depend on the smallest
 * surface that proves the behavior, not on app internals.
 */
interface DinksterBridgeSceneNode {
  id: string
  x: number
  y: number
  color?: string
  virtual?: { text: string; format: 'plain' | 'markdown' }
  unrecognized?: true
  layout: {
    width: number
    height: number
    minWidth: number
    minHeight: number
    headerHeight: number
    minimized?: true
    preview?: { x: number; y: number; width: number; height: number; compact?: true }
    advancedGroup?: { y: number; height: number }
    rows: ReadonlyArray<{
      kind: string
      y: number
      height: number
      inset?: number
      inputId?: string
      viewId?: string
      representationId?: string
      input?: { portId: string }
      output?: { portId: string }
      sectionId?: string
      collapsed?: boolean
      /** Growth-row fields (kind 'growth'): nested-only Autogrow affordance. */
      construct?: string
      label?: string
      frames?: ReadonlyArray<{ construct: string; members: readonly string[] }>
    }>
    pins: ReadonlyArray<{
      portId: string
      direction: 'in' | 'out'
      y: number
      warn?: true
      /** Trailing ghost affordance (dynamic family growth slot). */
      ghost?: true
      /** Materialized Autogrow member retaining family-growth styling. */
      familyMember?: true
      address: { port: string; members?: readonly string[] }
      familyOwner?: { socketed?: true }
      /** Optional input (donut) / maybe-absent producer. */
      optional?: true
      /** Input pin belonging to an ordinary widget row. */
      widgetBacked?: true
      /** Output pin exposing an input widget value instead of a node output. */
      widgetTap?: true
      /** Output whose producer may deliberately emit no value. */
      maybeAbsent?: true
      /** Solved-then-declared display type (drives pin color/shape). */
      type?: { kind: string; name?: string; templateId?: string }
      /** Declared generic identity retained after type inference. */
      matchVariable?: string
      /** Display type was inferred through a generic match. */
      inferred?: true
    }>
  }
}

interface DinksterBridgeExecutionRef {
  connection: string
  prompt: string
}

/** Minimal compile-artifact view: the AP5 spec spreads one to synthesize a
 * run whose recorded schema hash matches no registry the app holds. */
interface DinksterBridgeCompileArtifact {
  connection: string
  schemaHash: string
  diagnostics: ReadonlyArray<{ code: string }>
  prompt?: Record<string, { class_type: string; inputs: Record<string, unknown>; slotVariants?: Record<string, string> }>
}

/** Injectable runtime-error event: the same NormalizedEvent shape the real
 * connection produces, used by specs to create deterministic errors. */
interface DinksterBridgeErrorEvent {
  kind: 'error'
  execution: DinksterBridgeExecutionRef
  timestamp: number
  runtimeNodeId?: string
  detail: {
    exceptionType: string
    exceptionMessage: string
    traceback: string[]
    currentInputs?: Record<string, unknown>
  }
}

/** Injectable lifecycle event: used by the reconnect spec to seed an
 * in-flight execution the server has never heard of ("ghost" run). */
interface DinksterBridgeLifecycleEvent {
  kind: 'started' | 'completed'
  execution: DinksterBridgeExecutionRef
  timestamp: number
}

/** Injectable preview frame: the same NormalizedEvent shape the metadata
 * preview protocol produces, used to create deterministic live frames. */
interface DinksterBridgePreviewEvent {
  kind: 'preview'
  execution: DinksterBridgeExecutionRef
  timestamp: number
  runtimeNodeId?: string
  channel: string
  payload: ArrayBuffer
}

interface DinksterBridgeTab {
  id: string
  title: string
  execution?: DinksterBridgeExecutionRef
  store: {
    revision: number
    /** Undo one revision; false when there is nothing to undo. */
    undo(): boolean
    redo(): boolean
    /** Dispatch a command invocation (perf specs drive the full loop). */
    dispatch(invocation: { command: string; params: unknown }): {
      ok: boolean
      diagnostics?: readonly unknown[]
    }
    doc: {
      lineage: string
      root: string
      graphs: Record<
        string,
        {
          nodes: Record<
            string,
            {
              id: string
              type: string
              title?: string
              virtual?: true
              values: Record<string, unknown>
              dynamic?: Record<string, {
                selected?: string
                members?: readonly string[]
                memberLabels?: Readonly<Record<string, string>>
              }>
              mode?: 'active' | 'muted' | 'bypassed'
            }
          >
          links: Record<
            string,
            {
              from:
                | { node: string; port: string }
                | { reroute: string }
                | { valueSource: string }
                | { selector: string; candidate?: string }
              to: { node: string; port: string } | { reroute: string } | { selector: string; candidate?: string }
            }
          >
          reroutes: Record<string, { id: string }>
          valueSources?: Record<
            string,
            {
              id: string
              value: unknown
              spec?: { widgetType?: string; options?: Record<string, unknown> }
              title?: string
            }
          >
          selectors?: Record<
            string,
            {
              id: string
              candidates: ReadonlyArray<{ id: string; title?: string }>
              policy: { kind: 'fixed'; candidate: string } | { kind: 'random' }
              title?: string
            }
          >
          nets: Record<
            string,
            {
              id: string
              name: string
              source: { node: string; port: string }
              sinks: ReadonlyArray<{ node: string; port: string }>
            }
          >
          nextOrdinal: number
          boundary?: {
            inputs: ReadonlyArray<{ id: string; binds: { kind: string; node: string; port?: string; tap?: string } }>
            outputs: ReadonlyArray<{ id: string; binds: { kind: string; node: string; port?: string; tap?: string } }>
          }
        }
      >
      surfaces?: Record<
        string,
        { id: string; type: string; config: Record<string, unknown> }
      >
      /** Sparse occurrence-local topology overlays keyed by occurrence key. */
      occurrenceTopologies?: Record<
        string,
        {
          owner: { instancePath: readonly string[]; node: string }
          links: Record<string, { from: unknown; to: unknown }>
          suppressedDeliveries?: readonly unknown[]
        }
      >
      /** Root namespaced extension escape hatch (e.g. 'dinkster.exposed'). */
      ext?: Record<string, unknown>
      view: {
        bookmarks?: Record<
          string,
          {
            graphStack: readonly string[]
            instancePath: readonly string[]
          } & (
            | { view: { x: number; y: number; width: number; height: number }; viewport?: never }
            | { viewport: { x: number; y: number; scale: number }; view?: never }
          )
        >
        graphs: Record<
          string,
          {
            nodes: Record<
              string,
              {
                position?: { x: number; y: number }
                size?: { width: number; height: number }
                collapsed?: boolean
                video?: { loop: boolean; muted: boolean; autoplay: boolean }
                sections?: Record<string, { collapsed: boolean }>
                views?: Record<string, string>
              }
            >
            reroutes?: Record<string, { position: { x: number; y: number } }>
            valueSources?: Record<string, { position: { x: number; y: number } }>
            selectors?: Record<string, { position: { x: number; y: number } }>
            groups?: Record<
              string,
              {
                id: string
                title: string
                bounds: { x: number; y: number; width: number; height: number }
                color?: string
              }
            >
            collapsedNets?: readonly string[]
            guideNets?: readonly string[]
            boundary?: {
              inputs?: { position: { x: number; y: number } }
              outputs?: { position: { x: number; y: number } }
            }
          }
        >
      }
    }
  }
  graphStack: { get(): readonly string[]; set(value: readonly string[]): void }
  instancePath: { get(): readonly string[]; set(value: readonly string[]): void }
}

interface DinksterTestBridge {
  semanticDerivations: number
  setOccurrencePlanner?(planner: {
    planOccurrenceLinkMutation(document: unknown, resolver: unknown, intention: unknown):
      | { ok: true; invocation: { command: string; params: unknown } }
      | { ok: false; diagnostics: readonly unknown[] }
  } | undefined): void
  app: {
    store: {
      executions: {
        get(): Map<
          string,
          {
            queuedAt: number
            ref: DinksterBridgeExecutionRef
            status: string
            errors: readonly unknown[]
            artifact?: {
              prompt: Record<string, unknown>
              scope: { kind: string }
              partialTargets?: readonly string[]
              /** Exact selector resolutions this compile recorded. */
              choices?: ReadonlyArray<{
                graph: string
                selector: string
                policy: 'fixed' | 'random'
                candidate: string
              }>
            }
            nodes: Record<string, unknown>
            outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
          }
        >
      }
      apply(event: DinksterBridgeErrorEvent | DinksterBridgePreviewEvent | DinksterBridgeLifecycleEvent): void
      /** Register a run directly (AP5 spec bypasses the compile path). */
      register(ref: DinksterBridgeExecutionRef, artifact: DinksterBridgeCompileArtifact, timestamp?: number): void
    }
    connection: {
      status: { get(): string }
      simulateConnectionLoss(): void
    }
    tabs: { get(): readonly DinksterBridgeTab[] }
    activeTab(): DinksterBridgeTab | undefined
    dispatchTo(tab: DinksterBridgeTab, invocation: { command: string; params: unknown }): { ok: boolean; diagnostics?: readonly unknown[] }
    /** Queue a tab against its target backend (same path as the queue button). */
    queue(tab: DinksterBridgeTab): Promise<void>
    queueSelection(tab: DinksterBridgeTab, nodeIds: readonly string[]): Promise<void>
    exportDocument(tabId: string): unknown
    exportWorkflow(tabId: string): boolean
    importWorkflowFile(file: Pick<File, 'name' | 'text'>): Promise<boolean>
    /** Compile a tab against its target backend (undefined: no registry). */
    compileTab(tab: DinksterBridgeTab):
      | { ok: true; artifact: DinksterBridgeCompileArtifact & { snapshot: DinksterBridgeTab['store']['doc']; revision: number } }
      | { ok: false; diagnostics: readonly unknown[] }
      | undefined
    registerRun(tab: DinksterBridgeTab, ref: DinksterBridgeExecutionRef, artifact: DinksterBridgeCompileArtifact): void
    /** Open (or focus) the frozen view of a registered execution. */
    openExecutionView(ref: DinksterBridgeExecutionRef): boolean
    openDocument(json: unknown, title: string, importVia?: undefined, forkOnCollision?: boolean): readonly unknown[]
    /** Register another backend without UI panel juggling (owner-race specs). */
    addBackend(baseUrl: string, label?: string, start?: boolean, protocol?: string, persist?: boolean): ReturnType<DinksterTestBridge['app']['backends']['get']>[number] | undefined
    refreshBackendSchemas(backend: ReturnType<DinksterTestBridge['app']['backends']['get']>[number]): Promise<void>
    backendForTab(tab: DinksterBridgeTab): ReturnType<DinksterTestBridge['app']['backends']['get']>[number]
    registerSchemas(schemas: readonly unknown[]): void
    openTemplate(packId: string, templateId: string, title: string, owner: string): Promise<boolean>
    openEditorForBinding(tabId: string, context: { editorRole?: string; nodeId?: string; widgetType?: string; valueType?: string }): boolean
    dock: {
      activate(zone: 'left' | 'right' | 'bottom', panelId: string): void
      setOpen(zone: 'left' | 'right' | 'bottom', open: boolean): void
    }
    problems: { get(): ReadonlyArray<{ severity: string; code: string; message: string }> }
    /** Append diagnostic objects under one tab owner (badge lifecycle specs). */
    reportProblems(owner: string, diagnostics: readonly unknown[]): void
    /** Drop every diagnostic held by one owner (badge lifecycle specs). */
    clearProblems(owner: string): void
    /** Pack-layer deprecation/replacement rule; diagnostics on rejection. */
    registerReplacementRule(layer: 'pack' | 'core', rule: unknown): readonly unknown[]
    /** Pack manifest installation + per-contribution gating (section 11). */
    extensions: {
      register(
        manifest: {
          id: string
          displayName?: string
          uses?: readonly string[]
          contributions: ReadonlyArray<{ id: string; category: string; label?: string }>
        },
        activate: (api: {
          menu(id: string, contribution: unknown): void
          widgetKind(id: string, kind: unknown): void
          widgetView(id: string, view: unknown): void
          previewRenderer(id: string, renderer: unknown): void
          command(id: string, command: unknown): void
          setting(id: string, setting: unknown): void
          editor(id: string, kind: { id: string; title: string; provider(context: unknown): unknown }): void
          editorBinding(id: string, binding: {
            id: string
            editor: string
            match: { editorRole?: string; nodeId?: string; widgetType?: string; valueType?: string }
            priority?: number
          }): void
          panel(
            id: string,
            slot: 'sidebar.left' | 'sidebar.right' | 'panel.bottom' | 'toolbar.canvas',
            provider: (context: unknown) => unknown,
            order?: number,
            title?: string,
          ): void
          searchProvider(id: string, provider: {
            readonly id: string
            readonly label: string
            readonly prefix?: string
            readonly priority: number
            readonly async?: boolean
            query(query: string, context: {
              readonly activeTab?: { readonly id: string; readonly title: string }
              readonly selection: { readonly nodes: readonly string[] }
              readonly signal: AbortSignal
            }): readonly unknown[] | Promise<readonly unknown[]>
          }): void
          hostUi(
            id: string,
            slot: 'status.trailing',
            provider: (context: {
              version: 1
              surface: 'status' | 'widget-editor' | 'preview-viewer'
              data: null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>>
            }) => unknown,
            order?: number,
            title?: string,
          ): void
        }) => void,
      ): ReadonlyArray<{ severity: string; code: string; message: string }>
      unregister(packId: string): void
      setPackEnabled(packId: string, enabled: boolean): void
      setCategoryEnabled(packId: string, category: string, enabled: boolean): void
      setContributionEnabled(contributionId: string, enabled: boolean): void
      packs(): ReadonlyArray<{
        manifest: { id: string; displayName?: string }
        registered: boolean
        active: boolean
        enabled: boolean
        policyBlocked: boolean
        policyReason?: string
        categories: ReadonlyArray<{
          category: string
          enabled: boolean
          policyBlocked: boolean
          policyReason?: string
        }>
        contributions: ReadonlyArray<{
          decl: { id: string; category: string; label?: string }
          contributed: boolean
          active: boolean
          policyBlocked: boolean
          policyReason?: string
          enabled: boolean
          state: 'active' | 'inactive' | 'unregistered' | 'failed'
        }>
        diagnostics: ReadonlyArray<{ severity: string; code: string; message: string }>
      }>
    }
    /** Per-live-tab execution-overlay pins (view state): tab id -> pinned run. */
    overlayPins: { get(): ReadonlyMap<string, DinksterBridgeExecutionRef> }
    activeTabId: { get(): string; set(id: string): void }
    /** Editor seam: resolves each tab's editorKind to a center-region editor. */
    editors: {
      register(descriptor: { id: string; title: string; component: () => unknown }): () => void
      get(id: string): { id: string; title: string } | undefined
    }
    /** Multi-backend surface: connected backends and per-tab targeting. */
    backends: {
      get(): ReadonlyArray<{
        id: string
        label: string
        baseUrl: string
        protocol: 'v1' | 'dinkster'
        connection: { status: { get(): string }; ingest(event: Readonly<Record<string, unknown>> & { type: string }): void }
        schemaState: { get(): { status: string } }
        registry: { get(): {
          schemas: Map<string, unknown>
          diagnostics: readonly { code: string; data?: Readonly<Record<string, unknown>> }[]
        } | undefined }
        workerCatalog: {
          get():
            | { status: 'unsupported' | 'loading' }
            | { status: 'ready'; workers: readonly unknown[] }
            | { status: 'error'; message: string }
        }
      }>
    }
    tabTargets: { get(): ReadonlyMap<string, string> }
    setTabTarget(tabId: string, id: string): void
    removeBackend(id: string): void
    viewUrlForExecution(ref: DinksterBridgeExecutionRef, file: { filename: string }): string
  }
  renderer?: {
    fitToScene(margin?: number): void
    getViewport(): { x: number; y: number; scale: number }
    setViewport(viewport: { x: number; y: number; scale: number }): void
    /** Grid preference as the renderer holds it (canvas.grid.visible). */
    getGridVisible(): boolean
    /** Ephemeral overlay state; specs assert ghost-noodle persistence. */
    getOverlay(): {
      /** Selected ordinary and boundary-node scene ids. */
      selection?: ReadonlySet<string>
      ghostLink?: { x1: number; y1: number; x2: number; y2: number; typeName?: string }
      /** The reroute whose ghost in/out sockets are revealed (hover). */
      hoveredReroute?: string
      /** Exact ordinary pin under the idle pointer. */
      hoveredPin?: { nodeId: string; portId: string; direction: 'in' | 'out' }
      /** Exact widget row under the idle pointer. */
      hoveredWidget?: { nodeId: string; valueKey: string }
    }
    getBadges(): Readonly<Record<string, ReadonlyArray<{ id: string }>>>
    getNodeOutputTexts(): Readonly<Record<string, { text: string; stale?: true; estimate?: true }>>
    /** Selection toolbox placement (undefined = hidden). */
    getToolboxLayout():
      | {
          x: number
          y: number
          width: number
          height: number
          rows: ReadonlyArray<{
            x: number
            y: number
            width: number
            height: number
            panel: { x: number; y: number; width: number; height: number }
            entries: ReadonlyArray<
              | { kind: 'button'; button: { id: string }; x: number; y: number; size: number }
              | { kind: 'separator'; x: number; y: number; width: number; height: number }
            >
          }>
          buttons: ReadonlyArray<{
            button: { id: string; glyph?: string; icon?: string; iconColor?: string; label: string; active?: boolean; disabled?: boolean; reason?: string }
            x: number
            y: number
            size: number
          }>
        }
      | undefined
    getNodePreviews(): Readonly<Record<string, {
      kind?: 'image' | 'video' | 'audio' | 'model3d'
      image?: CanvasImageSource
      src?: string
      mime?: string
      colorTransform?: string
      width?: number
      height?: number
      status?: 'loading' | 'unavailable' | 'failed'
      statusMessage?: string
      count?: number
      index?: number
      state?: 'cached' | 'estimate'
    }>>
    /** Install decoded previews directly (perf workloads bypass the loader). */
    setNodePreviews(
      previews: Readonly<Record<string, {
        kind?: 'image' | 'video' | 'audio' | 'model3d'
        image?: CanvasImageSource
        src?: string
        mime?: string
        colorTransform?: string
        width?: number
        height?: number
        status?: 'loading' | 'unavailable' | 'failed'
        count?: number
        index?: number
        state?: 'cached' | 'estimate'
      }>>,
    ): void
    getScopeHighlight():
      | {
          nodes: ReadonlySet<string>
          reroutes: ReadonlySet<string>
          selectors: ReadonlySet<string>
          selectorCandidates: ReadonlySet<string>
          valueSources: ReadonlySet<string>
        }
      | undefined
    /** Frozen-view execution resolutions: selector id -> recorded candidate. */
    getSelectorResolutions(): ReadonlyMap<string, string> | undefined
    /** Active renderer capabilities. Lens ids never enter the render path. */
    getLensCapabilities(): {
      nodeBodyContent?: (node: DinksterBridgeSceneNode) =>
        ReadonlyArray<{ label: string; text: string; tone?: string }> | null
    }
    getScene(): {
      graphId: string
      nodes: readonly DinksterBridgeSceneNode[]
      links: ReadonlyArray<{
        id: string
        from:
          | { kind: 'port'; node: string; port: string }
          | { kind: 'reroute'; reroute: string }
          | { kind: 'valueSource'; valueSource: string }
          | { kind: 'selector'; selector: string; candidate?: string }
        to:
          | { kind: 'port'; node: string; port: string }
          | { kind: 'reroute'; reroute: string }
          | { kind: 'selector'; selector: string; candidate?: string }
        x1: number
        y1: number
        x2: number
        y2: number
        netId?: string
        netName?: string
        hidden?: true
        mismatch?: true
      }>
      reroutes: ReadonlyArray<{
        id: string
        x: number
        y: number
        typeName?: string
      }>
      valueSources: ReadonlyArray<{
        id: string
        x: number
        y: number
        width: number
        height: number
        title: string
        valueText: string
        specState: 'declared' | 'derived' | 'raw'
        conflict: boolean
        typeName?: string
      }>
      selectors: ReadonlyArray<{
        id: string
        x: number
        y: number
        width: number
        height: number
        headerHeight: number
        title: string
        candidates: ReadonlyArray<{ id: string; label: string; y: number; typeName?: string }>
        activeCandidate?: string
        random: boolean
        typeName?: string
      }>
      netStubs: ReadonlyArray<{
        id: string
        netId: string
        name: string
        role: 'source' | 'sink'
        mismatch?: true
        nodeId: string
        portId: string
        pinX: number
        pinY: number
        x: number
        y: number
        width: number
        height: number
        authored?: true
        guide?: true
      }>
      groups: ReadonlyArray<{
        id: string
        title: string
        x: number
        y: number
        width: number
        height: number
        color?: string
      }>
      boundaryNodes: ReadonlyArray<{
        side: 'inputs' | 'outputs'
        x: number
        y: number
        layout: {
          width: number
          height: number
          headerHeight: number
          pins: ReadonlyArray<{ portId: string; direction: 'in' | 'out'; y: number }>
        }
      }>
      /** Solver diagnostics for the rendered graph (type mismatches etc.). */
      diagnostics: ReadonlyArray<{ severity: string; origin: string; code: string; message: string }>
    }
  }
  controller?: {
    getSelection(): ReadonlySet<string>
    getRerouteSelection(): ReadonlySet<string>
    getValueSourceSelection(): ReadonlySet<string>
    getSelectorSelection(): ReadonlySet<string>
    getGroupSelection(): ReadonlySet<string>
    selectAll(): void
    setSelection(
      nodeIds: Iterable<string>,
      linkIds?: Iterable<string>,
      rerouteIds?: Iterable<string>,
      valueSourceIds?: Iterable<string>,
      selectorIds?: Iterable<string>,
      groupIds?: Iterable<string>,
    ): void
  }
  syntheticWorkflow(options: {
    chains: number
    chainLength: number
    reroutes?: boolean
    valueSources?: boolean
    nets?: boolean
    groups?: boolean
    selectors?: boolean
  }): unknown
}

interface Window {
  __dinksterTest?: DinksterTestBridge
}
