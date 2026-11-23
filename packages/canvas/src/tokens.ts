/**
 * Canvas paint tokens project shared semantic roles and own the fixed
 * geometry used together by drawing, layout and hit testing.
 */

import { canvasSemanticTokens, semanticTokensForTheme, canonicalTypeIdOf, IMAGE_OPACITY_MAX, parseAssetTypeId, parseListTypeId, type NodeRunState, type TypeExpr } from '@dinkster/core'

/** Fixed paint geometry shared with layout and hit testing. */
export const canvasPaintTokens = {
  detailMinScale: 0.5,
  imageOpacityScale: IMAGE_OPACITY_MAX,
  editor: {
    imageCompare: { initialSplit: 50, percentScale: 100, dividerColor: '#ffffff', dividerWidth: 2 },
    boundingBox: { outsideColor: '#00000080', strokeColor: '#ffffff', strokeMinWidth: 1, strokeImageScale: 300 },
    painter: { defaultDimension: 512, initialColor: '#ffffff', backgroundColor: '#000000', initialBrushSize: 24 },
  },
  memory: {
    graphMinWidth: 240, graphFallbackWidth: 600, graphHeight: 96, graphTopInset: 8,
    reservedOpacity: 0.34, footprintOpacity: 0.62, strokeWidth: 1, capacityDash: [4, 3],
    heatmapMinWidth: 120, heatmapFallbackWidth: 480, cellPitch: 7, cellSize: 6,
    pageColor(resident: boolean, fraction: number): string {
      const target = resident ? [230, 126, 34] : [58, 58, 58]
      const source = resident ? [255, 220, 0] : [200, 60, 60]
      return `rgb(${target.map((channel, index) => Math.round(source[index]! * fraction + channel * (1 - fraction))).join(',')})`
    },
  },
  grid: { spacing: 32, minScreenSpacing: 12, dotRadius: 1.5 },
  hit: {
    pinRadius: 9,
    resizeSize: 10,
    linkRadius: 6,
    linkMidpointRadius: 12,
    reroutePadding: 4,
    rerouteSocketPadding: 5,
    overviewPinRadius: 5,
    overviewLinkRadius: 4,
    overviewRerouteRadius: 5,
  },
  scene: {
    nodeFallbackX: 40,
    nodeFallbackStepY: 120,
    valueSourceFallbackStepY: 60,
    rerouteFallbackStepY: 60,
    selectorFallbackStepY: 100,
    emptyGraphWidth: 320,
    boundaryGap: 120,
    fallbackValueMaxCharacters: 42,
  },
  viewport: { initialOffset: 40, fitMargin: 60, minFitScale: 0.1, maxFitScale: 2 },
  graphCache: { tilePixels: 512, bleedPixels: 2 },
  badge: {
    radius: 3,
    baselineOffset: 0.5,
    /** The subgraph mark at the right end of the title bar. */
    /** `iconSize` is the drawn size of the mark's icon. */
    mark: { size: 20, hitSize: 20, iconSize: 14, padding: 3, gap: 3 },
    tab: {
      height: 20,
      fontSize: 11,
      /** Distance from the node's left and right outer edges to the first tab. */
      inset: 0,
      /** Gap between the node's painted outer edge and its tabs. */
      offset: 3,
      gap: 2,
      padding: 6,
      /** Drawn size of a tab's icon. */
      iconSize: 14,
      iconGap: 4,
      maxLabelWidth: 120,
      stroke: 1,
      /** Shares of the tab's color: its fill over the canvas, its line over the canvas, its words over the title color. */
      fillMix: 0.16,
      hoverFillMix: 0.3,
      lineMix: 0.65,
      textMix: 0.7,
    },
    colors: {
      subgraph: '#4a4a5e',
      executionError: '#b3402f',
      warning: '#8a6d1f',
      expanded: '#315d73',
      info: '#3a5a68',
      documentError: '#c13f32',
    },
  },
  controller: {
    /** Drawn size of the mode icon as a share of its square chip, centered in it. */
    chipIconRatio: 0.6,
    edgeWidth: 12,
    glyphHalf: 3,
    verticalInset: canvasSemanticTokens.space[4],
    textGap: 6,
    fieldInset: 6,
  },
  dash: {
    anyPin: [2, 1.75],
    groupSelection: { world: [6, 4], screen: [4, 3] },
    ghost: { world: [6, 4], screen: [4, 3] },
    maybeAbsentLink: { world: [9, 5], screen: [5, 3] },
    netGuide: { world: [7, 5], screen: [7, 5] },
    selectionUnion: { world: [5, 4], screen: [4, 3] },
    marquee: { world: [4, 3], screen: [3, 2] },
    remote: [6, 4],
    blockingWarning: { world: [1, 3], screen: [1, 3] },
    growth: [3, 3],
    companionUnderline: [1, 2],
    running: { world: [13, 9], screen: [9, 6] },
    boundary: { world: [5, 3], screen: [4, 3] },
  },
  stateDash: {
    pending: { world: [2, 3], screen: [2, 3] },
    cached: { world: [7, 3], screen: [5, 3] },
    skipped: { world: [2, 4], screen: [2, 4] },
    error: { world: [4, 2], screen: [4, 2] },
    muted: { world: [2, 3], screen: [2, 3] },
    bypassed: { world: [8, 3], screen: [5, 3] },
  },
  node: {
    titleWidthPadding: canvasSemanticTokens.space[8],
    portLabelPadding: 6,
    labelPinGap: canvasSemanticTokens.space[4],
    pairedPortGap: canvasSemanticTokens.space[24],
    sectionWidthPadding: 18,
    growthWidthPadding: 18,
    widgetLabelPadding: canvasSemanticTokens.space[12],
    widgetValueMinWidth: 90,
    widgetColumnGap: 20,
    /** Rows an open text result shows by default at most; the node's bottom edge sizes it past that. */
    textOutputMaxRows: 6,
    /** Rows an open text result shows at least. */
    textOutputMinRows: 2,
    /**
     * The bar on the bottom edge of a node whose preview is open: the text
     * box's bar (`widget.textBoxEdge`), its top `barRise` above the node's
     * edge so it sits on the edge, and a band around the edge that drags it.
     * Arrow keys on a pressed bar step a picture's height by `keyStep`; a text
     * result steps one row.
     */
    previewEdge: { barRise: 1, hitAbove: 5, hitBelow: 5, keyStep: 10 },
    missing: { portLabelPadding: 4, pairedPortGap: 16, tapLabelPadding: 20 },
    widgetPinGap: canvasSemanticTokens.space[4],
    pinOverhang: canvasSemanticTokens.space[12],
    modeOpacity: canvasSemanticTokens.interaction.disabledOpacity,
    /** `crisp` is the idle outline of a node look with crisp edges. */
    outline: { idle: 1.25, crisp: 1, strong: 2.5, unrecognizedFactor: 3, screen: 1, strongScreen: 2 },
    identityBodyTint: 0.18,
    identityHeaderTint: 0.72,
    errorBodyTint: 0.2,
    errorHeaderTint: 0.35,
    /** The flat-title look's rule under the title, inside the title bar. */
    headerRuleStroke: 1,
    titleBadgeGap: canvasSemanticTokens.space[4],
    /**
     * The minimize arrow at the left end of the title bar: its square target
     * starts `left` in from the node's edge, and the title starts where the
     * target ends. The arrow itself is the section disclosure triangle.
     */
    minimizeArrow: { left: 5, target: 18, hoverRadius: 3 },
    drop: { outset: 2, opacity: 0.65, stroke: 1.5 },
    scope: { outset: 5, stroke: 2.5, minScreenStroke: 2 },
    progress: { height: 3, minScreenHeight: 1.5 },
    /**
     * The space an editor shown in the node takes under its editor button
     * row when unfolded: a padded picture, then rows of its own controls.
     */
    editorSpace: {
      /** An unfolded editor keeps the node at least this wide. */
      minWidth: 260,
      pad: 6,
      gap: 6,
      /** A dragged picture height is kept within these. */
      pictureMin: 60,
      pictureMax: 1200,
      /** Height of the bar on a picture's bottom edge that is dragged. */
      resizeBar: 6,
    },
    /**
     * Sections, groups, members and a choice's option rows drawn as boxes.
     * Horizontal values step in from the node's edge; vertical ones sit on
     * the row grid, so a closed row is as tall as a field.
     */
    box: {
      stroke: 1,
      radius: 5,
      /** Each box inside a box steps in this far from the outline around it. */
      step: 6,
      /**
       * A field inside a box sits this far inside its outline, and the
       * outline's inner side lines up with a field outside any box, so a
       * field in one box is this much narrower on each side.
       */
      fieldGap: 3,
      /** The open header is this much shorter than the closed row, inside the outline. */
      headerShrink: 2,
      /** From the last field in a box to its outline. */
      bottomGap: 3,
      /** An open box with no name: room above its outline for the tab, and below it. */
      tabGap: 6,
      tabPad: 4,
      tab: { width: 18, height: 10, inset: 5, radius: 3 },
      /** A choice's option box starts this far up its dropdown and pads its first row. */
      optionOverlap: 3,
      optionPad: 4,
      textInset: 6,
      arrow: { halfWidth: 3, length: 4 },
      labelGap: 6,
      countFontSize: 11,
      dotRadius: 2.5,
      dotGap: 6,
      /** Width of a member's grip; a member's header keeps it before the label. */
      gripWidth: 5,
      /** A grip's square of six dots, and the width of its target across its row. */
      grip: { height: 7, dot: 0.9, hit: 16 },
      /** Where a dragged member would land between the others. */
      dropLine: 2,
      /** A remove cross; a field it ends stops `fieldGap` before it. */
      cross: { size: 7, reserve: 18, stroke: 1, fieldGap: 4 },
      /** Name, arrow, dot and count room beside a header's text. */
      widthPadding: 40,
      /** Center distance of the pins a closed box gathers at one end, by how many there are. */
      clusterPitch: { two: 7, three: 6 },
      /** A ring in the node's color around each pressed-together pin, so pins of one color stay apart. */
      clusterRing: 1.5,
      /** Most pins drawn at one end of a closed box. */
      clusterMax: 3,
    },
    section: {
      horizontalInset: 1,
      verticalInset: 2,
      glyphInset: canvasSemanticTokens.space[4],
      arrowBack: 2.5,
      arrowTip: 3.5,
      arrowHalfWidth: canvasSemanticTokens.space[4],
      labelOffset: 9,
      labelReserve: 13,
      modifiedInset: 3,
      modifiedRadius: 2.5,
    },
  },
  region: {
    inset: 3,
    stroke: 1,
    glyphInset: 6,
    glyphRadius: 5,
    glyphStartAngle: 0.25,
    glyphEndAngle: 1.8,
    glyphStroke: 1.4,
    arrow: { startX: 5, startY: -2, tipX: 7, tipY: 2, endX: 2, endY: 1 },
    fontMinSize: 9,
    fontReduction: 2,
    labelInset: canvasSemanticTokens.space[16],
    titleGap: canvasSemanticTokens.space[8],
  },
  pin: {
    dividerScreen: 1,
    dividerMinWorld: 0.75,
    dividerMaxWorld: canvasSemanticTokens.space[4],
    diamondScale: 1.25,
    /**
     * The pin for an input that takes one value or a list: the list diamond
     * behind a smaller circle with a dark ring around the circle. Multiples of
     * an ordinary pin's radius: the diamond's corner, the circle's radius and
     * the ring's width.
     */
    eitherDiamond: 1.65,
    eitherCircle: 0.75,
    eitherRing: 0.22,
    /** A pointed pin's radius grows by this many pixels, so an 11px disc becomes 13px on the same whole-pixel center. */
    hoverGrowth: 1,
    statusRingGap: 3.5,
    statusRingStroke: canvasSemanticTokens.interaction.focusRingWidth,
    outlineStroke: 1,
    optionalMinRadius: 1.5,
    optionalRadiusRatio: 0.32,
    overviewMinRadius: 2,
    ghostStroke: 1.5,
    ghostMinScreenStroke: 1,
  },
  running: {
    pulsePeriodMs: 1400,
    reducedMotionPulse: 0.5,
    glowOpacity: 0.48,
    glowPulseOpacity: 0.22,
    glowOutset: 2,
    glowStroke: 4.5,
    glowMinScreenStroke: 3,
    glowBlur: canvasSemanticTokens.space[8],
    glowPulseBlur: 5,
    accentStroke: 1.5,
    accentMinScreenStroke: 1.5,
    dashSpeed: 0.032,
  },
  toolbox: {
    buttonSize: 28,
    /** Drawn size of a button's icon, centered in the button. */
    iconSize: 16.8,
    gap: 5,
    padding: 6,
    selectionGap: canvasSemanticTokens.space[16],
    badgeGap: 6,
    separatorWidth: 1,
    separatorHeightRatio: 0.6,
    nodeSelectionOutset: 3,
    selectionStroke: canvasSemanticTokens.interaction.focusRingWidth,
    selectionMinScreenStroke: 2,
    cullScreenPadding: 1,
    boundarySelectionOutset: 2,
    multiSelectionPadding: canvasSemanticTokens.space[8],
    multiSelectionStroke: 1,
    panelRadius: canvasSemanticTokens.space[8],
    innerRadius: 3,
    borderStroke: 1,
    buttonRadius: 5,
    disabledOpacity: 0.4,
    glyphBaselineOffset: 0.5,
  },
  reroute: {
    radius: 13,
    socketGap: 8,
    socketRadius: 5,
    cullPadding: 6,
    stroke: 1,
    selectionOutset: 3,
    socketStroke: 2,
  },
  boundary: {
    stroke: 1.25,
    minScreenStroke: 1,
    dropOutset: 2,
    dropStroke: 2,
    labelPinGap: canvasSemanticTokens.space[4],
    /** Space between the panel title and the quieter text naming whose values its fields carry. */
    subtitleGap: canvasSemanticTokens.space[4],
  },
  valueSource: {
    heightPadding: 8,
    minWidth: 90,
    badgeSize: 14,
    badgeInset: 6,
    stroke: 1,
    strongStroke: 2,
    badgeGap: canvasSemanticTokens.space[4],
    valueGap: canvasSemanticTokens.space[8],
    baselineOffset: 0.5,
    badgeRadiusInset: 2,
    badgeFontWeight: 700,
    badgeFontReduction: 2,
    badgeStroke: 1.5,
  },
  selector: {
    widthPadding: canvasSemanticTokens.space[8],
    minWidth: 110,
    badgeSize: 14,
    badgeInset: 6,
    selectionOutset: 3,
    selectionStroke: 2,
    stroke: 1.25,
    minScreenStroke: 1,
    badgeGap: canvasSemanticTokens.space[4],
    badgeRadius: 3,
    badgeStroke: 1,
    badgeFontSize: 9,
    baselineOffset: 0.5,
    accentInset: 1.5,
    accentVerticalInset: 3,
    accentWidth: 2.5,
    labelPinGap: canvasSemanticTokens.space[4],
  },
  net: {
    gap: 10,
    height: 18,
    paddingX: 6,
    leadCullPadding: 1,
    leadStroke: 2,
    leadMinScreenStroke: 1,
    mismatchLeadStroke: 3,
    mismatchMinScreenStroke: 1.5,
    stroke: 1,
    mismatchStroke: 2,
    selectionOutset: 3,
    selectionStroke: 2,
    baselineOffset: 0.5,
  },
  presence: {
    linkStroke: 2.5,
    ghostOpacity: 0.55,
    dragStroke: 1.5,
    hoverStroke: 1,
    hoverOpacity: 0.5,
    hoverOutset: canvasSemanticTokens.space[4],
    selectionStroke: 2,
    selectionOpacity: 0.9,
    selectionOutset: 7,
    rerouteOutset: 6,
    rerouteRankGap: 3,
    cursor: { tailY: 16, notchX: 4.6, notchY: 12.2, tip: 11, stroke: 1.25 },
    label: { x: 12, y: 18, paddingX: 5, heightPadding: 7, color: '#fff', baselineOffset: 0.5 },
  },
  overlay: {
    marqueeOpacity: 0.08,
    marqueeStroke: 1,
    ghostStroke: 1.5,
    placementOpacity: 0.6,
  },
  group: {
    minSize: 60,
    headerHeight: 26,
    fillOpacity: 0.14,
    headerOpacity: 0.45,
    borderOpacity: 0.8,
    stroke: 1,
    selectedStroke: 2,
    selectionOutset: 2,
    cullScreenPadding: 1,
  },
  type: {
    multilineLeadingNumerator: 4,
    multilineLeadingDenominator: 3,
    semiboldWeight: 600,
    /** Noto Sans capital height in ems; a pin's name centers its capitals on the pin. */
    capHeight: 0.714,
    smallMinSize: 9,
    smallReduction: 1,
    adornmentMinSize: 8,
    adornmentReduction: 2,
  },
  adornment: {
    antialiasPadding: 2,
    boundsFontFactor: 2,
    linkOffsetY: -7,
    outputPinGap: canvasSemanticTokens.space[4],
    outputOffsetY: 10,
  },
  /** The filled circle icon's radius is a share of the icon's drawn size. */
  icon: { circleRadiusRatio: 11 / 30, viewBoxSize: 24, stroke: 2 },
  virtualNote: {
    verticalPadding: canvasSemanticTokens.space[8],
    bodyTint: 0.28,
    bodyInset: 1,
    minLineHeight: canvasSemanticTokens.space[16],
    lineGap: 5,
    headingSizeOffset: canvasSemanticTokens.space[4],
    boldWeight: 700,
    regularWeight: 400,
    listIndent: canvasSemanticTokens.space[16],
  },
  preview: {
    palette: { availableWidthPadding: 16, maxHeight: 240, inset: 6 },
    appWidgetFallbackWidth: 320,
    unknownPlacement: { width: 180, height: 88 },
    stroke: 1,
    minRadius: 2,
    radiusInset: 1,
    checkerSize: canvasSemanticTokens.space[16],
    placeholderOpacity: 0.65,
    labelPadding: canvasSemanticTokens.space[8],
    mediaBadgeMinWidth: 48,
    mediaBadgePadding: canvasSemanticTokens.space[12],
    mediaBadgeHeight: 20,
    provenancePosition: 0.25,
    metadataPosition: 0.75,
    outputPadding: canvasSemanticTokens.space[4],
    staleStroke: 1,
    staleUnderlineOffset: 1,
    /** The "Preview" caption row over a preview or text result. */
    caption: {
      padLeft: 6,
      padRight: canvasSemanticTokens.space[8],
      gap: 6,
      thumbHeight: canvasSemanticTokens.space[16],
      thumbMaxWidth: 28,
      radius: canvasSemanticTokens.space[4],
    },
  },
  lensAffordance: {
    rowMinSize: 10,
    rowMaxSize: 14,
    rowPadding: canvasSemanticTokens.space[8],
    previewSize: canvasSemanticTokens.space[16],
    previewInset: canvasSemanticTokens.space[8],
    disabledOpacity: 0.45,
    stroke: 1.5,
    radius: 3,
    check: { startX: 0.25, startY: 0.52, middleX: 0.43, middleY: 0.7, endX: 0.76, endY: 0.32 },
    plus: { start: 0.3, end: 0.7 },
  },
  dataPanel: {
    borderInset: 1,
    minHeight: 10,
    minWidth: 20,
    scrimOpacity: 0.92,
    rowHeight: 17,
    verticalPadding: 3,
    horizontalPaddingReduction: 2,
    labelRatio: 0.45,
    staleOpacity: 0.55,
    valueGap: canvasSemanticTokens.space[8],
  },
  opacity: {
    ghost: canvasSemanticTokens.interaction.disabledOpacity,
    scopeDim: 0.72,
  },
  link: {
    minControlOffset: 40,
    controlOffsetRatio: 0.5,
    paintPadding: canvasSemanticTokens.space[4],
    stroke: 2.5,
    minScreenStroke: 1,
    selectedStroke: 5.5,
    selectedMinScreenStroke: 2,
    mismatchStroke: 3,
    mismatchMinScreenStroke: 1.5,
    guideCasingStroke: 4.5,
    guideCasingMinScreenStroke: 3,
    guideStroke: 2.5,
    guideMinScreenStroke: 1.5,
    cullMinPadding: 5,
    cullScreenPadding: 1,
    midpointRadius: 3.5,
    hoveredMidpointRadius: 5,
    midpointStroke: 1,
    hoveredMidpointStroke: 1.5,
    nameOffset: 3,
  },
  widget: {
    /**
     * A row that opens an editor: `iconSize` is the drawn size of its kind icon
     * and chevron, `iconInset` the kind icon's distance from the row's left
     * edge and `trailingInset` the chevron's from its right edge.
     */
    opener: { iconSize: 12, iconInset: 6, trailingInset: 8, iconReserve: 24, stroke: 1, strokeInset: 0.5, trailingReserve: 24 },
    /** The subgraph icon before the name of a field shown on the subgraph node without a wire; `size` is drawn. */
    subgraphMark: { size: 14, gap: canvasSemanticTokens.space[4] },
    curve: { sourceRows: 2, inset: 4, insetX: 6, minSampleHeight: 1 },
    /** The color square directly before a color code, the gap between squares in a row of them, and its checker cells. */
    valueSwatch: { size: 10, radius: 2, gap: 6, listGap: 4, checkerCell: 3, edge: 1 },
    /** A folded editor's small picture before its value, such as the stored frame. */
    valueThumbnail: { size: 16, radius: 2, gap: 6 },
    minLabelWidth: 44,
    minValueWidth: 56,
    labelValueGap: 5,
    labelWidthBias: 1.5,
    textPadding: 2,
    verticalInset: 2,
    radius: canvasSemanticTokens.space[4],
    labelWidthPadding: canvasSemanticTokens.space[12],
    labelClipPadding: canvasSemanticTokens.space[8],
    labelInset: 6,
    colorValueReserve: 32,
    structuredValueRatio: 0.55,
    valueWidthPadding: canvasSemanticTokens.space[16],
    swatchReserve: canvasSemanticTokens.space[16],
    toggleReserve: canvasSemanticTokens.space[12],
    toggle: {
      trailingInset: 22,
      halfHeight: 5,
      width: 20,
      height: 10,
      radius: 5,
      thumbInset: 1,
      checkedOffset: 11,
      thumbSize: canvasSemanticTokens.space[8],
      thumbRadius: canvasSemanticTokens.space[4],
    },
    chevron: { stroke: 1.5, topOffset: -2, bottomOffset: 1 },
    scrollbarMinThumbRatio: 2,
    /**
     * The short bar on a text box's bottom edge, measured from the row's
     * bottom. The bar widens under the pointer, while dragged and with
     * keyboard focus; the hit band spans the box's full width.
     */
    textBoxEdge: {
      width: 22,
      hotWidth: 34,
      height: 3,
      radius: 1.5,
      bottomOffset: 5,
      hitAbove: 7,
      hitBelow: 3,
      /** A box is 2 to 16 lines tall; an arrow key steps one line. */
      minLines: 2,
      maxLines: 16,
      keyStepLines: 1,
    },
    inactiveOpacity: canvasSemanticTokens.interaction.disabledOpacity,
    connectedOpacity: canvasSemanticTokens.interaction.disabledOpacity,
    hoverOpacity: 0.12,
    diagnosticStroke: 1.5,
    /** Outline of the field a held wire would take. */
    dropStroke: 2,
    connectedControllerOpacity: 0.5,
    connectedGlyphOpacity: 0.35,
    stepperStroke: 1.5,
    /** Moves a 1 px line onto a pixel row's center. */
    pixelCenter: 0.5,
    rangeFillAccentOpacity: 0.2,
    dragLineStroke: 2,
    /** A seed's mode icon before its value: drawn size, room kept before it, gap to the value. */
    modeIconSize: canvasSemanticTokens.space[12],
    modeIconLead: canvasSemanticTokens.space[4],
    modeIconGap: canvasSemanticTokens.space[8],
    staleValueStroke: 1.5,
    companion: { stroke: 1, underlineOffset: canvasSemanticTokens.space[4] },
    fallbackValueWidthPadding: canvasSemanticTokens.space[8],
    fallback: { opacity: 0.75, textInset: 4, labelRatio: 0.45, valueRatio: 0.5 },
    growth: { stroke: 1, verticalInset: 3, textPadding: canvasSemanticTokens.space[8] },
  },
  minimap: {
    fallbackWidth: 160,
    fallbackHeight: 96,
    margin: canvasSemanticTokens.space[8],
    maxScale: 0.25,
    viewportInset: 2,
    linkStroke: 0.3,
    stateStroke: 0.3,
    minPointRadius: 0.5,
    minNodeSize: 2,
    bypassFill: 'rgba(75, 24, 75, 0.9)',
    remoteStroke: 1.5,
    remoteOpacity: 0.8,
    viewportFillOpacity: 0.06,
    viewportStrokeOpacity: 0.5,
    viewportStroke: 1,
    viewportRadius: 3,
    markerRadius: 7,
    markerInset: 1,
    markerFontWeight: 700,
    markerFontSize: 9,
  },
} as const

