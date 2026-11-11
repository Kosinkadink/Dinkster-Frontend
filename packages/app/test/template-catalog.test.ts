import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@dinkster/core";
import {
  RemoteTemplateCatalog,
  TEMPLATE_CATALOG_VERSION,
  type RemoteTemplateDescriptor,
} from "../src/template-catalog.js";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const body = JSON.stringify({
  format: "dinkster-workflow",
  formatVersion: 1,
  lineage: "remote-starter",
  root: "g0",
  graphs: {
    g0: {
      id: "g0",
      name: "Root",
      nodes: {},
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 0,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
});

const template = (
  over: Partial<RemoteTemplateDescriptor> = {},
): RemoteTemplateDescriptor => ({
  pack: "starter-pack",
  version: "1.2.0",
  id: "remote-starter",
  name: "Remote Starter",
  digest: `sha256:${sha256Hex(new TextEncoder().encode(body))}`,
  family: "dinkster.sd15",
  models: ["sd15.safetensors"],
  thumbnail: { digest: "sha256:" + "a".repeat(64), mediaType: "image/png" },
  ...over,
});

describe("RemoteTemplateCatalog", () => {
  it("reads the versioned index and uses its persistent cache when offline", async () => {
    const cache = storage();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          catalogVersion: TEMPLATE_CATALOG_VERSION,
          templates: [template()],
        }),
        { status: 200 },
      ),
    );
    const catalog = new RemoteTemplateCatalog(
      "https://registry.example/",
      cache,
      fetchFn,
    );
    expect(await catalog.list()).toEqual([template()]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://registry.example/index/templates?limit=200",
    );

    fetchFn.mockRejectedValueOnce(new Error("offline"));
    expect(await catalog.list()).toEqual([template()]);
    expect(catalog.thumbnailUrl(template())).toBe(
      "https://registry.example/index/packs/starter-pack/versions/1.2.0/templates/remote-starter/thumbnail",
    );
  });

  it("follows catalog continuations so later families are not hidden", async () => {
    const second = template({
      id: "later-family",
      family: "dinkster.minimax_h3",
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            catalogVersion: TEMPLATE_CATALOG_VERSION,
            templates: [template()],
            cursor: "next page",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            catalogVersion: TEMPLATE_CATALOG_VERSION,
            templates: [second],
          }),
          { status: 200 },
        ),
      );

    const catalog = new RemoteTemplateCatalog(
      "https://registry.example",
      storage(),
      fetchFn,
    );
    expect(await catalog.list()).toEqual([template(), second]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://registry.example/index/templates?limit=200&cursor=next+page",
    );
  });

  it("refuses an unknown catalog version rather than guessing", async () => {
    const catalog = new RemoteTemplateCatalog(
      "https://registry.example",
      storage(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ catalogVersion: 2, templates: [template()] }),
            { status: 200 },
          ),
        ),
    );
    expect(await catalog.list()).toEqual([]);
  });

  it("verifies immutable template bytes before loading the document", async () => {
    const good = new RemoteTemplateCatalog(
      "https://registry.example",
      storage(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200 })),
    );
    expect((await good.fetchBody(template()))?.lineage).toBe("remote-starter");

    const changed = new RemoteTemplateCatalog(
      "https://registry.example",
      storage(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body + " ", { status: 200 })),
    );
    await expect(changed.fetchBody(template())).rejects.toThrow(
      /digest mismatch/,
    );
  });

  it("does not contact a registry until a URL is configured", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect(
      await new RemoteTemplateCatalog("", storage(), fetchFn).list(),
    ).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
