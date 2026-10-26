import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { importLitegraph } from '../packages/core/src/format/import-litegraph.ts'
import { parseDinksterNodes } from '../packages/core/src/schema/dinkster-wire.ts'

/** Retaining a document does not establish that its nodes are executable. */
export function coverageRow(path, workflow, resolver) {
  const result = importLitegraph(workflow, resolver)
  const codes = [...new Set(result.diagnostics.map((item) => item.code))].sort()
  const subgraphCount = workflow.definitions?.subgraphs?.length ?? 0
  const status = !result.document ? 'blocked'
    : subgraphCount === 0 ? 'not-needed' : 'definitions'
  const missingSchemas = result.diagnostics.filter((item) => item.code === 'import.schema.missing').length
  const unresolved = result.diagnostics.filter((item) =>
    item.code === 'import.subgraphs.boundaryUnresolved' || item.code === 'import.subgraphs.widgetUnresolved').length
  const errors = result.diagnostics.filter((item) => item.severity === 'error').length
  return { path, subgraphCount, 'subgraph-import': status, missingSchemas, unresolved, errors,
    imported: result.document !== undefined,
    errorFree: result.document !== undefined && missingSchemas === 0 && unresolved === 0 && errors === 0,
    retainedDefinitions: result.document ? Object.keys(result.document.graphs).length - 1 : 0,
    diagnostics: codes,
  }
}

export function renderCoverage(report) {
  return [
    '# ComfyUI subgraph import coverage', '',
    `Templates: ${report.inputs.templateRevision}.`,
    `Schema source: ${report.inputs.schemaSource}.`, '',
    `Imported ${report.summary.imported}/${report.summary.workflows} workflows; ${report.summary.subgraphsImported}/${report.summary.subgraphWorkflows} workflows with subgraphs.`, '',
    `Error-free imports: ${report.summary.errorFree}/${report.summary.workflows}.`, '',
    'Structural import and schema resolution are separate from compilation and execution.',
    'Absent node schemas remain unresolved; they are blockers, not exclusions.', '',
    '| Workflow | Subgraphs | subgraph-import | Missing schemas | Unresolved | Errors |',
    '| --- | ---: | --- | ---: | ---: | ---: |',
    ...report.workflows.map((row) => `| ${row.path} | ${row.subgraphCount} | ${row['subgraph-import']} | ${row.missingSchemas} | ${row.unresolved} | ${row.errors} |`), '',
  ].join('\n')
}

function main() {
  const { values } = parseArgs({ options: {
    templates: { type: 'string' }, nodes: { type: 'string' },
    'json-output': { type: 'string' }, 'markdown-output': { type: 'string' },
  } })
  if (!values.templates || !values.nodes) throw new Error('Required: --templates CHECKOUT --nodes NODES.json')
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const { schemas, diagnostics } = parseDinksterNodes(json(values.nodes))
  const catalogErrors = diagnostics.filter((item) => item.severity === 'error')
  if (catalogErrors.length > 0) throw new Error(`Invalid native catalog: ${JSON.stringify(catalogErrors)}`)
  const templateRoot = resolve(values.templates)
  const revision = execFileSync('git', ['-C', templateRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (execFileSync('git', ['-C', templateRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Template checkout must be clean')
  const workflows = []
  for (const file of readdirSync(join(templateRoot, 'templates')).filter((name) => name.endsWith('.json')).sort()) {
    const workflow = json(join(templateRoot, 'templates', file))
    if (!Array.isArray(workflow?.nodes)) continue
    workflows.push(coverageRow(file, workflow, (type) => schemas.get(type)))
  }
  const report = {
    format: 'dinkster-comfy-subgraph-coverage/2',
    inputs: { templateRevision: revision,
      schemaSource: values.nodes,
    },
    summary: { workflows: workflows.length, imported: workflows.filter((row) => row.imported).length,
      errorFree: workflows.filter((row) => row.errorFree).length,
      subgraphWorkflows: workflows.filter((row) => row.subgraphCount > 0).length,
      subgraphsImported: workflows.filter((row) => row.subgraphCount > 0 && row.imported).length,
    }, workflows,
  }
  const ascii = (text) => text.replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (values['json-output']) writeFileSync(values['json-output'], ascii(JSON.stringify(report, null, 2)) + '\n')
  if (values['markdown-output']) writeFileSync(values['markdown-output'], renderCoverage(report))
  console.log(JSON.stringify(report.summary))
  if (report.summary.errorFree !== report.summary.workflows) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