/**
 * The editors that fold out in the node, by widget view id: the picture's own
 * height (absent for an editor without one) and how many rows of controls sit
 * under it. The rows are fixed for each editor, so the node does not change
 * height when the editor's state changes; a host that knows the controls
 * differ for good, such as a recorder on a backend that cannot take uploads,
 * gives their height in the widget's measure.
 */
export const IN_NODE_EDITORS: Readonly<Record<string, {
  readonly picture?: number
  readonly controlRows: number
  /**
   * The editor's own sections, closed at first, each one of the control rows
   * when closed and `rows` more when open. Their open state is kept with the
   * node's sections, under `<value key>.<section id>`.
   */
  readonly sections?: readonly { readonly id: string; readonly rows: number }[]
}>> = {
  // Record strip (two rows), Microphone, Limit, the stored clip's line.
  'core.audioRecord': { controlRows: 5 },
  // Start camera or Capture frame and Stop; the stored frame's line.
  'core.webcam': { picture: 180, controlRows: 2 },
  // Camera projection, Field of view, then Model placement and Animation closed.
  'core.load3d': {
    picture: 200,
    controlRows: 4,
    // Model position, rotation and scale; Animation clip, its time, its speed, Play.
    sections: [{ id: 'placement', rows: 3 }, { id: 'animation', rows: 4 }],
  },
  // Wipe divider, Image A frame, Image B frame.
  'core.imageCompare': { picture: 180, controlRows: 3 },
  // The camera position under the orbit and elevation pictures.
  'core.cameraAngle': { picture: 150, controlRows: 1 },
  // Interpolation; Position; Value; Delete point; two help lines.
  'core.curve': { picture: 180, controlRows: 6 },
}

