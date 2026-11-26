import { createSignal, createUniqueId } from 'solid-js'
import {
  createPageLoad,
  ProductButton,
  ProductPageAnswer,
  ProductPageLoad,
  ProductProjectHeader,
  ProductProjectFacts,
  ProductProjectListHeader,
  ProductProjectRows,
  ProductProjectSection,
  ProductProjectsView,
  ProductSection,
} from '../src/index.js'

export function PageLoadingGallery(props: { activity: string }) {
  const page = createPageLoad<[string, string]>()
  let request: () => Promise<[string, string]>
  const read = (delay: number, fail = false, email = 'alex@example.test') => {
    let failNext = fail
    request = () => {
      const failed = failNext
      failNext = false
      return Promise.all([
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('Alex Morgan'), 20),
        ),
        new Promise<string>((resolve, reject) =>
          setTimeout(
            () =>
              failed
                ? reject(new Error('The account could not be read.'))
                : resolve(email),
            delay,
          ),
        ),
      ])
    }
    return page.load(request)
  }
  return (
    <>
      <ProductSection title="Page loading">
        <p class="dinkster-description">
          The account and its settings arrive together. A quick read has no
          loading sign. Re-reading keeps the last answer visible.
        </p>
        <div class="dinkster-actions">
          <ProductButton onClick={() => void read(80)}>
            Load quickly
          </ProductButton>
          <ProductButton onClick={() => void read(250)}>
            Load briefly
          </ProductButton>
          <ProductButton onClick={() => void read(1000)}>
            Load slowly
          </ProductButton>
          <ProductButton onClick={() => void read(250, true)}>
            Fail to load
          </ProductButton>
          <ProductButton
            onClick={() => void read(1000, false, 'alex@updated.example.test')}
          >
            Refresh account
          </ProductButton>
        </div>
        <div class="dinkster-page-load-example">
          <ProductPageLoad
            page={page}
            read={() => request()}
            loadingLabel="Loading account"
          >
            {(account) => (
              <div class="dinkster-stack">
                <strong>{account[0]}</strong>
                <span>{account[1]}</span>
              </div>
            )}
          </ProductPageLoad>
        </div>
      </ProductSection>
      <p class="dinkster-metadata" role="status">
        {props.activity}
      </p>
      <ProductSection title="Account summary">
        <ProductPageAnswer page={page}>
          {(account) => (
            <p class="dinkster-description">
              {account[0]} uses {account[1]}.
            </p>
          )}
        </ProductPageAnswer>
      </ProductSection>
    </>
  )
}

export function ProjectLoadingGallery() {
  const page = createPageLoad<[string, string]>()
  const projectHeading = createUniqueId()
  const [selected, setSelected] = createSignal('film-grain-tests')
  const [created, setCreated] = createSignal(false)
  const read = () =>
    new Promise<[string, string]>((resolve) => {
      setTimeout(() => resolve(['Alex Morgan', 'alex@example.test']), 1000)
    })
  return (
    <>
      <ProductSection title="Project loading">
        <ProductButton onClick={() => void page.load(read)}>
          Read projects
        </ProductButton>
        <ProductProjectListHeader
          id={projectHeading}
          title="Projects"
          newLabel="New"
          onNew={() => setCreated(true)}
        />
        <p class="dinkster-metadata">
          {created()
            ? 'New project opened'
            : 'New is available before the read'}
        </p>
        <div class="dinkster-project-load-example">
          <ProductProjectFacts
            label="Loaded project facts"
            columns={[
              [
                {
                  label: 'Owner',
                  value: (
                    <ProductPageAnswer page={page}>
                      {(account) => account[0]}
                    </ProductPageAnswer>
                  ),
                },
              ],
              [
                {
                  label: 'Email',
                  value: (
                    <ProductPageAnswer page={page}>
                      {(account) => account[1]}
                    </ProductPageAnswer>
                  ),
                },
              ],
            ]}
          />
        </div>
        <ProductPageLoad
          page={page}
          read={read}
          loadingLabel="Loading projects"
          arrival="rise"
        >
          <ProductProjectRows
            labelledBy={projectHeading}
            projects={[
              {
                id: 'film-grain-tests',
                name: 'Film grain tests',
                detail: 'Opened today',
              },
              {
                id: 'settings',
                name: 'Settings audit',
                detail: 'Opened today',
              },
            ]}
            selected={selected()}
            onSelect={setSelected}
            loadingLabel="Loading projects"
          />
        </ProductPageLoad>
      </ProductSection>
      <ProjectDetailLoadingGallery />
    </>
  )
}

function ProjectDetailLoadingGallery() {
  const page = createPageLoad<string>()
  const read = () =>
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('Three workflows are ready to open.'), 1000)
    })
  return (
    <ProductSection title="Project detail loading">
      <ProductButton onClick={() => void page.load(read)}>
        Read project detail
      </ProductButton>
      <div class="dinkster-project-detail-load-example dinkster-project-load-example">
        <ProductProjectsView>
          <ProductPageLoad
            page={page}
            read={read}
            loadingLabel="Loading workflows"
            known={
              <>
                <ProductProjectHeader
                  title="Film grain tests"
                  subtitle="Created November 20"
                  actions={<ProductButton>Open</ProductButton>}
                />
                <ProductProjectFacts
                  label="Project facts"
                  columns={[
                    [
                      { label: 'Files', value: 'Local folder' },
                      { label: 'Runs on', value: 'This computer' },
                    ],
                    [
                      { label: 'Packs', value: 'Core and image tools' },
                      { label: 'Size', value: 'Not measured' },
                    ],
                  ]}
                />
                <ProductProjectSection title="Workflows" />
              </>
            }
          >
            {(answer) => <p class="dinkster-description">{answer}</p>}
          </ProductPageLoad>
        </ProductProjectsView>
      </div>
    </ProductSection>
  )
}
