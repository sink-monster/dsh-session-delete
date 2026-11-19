/**
 * Validates market/index.json with the exact validator DSH's Discover tab uses.
 * Run: node verify-index.mjs
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const validatorUrl = pathToFileURL(
  join(process.env.DSH_INSTALL_DIR ?? '', '..', 'dsh-plugin-market-index', 'lib', 'index.js'),
).href
const { parseMarketIndex, marketInstallTarget } = await import(validatorUrl)

const indexPath = join(import.meta.dirname, '..', 'market', 'index.json')
const document = JSON.parse(await readFile(indexPath, 'utf8'))
const indexUrl = 'https://example.invalid/dsh-session-delete/index.json'

const parsed = parseMarketIndex(document, indexUrl)
const plugin = parsed.plugins[0]
const version = plugin.versions[0]

console.log('index title      :', parsed.title)
console.log('plugin           :', plugin.name)
console.log('versions         :', plugin.versions.map(v => v.version).join(', '))
console.log('icon resolved    :', plugin.icon)
console.log('category         :', plugin.metadata.category)
console.log('keywords         :', plugin.metadata.keywords.join(', '))
console.log('engines.dsh      :', version.engines.dsh ?? '(any)')
console.log('install target   :', JSON.stringify(marketInstallTarget(plugin.name, version)))
console.log('\nFORMAT 1 VALID')