/** Minimum zoom for text detail and transient media DOM. */
export const CANVAS_DETAIL_MIN_SCALE = canvasPaintTokens.detailMinScale

/** Typed presentation density derived from the two shared Canvas thresholds. */
export type CanvasDetailLevel = 'overview' | 'content' | 'controls'

export function canvasDetailLevel(scale: number, mediaControlMinScale: number): CanvasDetailLevel {
  if (scale >= mediaControlMinScale) return 'controls'
  return scale >= CANVAS_DETAIL_MIN_SCALE ? 'content' : 'overview'
}

export type NodeLook = 'original' | 'flat-title'

export interface RowGeometry {
  /** Height of a row that holds only pins. */
  readonly portRowHeight: number
  /** A widget field's inset from the top and bottom of its row. */
  readonly fieldInsetY: number
  /** A widget field's inset from the node's edge. */
  readonly fieldInsetX: number
  /** Width of the stepper zone at each end of a number field. */
  readonly stepperZone: number
  /** Distance from a field's end to its stepper glyph's center. */
  readonly stepperCenter: number
  readonly stepperStroke: number
  /** A number field's label, after the minus stepper's zone. */
  readonly stepperLabelInset: number
  /** Extra inset of a text field's value from the field's right end. */
  readonly textEndInset: number
  /** A pin's name, from the node's edge. */
  readonly portLabelInset: number
  /** Space from the title line to a first row that is boxed (a field, section or growth row). */
  readonly boxedTopInset: number
  /** Space from the title line to a first row of pins, whose text carries its own space. */
  readonly pinTopInset: number
  /**
   * Space from a last row of pins to the node's bottom edge; after a boxed row
   * it is padBottom. Both bottom insets include the 1px border, which is drawn
   * inside the node's box.
   */
  readonly pinBottomInset: number
}

