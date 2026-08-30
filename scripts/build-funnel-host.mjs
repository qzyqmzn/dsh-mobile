import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'native/funnel-host')
const outputDirectory = resolve(root, 'bin')
const output = resolve(outputDirectory, 'dsh-mobile-funnel-win32-x64.exe')
const workspaceGo = resolve(root, '../go/bin/go.exe')
const go = process.env.GO_BINARY || (process.platform === 'win32' && existsSync(workspaceGo) ? workspaceGo : 'go')

await mkdir(outputDirectory, { recursive: true })
await execFile(go, [
  'build',
  '-trimpath',
  '-buildvcs=false',
  // Omit build-cache action IDs; retain module metadata for license verification.
  '-ldflags=-s -w -buildid=',
  '-o',
  output,
  '.',
], {
  cwd: source,
  env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' },
  windowsHide: true,
})
const header = (await readFile(output)).subarray(0, 2).toString('ascii')
if (header !== 'MZ') throw new Error('funnel host build did not produce a Windows executable')
console.log(`built ${output}`)
