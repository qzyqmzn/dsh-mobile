import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { assertSupportedDshVersion, SUPPORTED_DSH_VERSIONS } from '../src/compatibility.js'

describe('DeepSeek Harness compatibility', () => {
  it.each(SUPPORTED_DSH_VERSIONS)('accepts verified release %s', version => {
    expect(() => { assertSupportedDshVersion(version) }).not.toThrow()
  })

  it.each(['0.1.0-rc.4', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1', '0.1.2-alpha.3', '0.1.2', undefined])('rejects unverified release %s', version => {
    expect(() => { assertSupportedDshVersion(version) }).toThrow(/unsupported DeepSeek Harness version/u)
  })

  it('keeps package and lock peer declarations aligned with verified Host versions', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
    expect(manifest.peerDependencies['@deepseek-ai/dsh-host-webserver'].split(' || ')).toEqual(SUPPORTED_DSH_VERSIONS)
    expect(lock.packages[''].peerDependencies).toEqual(manifest.peerDependencies)
    for (const name of ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm']) {
      expect(manifest.peerDependencies[name].split(' || ')).toContain('0.1.2-alpha.2')
    }
  })
})