export interface DesignTokens {
  readonly rowHeight: number
  readonly headerHeight: number
  readonly padX: number
  readonly padBottom: number
  /** Media height the preview panel opens at before any manual resize. */
  readonly previewDefaultHeight: number
  /** Hard floor the media area can be shrunk to by resizing the node. */
  readonly previewMinHeight: number
  readonly previewCaptionHeight: number
  readonly previewGap: number
  readonly mediaTransportHeight: number
  readonly mediaControlMinScale: number
  readonly nodeMinWidth: number
  readonly nodeMaxAutoWidth: number
  readonly pinRadius: number
  readonly cornerRadius: number
  readonly fontFamily: string
  readonly fontSize: number
  readonly titleFontSize: number
  /**
   * Which rows are raised and what a closed row shows. `raised-editors`:
   * a row that opens an editor is raised, a value typed in its row is an
   * inset field, a color's square sits directly before its code over a
   * checker pattern, a curve is drawn in its row, and a value passed down a
   * wire shows the same summary as its own row. `inset-raised` is the
   * earlier look: color and asset rows raised, the square by the name, a
   * curve described in text and a passed structured value shown as code.
   */
  readonly widgetRowLook: 'inset-raised' | 'raised-editors'
  /**
   * A remove cross on each member of a group that grows by hand. Off until
   * pressing it removes the member: nothing is drawn that does nothing.
   */
  readonly memberRemoveCross: boolean
  /**
   * How number, single-line text and seed rows are edited: in a card under
   * the row, or in the row itself. In-row editing tints a slider's fill with
   * the accent at rest and names a seed's mode before its value instead of
   * drawing the mode chip.
   */
  readonly widgetEditing: 'card' | 'in-row'
  /**
   * The node look: the original, or `flat-title` with taller fields,
   * tighter gaps, a dark body and a title bar in the body's own color over
   * a thin rule. `nodeLookTokens` gives the geometry and colors of each.
   */
  readonly nodeLook: NodeLook
  /**
   * At 100 percent, put the node's idle outline, its title bar's rule,
   * its row boxes and the steppers' lines on whole pixels: the outline is
   * 1 px drawn inside the node's box, and stepper lines sit on pixel
   * centers.
   */
  readonly crispEdges: boolean
  /** Placement inside widget and pin rows; the node look sets it. */
  readonly rowGeometry: RowGeometry
  readonly badgeTab: { readonly height: number; readonly fontSize: number; readonly inset: number }
  readonly titleOverflow: 'squeeze' | 'ellipsis'
  /** Spacious prompt typography; compact row metrics remain independent. */
  readonly multilineText: {
    readonly fontSize: number
    readonly lineHeight: number
    readonly padding: number
    /** Left inset of the text: the label's inset, so text and label start at one x. */
    readonly textInset: number
    /** Compact floating-label band, independent of the shared row height. */
    readonly labelHeight: number
    readonly scrollbarWidth: number
    /** Clear the rounded chrome edge without narrowing the scrollbar. */
    readonly scrollbarInset: number
  }
  readonly colors: {
    readonly canvasBackground: string
    readonly gridDot: string
    readonly pendingOutline: string
    readonly skippedOutline: string
    readonly nodeBody: string
    readonly nodeHeader: string
    /** Face of a raised opener row, lighter than the node body. */
    readonly widgetRaised: string
    /** Rule under a title bar drawn in the body's own color. */
    readonly nodeHeaderRule: string
    /** Structural and pseudo-node outline, stronger than inset chrome. */
    readonly nodeOutline: string
    readonly nodeIdleOutline: string
    readonly nodeBorder: string
    readonly nodeSelectedBorder: string
    /** Neutral group tint and border when the document supplies no color. */
    readonly groupDefault: string
    readonly title: string
    readonly label: string
    readonly valueMark: string
    /** The two squares of the pattern under a color square with opacity. */
    readonly swatchChecker: string
    readonly swatchCheckerAlt: string
    /** The one-pixel edge inside a color square, so white, black and colors near the node still show. */
    readonly swatchEdge: string
    readonly value: string
    readonly widgetBackground: string
    /** Muted compact-control tracks and glyphs. */
    readonly widgetAffordance: string
    /** Active compact-control state. */
    readonly widgetAffordanceActive: string
    /** Low-contrast bounded-numeric value-zone fill. */
    readonly widgetRangeFill: string
    /** Slider fill under in-row editing: the accent, tinted into the field. */
    readonly widgetRangeFillAccent: string
    readonly linkDefault: string
    readonly selection: string
    /**
     * Compatible connection-target rings during a link drag. White, per the
     * same design-language contract as nodeSelectedBorder: "where you can
     * drop" must not read as the blue live-affordance accent.
     */
    readonly dropTarget: string
    /** Subtle dot marking non-default values hidden by a collapsed section. */
    readonly modifiedIndicator: string
    /** The cyan subgraph icon on a field shown on the subgraph node without a wire. */
    readonly subgraphMark: string
    /** A box's outline, and the outline of a box inside a box. */
    readonly boxOutline: string
    readonly boxInnerOutline: string
    /** A box's header or closed row under the pointer. */
    readonly boxHover: string
    /** A box's member or row count. */
    readonly boxCount: string
    /** The dot on a closed box that holds a value that is not its default. */
    readonly boxChanged: string
    /**
     * Companion (propagated) value text: what a link-driven input WOULD
     * execute with, rendered read-only in neutral italic text in place of
     * the dormant stored value.
     */
    readonly companionValue: string
    /**
     * Stale/unproven companion text. Theme authors must keep this semantic
     * token AA-contrasting against widgetBackground; it is not an
     * interaction, progress, or data-type accent.
     */
    readonly companionUnproven: string
    /**
     * Mirror-estimate companion text: a value the frontend computed locally
     * from a schema-declared mirror, never recorded by an execution. Keep it
     * AA-contrasting against widgetBackground and distinct from both
     * companionValue and companionUnproven.
     */
    readonly companionEstimate: string
    /** Header chip naming a muted node's execution mode. */
    readonly mutedBadge: string
    /** Header chip naming a bypassed node's execution mode. */
    readonly bypassedBadge: string
    /**
     * Translucent wash over a BYPASSED node's body: bypass forwards values
     * through, so the purple tint (ComfyUI's convention) distinguishes it
     * from a muted node while both modes share the same dimming.
     */
    readonly bypassWash: string
    /**
     * Diagnostics paint: proven type-mismatch noodles and warned pins.
     * Distinct from stateColors.error (node RUN state) - this marks
     * document-level problems the solver proved, independent of execution.
     */
    readonly error: string
    /** Execution-blocking document warning, shared by its badge and outline. */
    readonly blockingWarning: string
  }
  /** Data-type -> pin/link color. Unknown types get a stable hashed hue. */
  readonly typeColors: Readonly<Record<string, string>>
  readonly typeFallbackLightness: number
  readonly stateColors: Readonly<Record<NodeRunState, string>>
  readonly progressBar: string
}

