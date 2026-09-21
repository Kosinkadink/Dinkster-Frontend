import { createSignal, onMount, Show } from "solid-js";
import type { DinksterConnection, MountSettings } from "@dinkster/client";
import {
  ProductActionFooter,
  ProductField,
  ProductNotice,
} from "./ProductForm.js";
import { ProductSelect } from "./ProductSelect.js";
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
  const [error, setError] = createSignal("");
  const load = async (): Promise<void> => {
    try {
      const next = await props.connection.fetchMountSettings();
      setSettings(next);
      setSelected(next.outputMount ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
            <ProductNotice tone="status">
              {message("outputMountSettings.loading")}
            </ProductNotice>
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
              disabled={saving() || writable().length === 0}
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
            <button
              type="button"
              class="primary"
              disabled={
                saving() ||
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
            </button>
          </ProductActionFooter>
        </Show>
        <Show when={error()}>
          <ProductNotice tone="error">{error()}</ProductNotice>
        </Show>
      </div>
    </section>
  );
}
