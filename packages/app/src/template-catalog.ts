import { loadDocument, sha256Hex, type WorkflowDocument } from "@dinkster/core";
import type { TemplateDescriptor } from "@dinkster/client";

export const TEMPLATE_CATALOG_VERSION = 1;
const CACHE_PREFIX = "dinkster.template-catalog.v1:";

export interface RemoteTemplateDescriptor extends TemplateDescriptor {
  readonly version: string;
}

interface CachedCatalog {
  readonly version: 1;
  readonly templates: readonly RemoteTemplateDescriptor[];
}

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as readonly string[])
    : undefined;

const descriptor = (value: unknown): RemoteTemplateDescriptor | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row["pack"] !== "string" ||
    typeof row["version"] !== "string" ||
    typeof row["id"] !== "string" ||
    typeof row["name"] !== "string" ||
    typeof row["digest"] !== "string"
  )
    return undefined;
  const thumbnail = row["thumbnail"];
  return {
    pack: row["pack"],
    version: row["version"],
    id: row["id"],
    name: row["name"],
    digest: row["digest"],
    ...(typeof row["description"] === "string"
      ? { description: row["description"] }
      : {}),
    ...(strings(row["tags"]) !== undefined
      ? { tags: strings(row["tags"])! }
      : {}),
    ...(typeof row["family"] === "string" ? { family: row["family"] } : {}),
    ...(strings(row["models"]) !== undefined
      ? { models: strings(row["models"])! }
      : {}),
    ...(strings(row["assets"]) !== undefined
      ? { assets: strings(row["assets"])! }
      : {}),
    ...(typeof thumbnail === "object" &&
    thumbnail !== null &&
    typeof (thumbnail as Record<string, unknown>)["digest"] === "string" &&
    typeof (thumbnail as Record<string, unknown>)["mediaType"] === "string"
      ? { thumbnail: thumbnail as { digest: string; mediaType: string } }
      : {}),
  };
};

export class RemoteTemplateCatalog {
  readonly baseUrl: string;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;

  constructor(
    baseUrl: string,
    storage?: Pick<Storage, "getItem" | "setItem">,
    private readonly fetchFn: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (storage !== undefined) {
      this.storage = storage;
    } else {
      try {
        this.storage = globalThis.localStorage;
      } catch {
        this.storage = undefined;
      }
    }
  }

  private cacheKey(): string {
    return CACHE_PREFIX + this.baseUrl;
  }

  private cached(): readonly RemoteTemplateDescriptor[] {
    try {
      const parsed = JSON.parse(
        this.storage?.getItem(this.cacheKey()) ?? "null",
      ) as Partial<CachedCatalog> | null;
      if (
        parsed?.version !== TEMPLATE_CATALOG_VERSION ||
        !Array.isArray(parsed.templates)
      )
        return [];
      return parsed.templates
        .map(descriptor)
        .filter(
          (entry): entry is RemoteTemplateDescriptor => entry !== undefined,
        );
    } catch {
      return [];
    }
  }

  async list(): Promise<readonly RemoteTemplateDescriptor[]> {
    if (this.baseUrl === "") return [];
    try {
      const templates: RemoteTemplateDescriptor[] = [];
      let cursor: string | undefined;
      const continuations = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor !== undefined) query.set("cursor", cursor);
        const response = await this.fetchFn(
          `${this.baseUrl}/index/templates?${query}`,
        );
        if (!response.ok)
          throw new Error(`GET /index/templates failed: ${response.status}`);
        const payload = (await response.json()) as {
          catalogVersion?: unknown;
          templates?: unknown;
          cursor?: unknown;
        };
        if (
          payload.catalogVersion !== TEMPLATE_CATALOG_VERSION ||
          !Array.isArray(payload.templates)
        ) {
          throw new Error(
            `unsupported template catalog version ${String(payload.catalogVersion)}`,
          );
        }
        templates.push(
          ...payload.templates
            .map(descriptor)
            .filter(
              (entry): entry is RemoteTemplateDescriptor => entry !== undefined,
            ),
        );
        if (
          payload.cursor !== undefined &&
          typeof payload.cursor !== "string"
        ) {
          throw new Error("template catalog returned an invalid continuation");
        }
        cursor = payload.cursor === "" ? undefined : payload.cursor;
        if (cursor !== undefined && continuations.has(cursor)) {
          throw new Error("template catalog repeated a continuation");
        }
        if (cursor !== undefined) continuations.add(cursor);
      } while (cursor !== undefined);
      try {
        this.storage?.setItem(
          this.cacheKey(),
          JSON.stringify({ version: TEMPLATE_CATALOG_VERSION, templates }),
        );
      } catch {
        // A blocked cache does not invalidate a successful catalog response.
      }
      return templates;
    } catch {
      return this.cached();
    }
  }

  thumbnailUrl(template: RemoteTemplateDescriptor): string | undefined {
    if (template.thumbnail === undefined) return undefined;
    return `${this.baseUrl}/index/packs/${encodeURIComponent(template.pack)}/versions/${encodeURIComponent(template.version)}/templates/${encodeURIComponent(template.id)}/thumbnail`;
  }

  async fetchBody(
    template: RemoteTemplateDescriptor,
  ): Promise<WorkflowDocument | undefined> {
    const response = await this.fetchFn(
      `${this.baseUrl}/index/packs/${encodeURIComponent(template.pack)}/versions/${encodeURIComponent(template.version)}/templates/${encodeURIComponent(template.id)}`,
    );
    if (response.status === 404 || response.status === 410) return undefined;
    if (!response.ok)
      throw new Error(`GET remote template failed: ${response.status}`);
    const text = await response.text();
    const digest = `sha256:${sha256Hex(new TextEncoder().encode(text))}`;
    if (digest !== template.digest)
      throw new Error(
        `GET remote template: digest mismatch (expected ${template.digest})`,
      );
    const loaded = loadDocument(JSON.parse(text) as unknown);
    if (loaded.document === undefined)
      throw new Error("GET remote template: malformed workflow document");
    return loaded.document;
  }
}