export const previousCanvasTypePaint: Pick<DesignTokens, 'typeColors' | 'typeFallbackLightness'> = {
  typeColors: {
    CLIP: '#FFD500',
    CLIP_VISION: '#A8DADC',
    CLIP_VISION_OUTPUT: '#ad7452',
    CONDITIONING: '#FFA931',
    CONTROL_NET: '#6EE7B7',
    IMAGE: '#64B5F6',
    LATENT: '#FF9CF9',
    MASK: '#81C784',
    MODEL: '#B39DDB',
    STYLE_MODEL: '#C2FFAE',
    VAE: '#FF6E6E',
    NOISE: '#B0B0B0',
    GUIDER: '#66FFFF',
    SAMPLER: '#ECB4B4',
    SIGMAS: '#CDFFCD',
    TAESD: '#DCC274',
    STRING: '#2E7D32',
    INT: '#7B1FA2',
    FLOAT: '#00838F',
    BOOLEAN: '#C2185B',
    COMBO: '#5D4037',
    AUDIO: '#1565C0',
  },
  typeFallbackLightness: 62,
}

/** A field's box inset from the node's edge in the default look; a pin's name lines up with the field's label inside it. */
const defaultFieldInsetX = 8

export const defaultTokens: DesignTokens = {
  rowHeight: 26,
  headerHeight: 26,
  padX: 10,
  padBottom: 6,
  previewDefaultHeight: 180,
  previewMinHeight: 40,
  previewCaptionHeight: 22,
  previewGap: 6,
  mediaTransportHeight: 64,
  mediaControlMinScale: 0.75,
  nodeMinWidth: 140,
  nodeMaxAutoWidth: 420,
  pinRadius: 5.5,
  cornerRadius: 6,
  fontFamily: canvasSemanticTokens.type.fontFamily,
  fontSize: 12,
  titleFontSize: 13,
  widgetRowLook: 'raised-editors',
  memberRemoveCross: false,
  widgetEditing: 'in-row',
  nodeLook: 'flat-title',
  crispEdges: true,
  rowGeometry: {
    portRowHeight: 26,
    fieldInsetY: 1,
    fieldInsetX: defaultFieldInsetX,
    stepperZone: 22,
    stepperCenter: 12.5,
    stepperStroke: 1,
    stepperLabelInset: 2,
    textEndInset: 4,
    // A pin's name starts where a text or choice field's label does.
    portLabelInset: defaultFieldInsetX + canvasPaintTokens.widget.labelInset,
    boxedTopInset: 5,
    pinTopInset: 1,
    pinBottomInset: 2,
  },
  badgeTab: canvasPaintTokens.badge.tab,
  titleOverflow: 'ellipsis',
  // Comfy-style prompt fields use 14px type with readable 20px leading and
  // 6px inset. Their 18px label band reduces dead space without changing
  // the independent 12px/24px compact-row rhythm.
  multilineText: {
    fontSize: 14,
    lineHeight: 20,
    padding: 6,
    textInset: 6,
    labelHeight: 18,
    scrollbarWidth: 6,
    scrollbarInset: 2,
  },
  colors: canvasColorsForTheme('dark'),
  ...canvasTypePaintForTheme('dark'),
  stateColors: {
    pending: canvasSemanticTokens.border.pending,
    running: canvasSemanticTokens.meaning.info.border,
    cached: '#9575cd',
    done: canvasSemanticTokens.meaning.success.border,
    error: canvasSemanticTokens.meaning.danger.border,
    // Normal non-error state (first-class absence), visually calm - never red.
    skipped: canvasSemanticTokens.border.skipped,
  },
  progressBar: canvasSemanticTokens.meaning.info.border,
}

