import { createSignal } from 'solid-js'
import { ProductNumberInput } from '../../app/src/ProductNumberInput.js'
import {
  ProductButton,
  ProductDialog,
  ProductField,
  ProductForm,
  ProductLink,
  ProductSelect,
  ProductSection,
  ProductTextInput,
} from '../src/index.js'

const options = [
  { value: 'auto', label: 'Automatic' },
  { value: 'unavailable', label: 'Unavailable runtime', disabled: true },
  { value: 'cpu', label: 'CPU' },
  { value: 'gpu', label: 'GPU' },
]

export function SelectGallery() {
  const [value, setValue] = createSignal('auto')
  const [dialog, setDialog] = createSignal(false)
  const [submitted, setSubmitted] = createSignal('')
  return (
    <>
      <ProductSection title="Dropdowns">
        <ProductField
          label="Runtime"
          description="The check marks the saved value; the highlight is the keyboard candidate."
        >
          {(attributes) => (
            <ProductSelect
              {...attributes}
              name="runtime"
              value={value()}
              onChange={setValue}
              options={options}
            />
          )}
        </ProductField>
        <ProductField label="Unavailable runtime">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value="cpu"
              disabled
              options={options}
            />
          )}
        </ProductField>
        <ProductField label="Invalid runtime" error="Choose a runtime.">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value=""
              options={[
                { value: '', label: 'Choose a runtime', disabled: true },
                ...options,
              ]}
            />
          )}
        </ProductField>
        <ProductField label="Long list">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              options={Array.from({ length: 24 }, (_, index) => ({
                value: String(index),
                label: `Environment ${String(index + 1).padStart(2, '0')} - shared production runtime`,
              }))}
            />
          )}
        </ProductField>
        <ProductButton onClick={() => setDialog(true)}>
          Open dropdown dialog
        </ProductButton>
        <ProductLink href="#field-alignment">Compare field alignment</ProductLink>
      </ProductSection>
      {dialog() && (
        <ProductDialog
          title="Runtime choice"
          onDismiss={() => setDialog(false)}
        >
          <ProductForm
            initialValues={{ runtime: value() }}
            onSave={async (values) => {
              setSubmitted(values.runtime)
            }}
          >
            {(form) => (
              <ProductField label="Dialog runtime">
                {(attributes) => (
                  <ProductSelect
                    {...attributes}
                    name="runtime"
                    value={form.values().runtime}
                    onChange={(runtime) => form.setValue('runtime', runtime)}
                    options={options}
                  />
                )}
              </ProductField>
            )}
          </ProductForm>
          <p role="status">
            {submitted() ? `Saved ${submitted()}` : 'No submission'}
          </p>
        </ProductDialog>
      )}
    </>
  )
}

export function FieldAlignmentGallery() {
  const [choice, setChoice] = createSignal('models')
  const [number, setNumber] = createSignal<number | string>(128)
  const choices = [
    { value: 'models', label: 'Models' },
    { value: 'renders', label: 'Renders' },
  ]
  return (
    <ProductSection title="Field alignment" description="Form values share one left inset; arrows and number buttons keep their own space at the right.">
      <ProductField label="Dropdown">
        {(attributes) => <ProductSelect {...attributes} value={choice()} options={choices} onChange={setChoice} />}
      </ProductField>
      <ProductField label="Text field">
        {(attributes) => <ProductTextInput {...attributes} value="Models" />}
      </ProductField>
      <ProductField label="Password field">
        {(attributes) => <ProductTextInput {...attributes} type="password" value="Models" />}
      </ProductField>
      <ProductField label="Number field">
        {(attributes) => <ProductNumberInput id={attributes.id} value={number()} min={0} max={1024} integer onInput={setNumber} />}
      </ProductField>
      <div class="dinkster-actions">
        <ProductLink href="#field-alignment">App density</ProductLink>
        <ProductLink href="#site-field-alignment">Site density</ProductLink>
      </div>
    </ProductSection>
  )
}
