export interface AssetBrowserItem {
  readonly id: string
  readonly name: string
  readonly kind?: string
  readonly mediaType?: string
  readonly size?: number
  readonly digest?: string
  readonly source: { readonly id: string; readonly label: string; readonly path?: string }
  readonly virtualPath?: string
  readonly folder?: boolean
  readonly childCount?: number
  readonly details?: readonly { readonly label: string; readonly text: string }[]
  readonly rawRef?: unknown
}

export interface AssetSourceAdapter {
  readonly id: string
  readonly label: string
  readonly sourceLabel: string
  readonly capabilities: { readonly folders: boolean; readonly query: boolean; readonly kindFilter: boolean; readonly thumbnails: boolean; readonly actions: boolean }
  page(req: { readonly query: string; readonly kind?: string; readonly folder?: string; readonly cursor?: string; readonly limit: number; readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<{ readonly items: readonly AssetBrowserItem[]; readonly folders?: readonly AssetBrowserItem[]; readonly cursor?: string; readonly total?: number }>
  listFolder?(req: { readonly folder: string; readonly signal?: AbortSignal }): Promise<{ readonly folders: readonly AssetBrowserItem[] }>
  loadMetadata?(item: AssetBrowserItem, signal?: AbortSignal): Promise<unknown | undefined>
}