/** Named colors keep their hue while meeting contrast against each theme's node body. */
export function canvasTypePaintForTheme(theme: 'dark' | 'light'): Pick<DesignTokens, 'typeColors' | 'typeFallbackLightness'> {
  return {
    typeColors: {
      ...previousCanvasTypePaint.typeColors,
      ...(theme === 'dark' ? {
        INT: '#9D59BA', BOOLEAN: '#CC4077', COMBO: '#86716A',
      } : {
        CLIP: '#A18600', CLIP_VISION: '#6E8E90', CONDITIONING: '#BA7B24', CONTROL_NET: '#489778',
        IMAGE: '#4F8EC1', LATENT: '#B770B2', MASK: '#609563', MODEL: '#9280B3',
        STYLE_MODEL: '#6F9264', VAE: '#DE6060', NOISE: '#888888', GUIDER: '#3C9595',
        SAMPLER: '#A67F7F', SIGMAS: '#739073', TAESD: '#9A8751',
      }),
    },
    typeFallbackLightness: theme === 'dark' ? 62 : 36,
  }
}

/** `#rrggbb` at an opacity, as an rgba() paint value. */
function accentTint(color: string, opacity: number): string {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  if (!hex) return color
  return `rgba(${Number.parseInt(hex[1]!, 16)}, ${Number.parseInt(hex[2]!, 16)}, ${Number.parseInt(hex[3]!, 16)}, ${opacity})`
}

