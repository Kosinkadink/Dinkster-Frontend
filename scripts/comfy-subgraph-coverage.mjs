import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { importLitegraph } from '../packages/core/src/format/import-litegraph.ts'
import { parseObjectInfo } from '../packages/core/src/schema/object-info.ts'

/** Importability and maintained backend aliases are independent evidence. */
export function coverageRow(path, workflow, backend, resolver) {
  const result = importLitegraph(workflow, resolver)
  const codes = [...new Set(result.diagnostics.map((item) => item.code))].sort()
  const subgraphCount = workflow.definitions?.subgraphs?.length ?? 0
  const status = !result.document ? 'blocked'
    : subgraphCount === 0 ? 'not-needed' : 'definitions'
  const counts = backend?.statusCounts
  const aliasStatus = !backend ? 'not-in-backend-report'
    : counts?.quarantine > 0 ? 'missing-backend-alias'
    : counts?.unsupported > 0 ? 'unsupported-source'
    : counts?.unavailable > 0 ? 'provider-unavailable'
    : backend.translationReady ? 'translation-ready' : 'backend-blocked'
  return { path, subgraphCount, baselineSubgraphCount: backend?.subgraphCount ?? null,
    'subgraph-import': status, 'backend-alias': aliasStatus,
    imported: result.document !== undefined,
    retainedDefinitions: result.document ? Object.keys(result.document.graphs).length - 1 : 0,
    diagnostics: codes,
  }
}

export function renderCoverage(report) {
  return [
    '# ComfyUI subgraph import coverage', '',
    `Templates: ${report.inputs.templateRevision}.`,
    `Backend coverage templates: ${report.inputs.backendTemplateRevision}.`,
    `Schema source: ${report.inputs.schemaSource}.`, '',
    `Imported ${report.summary.imported}/${report.summary.workflows} workflows; ${report.summary.subgraphsImported}/${report.summary.subgraphWorkflows} workflows with subgraphs.`, '',
    'Backend alias statuses come unchanged from the supplied backend report and are not execution proof.',
    'The frontend status tests the supplied schema catalog; absent node schemas remain unresolved, not aliased.', '',
    '| Workflow | Subgraphs | subgraph-import | backend-alias |',
    '| --- | ---: | --- | --- |',
    ...report.workflows.map((row) => `| ${row.path} | ${row.subgraphCount} | ${row['subgraph-import']} | ${row['backend-alias']} |`), '',
  ].join('\n')
}

function main() {
  const { values } = parseArgs({ options: {
    templates: { type: 'string' }, 'backend-coverage': { type: 'string' },
    'object-info': { type: 'string' }, 'json-output': { type: 'string' }, 'markdown-output': { type: 'string' },
  } })
  if (!values.templates || !values['backend-coverage']) throw new Error('Required: --templates CHECKOUT --backend-coverage REPORT.json')
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const backend = json(values['backend-coverage'])
  if (backend.format !== 'dinkster-comfy-coverage/1' || !Array.isArray(backend.workflows)) throw new Error('Expected dinkster-comfy-coverage/1 backend report')
  const rows = new Map(backend.workflows.map((row) => [basename(row.path), row]))
  const schemas = values['object-info'] ? parseObjectInfo(json(values['object-info'])).schemas : new Map()
  const templateRoot = resolve(values.templates)
  const revision = execFileSync('git', ['-C', templateRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (execFileSync('git', ['-C', templateRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Template checkout must be clean')
  const workflows = []
  for (const file of readdirSync(join(templateRoot, 'templates')).filter((name) => name.endsWith('.json')).sort()) {
    const workflow = json(join(templateRoot, 'templates', file))
    if (!Array.isArray(workflow?.nodes)) continue
    workflows.push(coverageRow(file, workflow, rows.get(file), (type) => schemas.get(type)))
  }
  const report = {
    format: 'dinkster-comfy-subgraph-coverage/1',
    inputs: { templateRevision: revision, backendTemplateRevision: backend.inputs.templateRevision,
      schemaSource: values['object-info'] ?? 'none (unresolved nodes preserved)',
    },
    summary: { workflows: workflows.length, imported: workflows.filter((row) => row.imported).length,
      subgraphWorkflows: workflows.filter((row) => row.subgraphCount > 0).length,
      subgraphsImported: workflows.filter((row) => row.subgraphCount > 0 && row.imported).length,
    }, workflows,
  }
  const ascii = (text) => text.replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (values['json-output']) writeFileSync(values['json-output'], ascii(JSON.stringify(report, null, 2)) + '\n')
  if (values['markdown-output']) writeFileSync(values['markdown-output'], renderCoverage(report))
  console.log(JSON.stringify(report.summary))
  if (report.summary.subgraphsImported !== report.summary.subgraphWorkflows) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
