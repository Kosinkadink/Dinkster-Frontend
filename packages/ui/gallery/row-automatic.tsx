import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  defaultValuesOf,
  loadDocument,
  semanticTokensForTheme,
  type Json,
  type NodeSchema,
  type WidgetRegistry,
} from "@dinkster/core";
import {
  CanvasRenderer,
  buildScene,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  type DesignTokens,
  type LayoutRow,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
  type WidgetPainter,
} from "@dinkster/canvas";
import {
  createWidgetRegistry,
  numberFieldFacts,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from "@dinkster/widgets";
import {
  CanvasRowField,
  CanvasSideLink,
  CanvasSidePart,
  ProductSection,
  ProductSpinner,
  canvasSideLayout,
} from "../src/index.js";
import { MARGIN, NODE_WIDTH, SIDE_ROOM } from "./row-editing.js";

type WidgetRow = Extract<LayoutRow, { kind: "widget" }>;
type Theme = "dark" | "light";

const RATE_HELP = "Frames per second. Automatic uses the video's own rate.";
const WARNING = "Could not work out the video's rate. Using the default, 24.";

/** The node of this page: frame_rate declares an automatic value, the video's own rate. */
const retimeSchema: NodeSchema = {
  type: "Retime video",
  displayName: "Retime video",
  category: "gallery",
  source: "v3",
  isOutputNode: false,
  items: [
    {
      kind: "input",
      id: "video",
      type: { kind: "concrete", name: "VIDEO" },
      optional: false,
    },
    { kind: "output", id: "VIDEO", type: { kind: "concrete", name: "VIDEO" } },
    {
      kind: "input",
      id: "frame_rate",
      type: { kind: "concrete", name: "INT" },
      optional: false,
      tooltip: RATE_HELP,
      widget: { widgetType: "INT", options: { min: 1, max: 120 }, default: 24 },
    },
    {
      kind: "input",
      id: "speed",
      type: { kind: "concrete", name: "FLOAT" },
      optional: false,
      tooltip: "How fast the video plays.",
      widget: {
        widgetType: "FLOAT",
        options: { min: 0.1, max: 10, step: 0.1 },
        default: 1,
      },
    },
    {
      kind: "input",
      id: "filename_prefix",
      type: { kind: "concrete", name: "STRING" },
      optional: false,
      tooltip: "Start of every saved file name.",
      widget: { widgetType: "STRING", options: {}, default: "Dinkster" },
    },
  ],
};

/**
 * How the automatic frame_rate stands. `worked-out` and `default` show a
 * value; `loading` waits for a lookup's answer and shows the default;
 * `not-known` shows the default while nothing is under way (offline).
 * Absent when the user fixed a value.
 */
interface AutomaticState {
  readonly state: "worked-out" | "default" | "loading" | "not-known";
  readonly value: number;
  /** One plain line in the side part: why the value shown is not fresh. */
  readonly note?: string;
}

interface AutomaticExample {
  readonly id: string;
  readonly caption: string;
  /** The value stored for frame_rate; absent while it is automatic. */
  readonly stored?: number;
  readonly automatic?: AutomaticState;
  /** The open field: the text typed so far. Absent when nothing is open. */
  readonly open?: { readonly text: string };
}

const WORKED_OUT: AutomaticState = { state: "worked-out", value: 24 };
const NOT_KNOWN: AutomaticState = { state: "default", value: 24 };
const LOADING: AutomaticState = { state: "loading", value: 24 };
// The words a lookup-fed list uses for the same lookup states.
const STALE: AutomaticState = {
  state: "worked-out",
  value: 25,
  note: "Could not refresh",
};
const PAUSED: AutomaticState = { state: "worked-out", value: 25, note: "Paused" };
const OFFLINE: AutomaticState = {
  state: "not-known",
  value: 24,
  note: "Offline",
};

const groups: readonly {
  readonly title: string;
  readonly examples: readonly AutomaticExample[];
}[] = [
  {
    title: "Closed rows",
    examples: [
      {
        id: "closed",
        caption:
          "frame_rate is automatic: the row shows the word auto, then the value it works out to now, both dimmed. Words come before the value, so values line up on the right.",
        automatic: WORKED_OUT,
      },
      {
        id: "closed-not-known",
        caption:
          "The value cannot be worked out, so the declared default, 24, is used: a yellow dot, then auto and the default, dimmed. A run goes ahead.",
        automatic: NOT_KNOWN,
      },
      {
        id: "closed-loading",
        caption:
          "A lookup is still loading: auto and the default, dimmed, with no warning while it loads.",
        automatic: LOADING,
      },
      {
        id: "closed-kept",
        caption:
          "The lookup could not refresh, or editing lookups are paused, and an answer for the same values is kept: auto and that answer, 25, like any worked-out value, with no dot.",
        automatic: STALE,
      },
      {
        id: "closed-offline",
        caption:
          "Offline with no answer kept: auto and the default, dimmed, with no dot. Nothing is under way and the field cannot fix it.",
        automatic: OFFLINE,
      },
      {
        id: "closed-fixed",
        caption:
          "Typed 30 and pressed Enter: the row holds 30 like any number, in full color, without auto.",
        stored: 30,
      },
    ],
  },
  {
    title: "Opened",
    examples: [
      {
        id: "open",
        caption:
          "Clicked frame_rate. The field is empty with the worked-out 24 as a dimmed hint, so leaving without typing keeps it automatic. The steppers stay and step from 24. The default line reads automatic (24).",
        automatic: WORKED_OUT,
        open: { text: "" },
      },
      {
        id: "open-typed",
        caption:
          "Typed 30. The hint and the word auto are gone. The default line still reads automatic (24); clicking it empties the field again.",
        automatic: WORKED_OUT,
        open: { text: "30" },
      },
      {
        id: "open-not-known",
        caption:
          "Opened a row whose value cannot be worked out. The field is empty with the default, 24, as its hint. The first line of the side part is the warning; the default line reads automatic (not known).",
        automatic: NOT_KNOWN,
        open: { text: "" },
      },
      {
        id: "open-loading",
        caption:
          "Opened while the lookup loads: the default as the hint, and the shared spinner in the default line. No warning while it loads.",
        automatic: LOADING,
        open: { text: "" },
      },
      {
        id: "open-stale",
        caption:
          "Opened while the kept answer could not be refreshed: its 25 is the hint, one plain grey line says Could not refresh, and the default line reads automatic (25). No warning.",
        automatic: STALE,
        open: { text: "" },
      },
      {
        id: "open-paused",
        caption:
          "Opened while editing lookups are paused: the kept 25 is the hint, one plain grey line says Paused, and the default line reads automatic (25).",
        automatic: PAUSED,
        open: { text: "" },
      },
      {
        id: "open-offline",
        caption:
          "Opened offline with no answer kept: the default, 24, as the hint, one plain grey line says Offline, and the default line reads automatic (not known). No spinner and no warning.",
        automatic: OFFLINE,
        open: { text: "" },
      },
      {
        id: "open-emptied",
        caption:
          "Opened the fixed 30 and deleted it. The hint and auto come back; Enter stores the empty field, which makes the value automatic again.",
        stored: 30,
        automatic: WORKED_OUT,
        open: { text: "" },
      },
    ],
  },
  {
    title: "Steppers on an automatic row",
    examples: [
      {
        id: "stepped-plus",
        caption:
          "From the closed automatic row, clicked plus. The step starts from the worked-out 24 and stores at once: 25, fixed, without auto.",
        stored: 25,
      },
      {
        id: "stepped-back",
        caption:
          "Then clicked minus: 24, the same number as the worked-out one. It stays fixed.",
        stored: 24,
      },
    ],
  },
];

/** The closed row of an automatic value: the production row with "auto" and its value, dimmed, where the value goes. */
function automaticPainter(
  inner: WidgetPainter,
  automatic: AutomaticState | undefined,
  theme: Theme,
): WidgetPainter {
  if (automatic === undefined) return inner;
  const shown = String(automatic.value);
  const warning = semanticTokensForTheme(theme).meaning.warning.foreground;
  return (args) => {
    if (args.row.valueKey !== "frame_rate") {
      inner(args);
      return;
    }
    const target = args.ctx;
    const ctx = new Proxy(target, {
      get(object, property) {
        if (property === "fillText") {
          return (text: string, x: number, y: number, maxWidth?: number) => {
            if (text !== shown || object.textAlign !== "right") {
              object.fillText(text, x, y, maxWidth);
              return;
            }
            object.save();
            object.fillStyle = args.tokens.colors.valueMark;
            const words = `auto ${shown}`;
            object.fillText(words, x, y);
            if (automatic.state === "default") {
              const radius = 3;
              const dotX =
                x -
                object.measureText(words).width -
                canvasPaintTokens.widget.modeIconGap -
                radius;
              object.fillStyle = warning;
              object.beginPath();
              object.arc(dotX, y, radius, 0, Math.PI * 2);
              object.fill();
            }
            object.restore();
          };
        }
        const value = Reflect.get(object, property, object) as unknown;
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(object)
          : value;
      },
      set(object, property, value) {
        return Reflect.set(object, property, value, object);
      },
    });
    inner({ ...args, ctx, value: automatic.value });
  };
}

function retimeScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  stored: number | undefined,
): Scene {
  const id = retimeSchema.type;
  const values: Record<string, Json> = {
    ...(defaultValuesOf(retimeSchema) as Record<string, Json>),
  };
  // An automatic field stores nothing until the user fixes a value.
  delete values["frame_rate"];
  if (stored !== undefined) values["frame_rate"] = stored;
  const loaded = loadDocument({
    format: "dinkster-workflow",
    formatVersion: 1,
    lineage: "canvas-gallery",
    root: "gallery",
    graphs: {
      gallery: {
        id: "gallery",
        name: "Gallery",
        nextOrdinal: 2,
        nodes: { [id]: { id, type: id, values } },
        links: {},
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [id]: {
              position: { x: MARGIN, y: MARGIN },
              size: { width: NODE_WIDTH, height: 0 },
            },
          },
        },
      },
    },
  });
  if (!loaded.document)
    throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`);
  return buildScene({
    document: loaded.document,
    graphId: "gallery",
    resolve: (type) => (type === id ? retimeSchema : undefined),
    tokens,
    measure,
    widgetMeasure,
  });
}

function AutomaticExampleView(props: {
  example: AutomaticExample;
  theme: Theme;
  registry: WidgetRegistry;
}) {
  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;
  let field: HTMLDivElement | undefined;
  const [scene, setScene] = createSignal<Scene>();
  const [fieldInsetY, setFieldInsetY] = createSignal(0);
  const [sideSize, setSideSize] = createSignal({
    width: SIDE_ROOM - MARGIN,
    height: 0,
  });
  const width = () =>
    MARGIN + NODE_WIDTH + (props.example.open ? SIDE_ROOM : MARGIN);
  createEffect(() => {
    const theme = props.theme;
    const example = props.example;
    let disposed = false;
    let renderer: CanvasRenderer | undefined;
    void document.fonts
      .load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`)
      .then(() => {
        if (disposed) return;
        const tokens: DesignTokens = {
          ...defaultTokens,
          widgetEditing: "in-row",
          ...canvasTypePaintForTheme(theme),
          colors: canvasColorsForTheme(theme),
        };
        setFieldInsetY(tokens.rowGeometry.fieldInsetY);
        const measureContext = document
          .createElement("canvas")
          .getContext("2d")!;
        const measure: TextMeasurer = (text, role) => {
          const title = role === "title" || role === "renamedTitle";
          measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ""}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`;
          return measureContext.measureText(text).width;
        };
        const widgetMeasure: WidgetMeasure = (spec) => {
          const kind = props.registry.kind(spec.widgetType);
          const view = props.registry
            .viewsFor(spec.widgetType)
            .find((view) => view.id === kind?.defaultView(spec));
          return view
            ? { viewId: view.id, rows: view.measure(spec).rows }
            : undefined;
        };
        const built = retimeScene(
          tokens,
          measure,
          widgetMeasure,
          example.stored,
        );
        const node = built.nodes[0]!;
        canvas.style.width = `${width()}px`;
        canvas.style.height = `${node.y + node.layout.height + MARGIN}px`;
        const closedAutomatic =
          example.open === undefined ? example.automatic : undefined;
        renderer = new CanvasRenderer(
          canvas,
          tokens,
          automaticPainter(
            createRegistryPainter(props.registry),
            closedAutomatic,
            theme,
          ),
        );
        renderer.setReducedMotion(true);
        renderer.setGridVisible(false);
        renderer.setScene(built);
        renderer.setOpenRow(
          example.open !== undefined
            ? { nodeId: node.id, valueKey: "frame_rate" }
            : undefined,
        );
        renderer.setViewport({ x: 0, y: 0, scale: 1 });
        renderer.renderNow();
        setScene(built);
        canvas.dataset.ready = `${example.id}-${theme}`;
      });
    onCleanup(() => {
      disposed = true;
      renderer?.dispose();
      delete canvas.dataset.ready;
    });
  });
  const open = createMemo(() => {
    const current = scene();
    const example = props.example;
    if (!current || example.open === undefined) return undefined;
    const node = current.nodes[0]!;
    const row = node.layout.rows.find(
      (row): row is WidgetRow =>
        row.kind === "widget" && row.valueKey === "frame_rate",
    );
    if (!row) return undefined;
    const grow = 1;
    const rowWidth =
      (row.width ?? node.layout.width - row.inset * 2) + grow * 2;
    const screen = {
      x: node.x + row.inset - grow,
      y: node.y + row.y + fieldInsetY() - grow,
      width: rowWidth,
      height: row.height - fieldInsetY() * 2 + grow * 2,
    };
    const layout = canvasSideLayout(
      screen,
      { x: 0, y: 0, width: width(), height: Infinity },
      sideSize(),
      1,
      node.y + node.layout.height - screen.y + MARGIN / 2,
      screen.y - node.y + MARGIN / 2,
    );
    return { row, rowWidth, screen, ...layout };
  });
  const side = createMemo(() => {
    const target = open();
    const automatic = props.example.automatic;
    if (!target || automatic === undefined) return undefined;
    const defaultLine =
      automatic.state === "worked-out"
        ? `automatic (${automatic.value})`
        : "automatic (not known)";
    return (
      <CanvasSidePart
        {...(automatic.state === "default" ? { problem: WARNING } : {})}
        facts={numberFieldFacts(target.row.spec).map((fact) => ({
          key: fact.key,
          value:
            fact.key === "default" ? (
              <span class="dinkster-canvas-side-loading">
                <Show when={automatic.state === "loading"}>
                  <ProductSpinner />
                </Show>
                <CanvasSideLink onClick={() => undefined}>
                  {defaultLine}
                </CanvasSideLink>
              </span>
            ) : (
              fact.text
            ),
        }))}
        help={RATE_HELP}
      >
        <Show when={automatic.note}>
          <p class="dinkster-canvas-side-note">{automatic.note}</p>
        </Show>
      </CanvasSidePart>
    );
  });
  createEffect(() => {
    const current = open();
    if (!current || !field) return;
    field.style.left = `${current.screen.x}px`;
    field.style.top = `${current.screen.y}px`;
    const sideBottom = Math.max(
      current.screen.height,
      current.sideTop + (current.sideMaxHeight ?? sideSize().height),
    );
    stage.style.height = `${Math.max(canvas.clientHeight, current.screen.y + sideBottom + MARGIN)}px`;
  });
  return (
    <figure class="dinkster-canvas-example">
      <div ref={stage} class="dinkster-canvas-example-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${props.example.id} in ${props.theme} theme`}
          data-testid={`row-automatic-${props.example.id}`}
        />
        <Show when={open()}>
          {(current) => {
            const empty = () => props.example.open!.text === "";
            return (
              <CanvasRowField
                ref={(element) => (field = element)}
                look="flat-title"
                rowWidth={current().rowWidth}
                label={current().row.label}
                value={props.example.open!.text}
                onInput={() => undefined}
                inputLabel={current().row.label}
                {...(empty() && props.example.automatic !== undefined
                  ? {
                      placeholder: String(props.example.automatic.value),
                      mark: <span>auto</span>,
                    }
                  : {})}
                onStep={() => undefined}
                place={current().place}
                sideTop={current().sideTop}
                {...(current().sideMaxHeight !== undefined
                  ? { sideMaxHeight: current().sideMaxHeight! }
                  : {})}
                onSideSize={setSideSize}
                {...(side() !== undefined ? { side: side()! } : {})}
              />
            );
          }}
        </Show>
      </div>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  );
}

/** A field whose value is automatic, closed, opened, stepped and when it cannot be worked out. */
export function RowAutomaticGallery(props: { theme: Theme }) {
  const registry = createWidgetRegistry();
  registerCoreWidgets(widgetRegistrationDoors(registry));
  return (
    <For each={groups}>
      {(group) => (
        <ProductSection title={group.title}>
          <div class="dinkster-canvas-examples">
            <For each={group.examples}>
              {(example) => (
                <AutomaticExampleView
                  example={example}
                  theme={props.theme}
                  registry={registry}
                />
              )}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  );
}