export function canvasColorsForTheme(theme: 'dark' | 'light'): DesignTokens['colors'] {
  const tokens = semanticTokensForTheme(theme)
  return {
    canvasBackground: tokens.surface.canvas,
    gridDot: tokens.border.subtle,
    pendingOutline: tokens.border.pending,
    skippedOutline: tokens.border.skipped,
    // The dark theme's flat-title look: the darker surface is the body and
    // the title bar, raised rows take the lighter one. The light theme
    // keeps its original surfaces.
    nodeBody: theme === 'dark' ? tokens.surface.panel : tokens.surface.raised,
    nodeHeader: tokens.surface.panel,
    widgetRaised: theme === 'dark' ? tokens.surface.raised : tokens.surface.panel,
    nodeHeaderRule: tokens.border.divider,
    nodeOutline: tokens.border.strong,
    nodeIdleOutline: tokens.border.subtle,
    nodeBorder: tokens.border.subtle,
    nodeSelectedBorder: tokens.border.selected,
    groupDefault: tokens.border.strong,
    title: tokens.text.primary,
    label: tokens.text.secondary,
    // A word or icon before a value that describes it, such as a seed's mode.
    valueMark: tokens.text.muted,
    swatchChecker: tokens.checker.dark,
    swatchCheckerAlt: tokens.checker.light,
    swatchEdge: tokens.border.strong,
    value: tokens.text.primary,
    widgetBackground: tokens.surface.field,
    widgetAffordance: tokens.text.disabled,
    widgetAffordanceActive: tokens.border.focus,
    widgetRangeFill: tokens.interaction.selectedOverlay,
    widgetRangeFillAccent: accentTint(tokens.border.focus, canvasPaintTokens.widget.rangeFillAccentOpacity),
    // Link and execution-mode semantics do not change with shell themes.
    linkDefault: '#8d9aa5',
    mutedBadge: '#4a4a5e',
    bypassedBadge: '#69449a',
    bypassWash: 'rgba(147, 88, 220, 0.28)',
    selection: tokens.border.focus,
    dropTarget: tokens.border.selected,
    // The dot on a closed section that hides changed values. Yellow is kept
    // for problems.
    modifiedIndicator: tokens.meaning.accent.foreground,
    subgraphMark: tokens.meaning.accent.foreground,
    companionValue: tokens.text.secondary,
    companionUnproven: tokens.meaning.info.foreground,
    companionEstimate: tokens.meaning.success.foreground,
    error: tokens.meaning.danger.border,
    blockingWarning: tokens.meaning.warning.border,
    boxOutline: theme === 'dark' ? '#343A41' : tokens.border.subtle,
    boxInnerOutline: theme === 'dark' ? '#2E3338' : '#E1E5E9',
    boxHover: theme === 'dark' ? '#22262B' : tokens.surface.raised,
    boxCount: tokens.text.muted,
    boxChanged: tokens.meaning.accent.border,
  }
}

/**
 * Display aliases for the existing ComfyUI image and mask bridges.
 * Consulted by BOTH the label and the color lookup so name and color
 * can never disagree. Presentation only - never use these for compatibility
 * decisions; type ids in documents, wire payloads, and persistence are
 * unchanged.
 */
export const typeDisplayAliases: Readonly<Record<string, string>> = Object.freeze(
  // Null prototype so lookups by arbitrary type names (e.g. 'constructor')
  // can never resolve to inherited Object.prototype members.
  Object.assign(Object.create(null) as Record<string, string>, {
    'comfy.IMAGE': 'IMAGE',
    'comfy.MASK': 'MASK',
  }),
)

const EMPTY_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.create(null))

/**
 * Display label for a canonical type-id STRING: the base element is aliased
 * through typeDisplayAliases while list/asset wrappers are kept. Presentation
 * only - the input remains the canonical value for matching and persistence.
 */
