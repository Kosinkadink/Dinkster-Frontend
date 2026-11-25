import { For, Index, Show, createUniqueId, type JSX } from "solid-js";
import { Plus, TriangleAlert } from "lucide-solid";
import { ProductButton, ProductIcon } from "./controls.js";

/** One project in the projects page's list. */
export interface ProductProjectEntry {
  id: string;
  name: string;
  /** When it was last opened, or what is happening to it now. */
  detail: string;
  /** Why the detail says what it does, shown on hover, such as why a project opens in its own editor. */
  reason?: string | undefined;
  /** Opening shows progress under the row; failed marks it with a warning. */
  state?: "opening" | "failed" | "draft" | undefined;
}

/** The projects page body: the list on the left and one project on the right. */
export function ProductProjectsView(props: {
  list?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="dinkster-projects" data-list={props.list ? undefined : "none"}>
      <Show when={props.list}>
        <div class="dinkster-projects-panel dinkster-projects-list">
          {props.list}
        </div>
      </Show>
      <div class="dinkster-projects-panel dinkster-projects-detail">
        {props.children}
      </div>
    </div>
  );
}

/**
 * The project list. Selection follows the arrow keys, as in a list box; the
 * selected project shows on the right. `projects` is undefined while loading.
 */
export function ProductProjectList(props: {
  title: string;
  newLabel: string;
  onNew: () => void;
  projects: readonly ProductProjectEntry[] | undefined;
  selected: string | undefined;
  onSelect: (id: string) => void;
  loadingLabel: string;
}) {
  const heading = createUniqueId();
  let list!: HTMLUListElement;
  const move = (event: KeyboardEvent) => {
    const projects = props.projects ?? [];
    const index = projects.findIndex(
      (project) => project.id === props.selected,
    );
    const next =
      event.key === "ArrowDown"
        ? Math.min(projects.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? projects.length - 1
              : undefined;
    if (next === undefined || !projects[next]) return;
    event.preventDefault();
    props.onSelect(projects[next].id);
    list.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
  };
  return (
    <>
      <header class="dinkster-projects-list-header">
        <h1 id={heading} class="dinkster-title">
          {props.title}
        </h1>
        <ProductButton onClick={() => props.onNew()}>
          <ProductIcon icon={Plus} />
          {props.newLabel}
        </ProductButton>
      </header>
      <Show
        when={props.projects}
        fallback={
          <div class="dinkster-projects-rows" role="status">
            <span class="dinkster-visually-hidden">{props.loadingLabel}</span>
            <Index each={[0, 1, 2, 3, 4]}>
              {() => <div class="dinkster-skeleton" data-shape="row" />}
            </Index>
          </div>
        }
      >
        {(projects) => (
          <ul
            ref={list}
            class="dinkster-projects-rows"
            role="listbox"
            aria-labelledby={heading}
            onKeyDown={move}
          >
            <For each={projects()}>
              {(project) => (
                <li
                  class="dinkster-project-row"
                  role="option"
                  aria-selected={project.id === props.selected}
                  tabindex={project.id === props.selected ? 0 : -1}
                  data-state={project.state}
                  onClick={() => props.onSelect(project.id)}
                >
                  <span class="dinkster-project-row-name">{project.name}</span>
                  <span
                    class="dinkster-project-row-detail"
                    title={project.reason}
                  >
                    <Show when={project.state === "failed"}>
                      <ProductIcon icon={TriangleAlert} />
                    </Show>
                    {project.detail}
                  </span>
                  <Show when={project.state === "opening"}>
                    <span class="dinkster-progress" aria-hidden="true" />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
    </>
  );
}

/** The selected project's name, when it was opened, and its actions. */
export function ProductProjectHeader(props: {
  title: string;
  subtitle?: string | undefined;
  actions?: JSX.Element;
}) {
  return (
    <header class="dinkster-project-header">
      <div class="dinkster-project-header-copy">
        <h2 class="dinkster-title">{props.title}</h2>
        <Show when={props.subtitle}>
          <p class="dinkster-description">{props.subtitle}</p>
        </Show>
      </div>
      <div class="dinkster-actions">{props.actions}</div>
    </header>
  );
}

/** One fact of a project, such as where its files are, with an optional action on it. */
export interface ProductProjectFact {
  label: string;
  value: JSX.Element;
  detail?: string | undefined;
  action?: JSX.Element;
}

/**
 * A project's facts in two equal boxes, one per column, so each action sits
 * at the right edge of the box that holds its fact. An empty column draws no
 * box and leaves its half of the width empty.
 */
export function ProductProjectFacts(props: {
  label: string;
  columns: readonly [
    readonly ProductProjectFact[],
    readonly ProductProjectFact[],
  ];
}) {
  return (
    <div class="dinkster-project-facts" role="group" aria-label={props.label}>
      <For each={props.columns}>
        {(column) => (
          <Show when={column.length > 0}>
            <dl class="dinkster-project-facts-box">
              <For each={column}>
                {(item) => (
                  <div class="dinkster-project-fact">
                    <dt>{item.label}</dt>
                    <dd>
                      <span class="dinkster-project-fact-value">
                        {item.value}
                        <Show when={item.detail}>
                          <span class="dinkster-project-fact-detail">
                            {" - "}
                            {item.detail}
                          </span>
                        </Show>
                      </span>
                      {item.action}
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          </Show>
        )}
      </For>
    </div>
  );
}

/** A titled part of the project detail, such as its workflows, with a count or action at its end. */
export function ProductProjectSection(props: {
  title: string;
  aside?: JSX.Element;
  children?: JSX.Element;
}) {
  const id = createUniqueId();
  return (
    <section class="dinkster-project-section" aria-labelledby={id}>
      <header class="dinkster-project-section-header">
        <h3 id={id} class="dinkster-project-section-title">
          {props.title}
        </h3>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

/** Tiles in rows: `wide` for workflow previews, `narrow` for output pictures. */
export function ProductTileGrid(props: {
  size: "wide" | "narrow";
  children: JSX.Element;
}) {
  return (
    <div class="dinkster-tile-grid" data-size={props.size}>
      {props.children}
    </div>
  );
}

/** A placeholder in the shape of what is loading. */
export function ProductSkeleton(props: {
  shape: "row" | "title" | "line" | "tile";
}) {
  return (
    <div
      class="dinkster-skeleton"
      data-shape={props.shape}
      aria-hidden="true"
    />
  );
}
