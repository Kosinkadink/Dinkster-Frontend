import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { DinksterConnection, MountSettings } from "@dinkster/client";
import {
  ProductActionFooter,
  ProductField,
  ProductNotice,
} from "./ProductForm.js";
import { ProductSelect } from "./ProductSelect.js";
import { ProductButton } from "./ProductControls.js";
import { ProductEmptyState } from "./ProductSurfaces.js";
import { useAppMessage } from "./locale.js";

type OutputMountConnection = Pick<
  DinksterConnection,
  "fetchMountSettings" | "selectOutputMount"
>;

export function OutputMountSettings(props: {
  readonly connection: OutputMountConnection;
}) {
  const message = useAppMessage();
  const [settings, setSettings] = createSignal<MountSettings>();
  const [selected, setSelected] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0;
  onCleanup(() => { generation++; });
  const load = async (): Promise<void> => {
    const request = ++generation;
    setLoading(true);
    setError("");
    try {
      const next = await props.connection.fetchMountSettings();
      if (request !== generation) return;
      setSettings(next);
      setSelected(next.outputMount ?? "");
      setError("");
    } catch (cause) {
      if (request === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation) setLoading(false);
    }
  };
  onMount(() => void load());
  const writable = () =>
    settings()?.mounts.filter((mount) => mount.mode === "readwrite") ?? [];
  const save = async (): Promise<void> => {
    if (!selected() || selected() === settings()?.outputMount) return;
    setSaving(true);
    try {
      await props.connection.selectOutputMount(selected());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      class="runtime-settings output-mount-settings"
      data-testid="output-mount-settings"
    >
      <div class="runtime-settings-body">
        <div class="runtime-settings-toolbar">
          <div>
            <h3>{message("outputMountSettings.title")}</h3>
            <p>{message("outputMountSettings.description")}</p>
          </div>
        </div>
        <Show
          when={settings()}
          fallback={
            <ProductEmptyState
              tone={error() ? "error" : "loading"}
              title={message(error() ? "outputMountSettings.unavailable" : "outputMountSettings.loading")}
              hint={error() || undefined}
              action={error() ? <ProductButton type="button" data-testid="output-mount-retry" disabled={loading()} onClick={() => void load()}>
                {message("outputMountSettings.retry")}
              </ProductButton> : undefined}
            />
          }
        >
          <ProductField
            controlId="default-output-mount"
            label={message("outputMountSettings.label")}
            layout="stack"
          >
            <ProductSelect
              id="default-output-mount"
              testId="default-output-mount"
              ariaLabel={message("outputMountSettings.label")}
              selectedId={selected()}
              options={writable().map((mount) => ({
                id: mount.id,
                label: mount.id,
                value: mount.id,
              }))}
              disabled={saving() || !settings()?.mountChangesAllowed || writable().length === 0}
              onSelect={(option) => setSelected(option.value)}
            />
          </ProductField>
          <ProductActionFooter
            status={message(
              selected() === settings()?.outputMount
                ? "outputMountSettings.saved"
                : "outputMountSettings.unsaved",
            )}
          >
            <ProductButton
              type="button"
              variant="primary"
              data-testid="output-mount-apply"
              disabled={
                saving() ||
                !settings()?.mountChangesAllowed ||
                !selected() ||
                selected() === settings()?.outputMount
              }
              onClick={() => void save()}
            >
              {message(
                saving()
                  ? "outputMountSettings.saving"
                  : "outputMountSettings.apply",
              )}
            </ProductButton>
          </ProductActionFooter>
        </Show>
        <Show when={settings() && error()}>
          <ProductNotice tone="error">{error()} <ProductButton type="button" disabled={loading()} onClick={() => void load()}>{message("outputMountSettings.retry")}</ProductButton></ProductNotice>
        </Show>
      </div>
    </section>
  );
}