export const typeIdDisplayLabel = (typeId: string): string => {
  const listInner = parseListTypeId(typeId)
  if (listInner !== undefined) return `list<${typeIdDisplayLabel(listInner)}>`
  const assetInner = parseAssetTypeId(typeId)
  if (assetInner !== undefined) return `asset<${typeIdDisplayLabel(assetInner)}>`
  return typeDisplayAliases[typeId] ?? typeId
}

/** Stable fallback color for unlisted data types. */
export function typeColor(tokens: DesignTokens, typeName: string): string {
  // A structured type colors as its base element type ('list<IMAGE>' and
  // 'asset<IMAGE>' -> IMAGE's color): users track WHAT data flows by color;
  // list-ness/asset-ness is a label/badge concern. Peeling nests until the
  // base element (single canonical parser, core-owned).
  let base = typeName
  for (let inner = parseListTypeId(base) ?? parseAssetTypeId(base); inner !== undefined; inner = parseListTypeId(base) ?? parseAssetTypeId(base)) base = inner
  base = typeDisplayAliases[base] ?? base
  const namespaced = base.startsWith('comfy.') || base.startsWith('core.')
    ? base.slice(base.indexOf('.') + 1)
    : base
  // Own-property reads only: typeColors is a plain object, so a type named
  // like an inherited member (e.g. 'constructor') must miss, not resolve.
  const colorOf = (key: string): string | undefined =>
    Object.hasOwn(tokens.typeColors, key) ? tokens.typeColors[key] : undefined
  const known = colorOf(base) ?? colorOf(namespaced.toUpperCase())
  if (known) return known
  let h = 0
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0
  // The hsl() form cannot exactly collide with any hex table entry.
  return `hsl(${h % 360} 45% ${tokens.typeFallbackLightness}%)`
}

export interface PresentedType {
  /** Canonical semantic identity, when the TypeExpr is recursively closed. */
  readonly canonicalName?: string
  /** Presentation label only. Never use this for compatibility decisions. */
  readonly label: string
  readonly color: string
  readonly tooltip: string
}

/** Display label for a TypeExpr without changing its semantic identity. */
const typeExprLabelWith = (type: TypeExpr, aliases: Readonly<Record<string, string>>): string => {
  switch (type.kind) {
    case 'concrete': return aliases[type.name] ?? type.name
    case 'union': return type.names.map((name) => aliases[name] ?? name).join(' | ')
    case 'wildcard': return 'Any'
    case 'tuple': return `tuple<${type.elements.map((element, index) => `${index}: ${typeExprLabelWith(element, aliases)}`).join(', ')}>`
    case 'tuple_element': return `${type.element === undefined ? type.input : typeExprLabelWith(type.element, aliases)}[${type.index}]`
    case 'variable':
      return type.allowedTypes !== undefined && type.allowedTypes.length > 0
        ? type.allowedTypes.map((allowed) => typeExprLabelWith(allowed, aliases)).join(' | ')
        : type.templateId
    case 'list': return `list<${typeExprLabelWith(type.element, aliases)}>`
    case 'asset': return `asset<${typeExprLabelWith(type.element, aliases)}>`
    case 'stream': return `stream<${typeExprLabelWith(type.element, aliases)}>`
  }
}

const typeExprLabel = (type: TypeExpr): string => typeExprLabelWith(type, typeDisplayAliases)

/**
 * Canonical (unaliased) rendering of a TypeExpr. Use for values that must
 * later match canonical type ids (e.g. search filter tokens), never for
 * user-facing labels.
 */
export const typeExprCanonicalLabel = (type: TypeExpr): string => typeExprLabelWith(type, EMPTY_ALIASES)

/**
 * One presentation boundary for pin labels, colors, and tooltip hints.
 * COMBO keeps a plain string payload while remaining its own socket type.
 */
export function presentedType(
  tokens: DesignTokens,
  type: TypeExpr,
): PresentedType {
  const canonicalName = canonicalTypeIdOf(type)
  if (canonicalName === 'COMBO') {
    return {
      ...(canonicalName !== undefined ? { canonicalName } : {}),
      label: 'COMBO',
      color: typeColor(tokens, 'COMBO'),
      tooltip: 'COMBO (string with choices)',
    }
  }
  if (type.kind === 'wildcard') {
    return {
      label: 'Any',
      color: tokens.colors.linkDefault,
      tooltip: 'Any type; this port accepts values independently and does not determine other ports.',
    }
  }
  if (type.kind === 'variable' && (type.allowedTypes === undefined || type.allowedTypes.length === 0)) {
    return {
      label: type.templateId,
      color: tokens.colors.linkDefault,
      tooltip: `Match type ${type.templateId}; every ${type.templateId} port on this node resolves together.`,
    }
  }
  const label = typeExprLabel(type)
  return {
    ...(canonicalName !== undefined ? { canonicalName } : {}),
    label,
    color: canonicalName === undefined ? tokens.colors.linkDefault : typeColor(tokens, canonicalName),
    // An aliased display name keeps the canonical id visible as secondary
    // technical detail so the underlying type is never hidden.
    tooltip: canonicalName !== undefined && typeDisplayAliases[canonicalName] !== undefined
      ? `${label} (${canonicalName})`
      : label,
  }
}

/**
 * The tokens a node look changes, to spread over a theme's tokens. The
 * defaults are the flat-title look; `original` restores the earlier sizes
 * in both themes and the earlier dark colors, for side-by-side review.
 */
export function nodeLookTokens(look: NodeLook, theme: 'dark' | 'light'): Partial<DesignTokens> {
  if (look === 'flat-title') return { nodeLook: look }
  const colors = canvasColorsForTheme(theme)
  const original = semanticTokensForTheme(theme)
  return {
    nodeLook: look,
    crispEdges: false,
    rowHeight: 24,
    headerHeight: 28,
    padBottom: 8,
    rowGeometry: {
      portRowHeight: 24,
      fieldInsetY: 2,
      fieldInsetX: 5.5 + canvasSemanticTokens.space[4],
      stepperZone: 12,
      stepperCenter: 6,
      stepperStroke: 1.5,
      stepperLabelInset: 6,
      textEndInset: 0,
      portLabelInset: 10 + 5.5 + canvasSemanticTokens.space[4],
      boxedTopInset: 0,
      pinTopInset: 0,
      pinBottomInset: 8,
    },
    colors: {
      ...colors,
      nodeBody: original.surface.raised,
      nodeHeader: original.surface.panel,
      widgetRaised: original.surface.panel,
      nodeHeaderRule: original.border.subtle,
      valueMark: colors.label,
      widgetBackground: original.surface.inset,
    },
  }
}
