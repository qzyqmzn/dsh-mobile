import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const verifier = fileURLToPath(new URL('../scripts/verify-android-signature.mjs', import.meta.url))
const digest = 'f46bbee7dbe47d18f49f95f940e1d368f0b79bd8ad9d15d488337fba51e92e87'
const certificate = (label: string, value = digest): string => `${label} certificate SHA-256 digest: ${value}`
const report = (...certificates: string[]): string => ['Verifies', 'Number of signers: 1', ...certificates].join('\n')

function verify(input: string): number | null {
  const result = spawnSync(process.execPath, [verifier], { input, encoding: 'utf8', timeout: 5_000 })
  if (result.error) throw result.error
  return result.status
}

describe('Android release certificate gate', () => {
  it.each(['Signer #1', 'V2 Signer:', 'V3 Signer:', 'V3.1 Signer:', 'V4 Signer:'])('accepts the established certificate in %s output', label => {
    expect(verify(report(certificate(label)))).toBe(0)
  })

  it('accepts one signer reported in multiple signature schemes and CRLF output', () => {
    expect(verify(report(certificate('V2 Signer:'), certificate('V3 Signer:', digest.toUpperCase())).replaceAll('\n', '\r\n'))).toBe(0)
  })

  it.each([
    ['', 'empty output'],
    [report(), 'missing certificate'],
    [report(certificate('V2 Signer:', 'a'.repeat(64))), 'different certificate'],
    [report(certificate('V2 Signer:', 'invalid')), 'malformed digest'],
    [report(certificate('V2 Signer:'), certificate('V3 Signer:', 'a'.repeat(64))), 'different scheme certificate'],
    [report(certificate('Signer #1'), certificate('Signer #2')), 'additional legacy signer'],
    [report(certificate('Unknown Signer:')), 'unknown certificate label'],
    [report(certificate('V2 Signer:')).replace('Number of signers: 1', 'Number of signers: 2'), 'multiple signers'],
    [report(certificate('V2 Signer:')).replace('Number of signers: 1\n', ''), 'missing signer count'],
    [report(certificate('V2 Signer:')) + '\nNumber of signers: 1', 'ambiguous signer count'],
    [report(certificate('V2 Signer:')).replace('Verifies', 'DOES NOT VERIFY'), 'unsuccessful verification'],
  ])('rejects %s (%s)', (input) => {
    expect(verify(input)).toBe(1)
  })
})
