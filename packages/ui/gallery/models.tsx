import { createSignal } from 'solid-js'
import {
  ProductModelList,
  ProductSection,
  ProductTextButton,
  type ProductModel,
  type ProductModelListHandle,
} from '../src/index.js'

const models: readonly ProductModel[] = [
  {
    id: 'detail',
    name: 'Detail Tweaker XL',
    kind: 'LoRA',
    versions: [
      {
        id: 'main',
        name: 'Detail Tweaker XL',
        size: '228 MB',
        state: 'installed',
      },
    ],
  },
  {
    id: 'flux',
    name: 'FLUX.1 dev',
    kind: 'Checkpoint',
    versions: [
      {
        id: 'fp8',
        name: 'fp8',
        size: '17.2 GB',
        state: 'installed',
        facts: [
          {
            label: 'File',
            value: 'flux1-dev-fp8.safetensors',
            monospace: true,
          },
          { label: 'Folder', value: 'Studio models' },
        ],
      },
      {
        id: 'fp16',
        name: 'fp16',
        state: 'downloading',
        progress: 0.42,
        message: '42%, 10 of 23.8 GB',
      },
      { id: 'q4', name: 'Q4, GGUF', size: '6.8 GB', state: 'not-downloaded' },
    ],
  },
  {
    id: 'juggernaut',
    name: 'Juggernaut XL v9',
    kind: 'Checkpoint',
    versions: [
      {
        id: 'fp16',
        name: 'fp16',
        precision: 'fp16',
        size: '7.1 GB',
        state: 'not-downloaded',
      },
    ],
  },
  {
    id: 'sdxl',
    name: 'SDXL Base 1.0',
    kind: 'Checkpoint',
    versions: [
      {
        id: 'fp16',
        name: 'fp16',
        precision: 'fp16',
        size: '6.9 GB',
        state: 'installed',
        facts: [
          {
            label: 'File',
            value: 'sd_xl_base_1.0.safetensors',
            monospace: true,
          },
          { label: 'Folder', value: 'Models' },
          { label: 'Also called', value: 'sdxl_base, sd_xl_base' },
        ],
      },
    ],
  },
]

export function ModelsGallery() {
  const [selected, setSelected] = createSignal<
    {
      modelId: string
      versionId: string
    }[]
  >([])
  let field: ProductModelListHandle | undefined
  const [action, setAction] = createSignal('')
  return (
    <ProductSection
      title="Models"
      description="One model list for the Library and model fields."
    >
      <div class="dinkster-model-gallery" data-testid="models-gallery">
        <ProductModelList
          label="Models"
          models={models}
          selected={selected()}
          onChoose={(modelId, versionId) =>
            setSelected([{ modelId, versionId }])
          }
          onDownload={(modelId, versionId) =>
            setAction(`Download models: ${modelId}, ${versionId}`)
          }
          onShowFolder={(modelId, versionId) =>
            setAction(`Show folder: ${modelId}, ${versionId}`)
          }
          onCopyName={(modelId, versionId) =>
            setAction(`Copy name: ${modelId}, ${versionId}`)
          }
          onHide={(modelId, versionId) =>
            setAction(`Confirm hide: ${modelId}, ${versionId}`)
          }
        />
        <p class="dinkster-metadata" role="status">
          {action()}
        </p>
      </div>
      <ProductSection
        title="Model field"
        description="Inspect with arrows; chosen versions stay controlled by the field."
      >
        <ProductTextButton
          label="Focus field models"
          onClick={() => field?.focusFirst()}
        />
        <div class="dinkster-model-gallery" data-testid="models-field-gallery">
          <ProductModelList
            label="Field models"
            models={models}
            inlineDetails={false}
            selected={[
              { modelId: 'detail', versionId: 'main' },
              { modelId: 'sdxl', versionId: 'fp16' },
            ]}
            ref={(handle) => {
              field = handle
            }}
            onSelect={(modelId, versionId) =>
              setAction(`Inspect: ${modelId}, ${versionId}`)
            }
          />
        </div>
      </ProductSection>
    </ProductSection>
  )
}
