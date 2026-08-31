/** DeepSeek Harness prereleases verified by this plugin release. */
export const SUPPORTED_DSH_VERSIONS = Object.freeze([
  '0.1.0-rc.5',
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  '0.1.1-rc.2',
  '0.1.2-alpha.1',
  '0.1.2-alpha.2',
] as const)

/**
 * Reject an unverified DeepSeek Harness Host before opening the LAN listener.
 * @param version - Version reported by the installed DSH WebServer package.
 */
export function assertSupportedDshVersion(version: unknown): asserts version is typeof SUPPORTED_DSH_VERSIONS[number] {
  if (typeof version === 'string' && SUPPORTED_DSH_VERSIONS.some(candidate => candidate === version)) return
  throw new Error(`unsupported DeepSeek Harness version ${typeof version === 'string' ? version : '(unknown)'}; supported versions: ${SUPPORTED_DSH_VERSIONS.join(', ')}`)
}
