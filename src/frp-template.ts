/** Loopback-only HTTP vhost port used between Caddy and frps. */
export const FRP_VHOST_HTTP_PORT = 7080

function publicIpv4Address(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9][0-9]{0,2})$/u.test(part)
    && Number(part) <= 255)
}

function publicDnsHostname(value: string): boolean {
  return value.length <= 253 && value.includes('.') && !/^[0-9.]+$/u.test(value)
    && !value.includes(':') && value.split('.').every(label => label.length >= 1 && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
}

/** Build the only supported frps and Caddy configuration from validated user inputs. */
export function createRestrictedFrpServerTemplate(serverPort: number, token: string, publicOrigin: string): string {
  if (!Number.isSafeInteger(serverPort) || serverPort < 1 || serverPort > 65_535
    || token.length < 16 || token.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('frp_template_input_invalid')
  }
  let url: URL
  try { url = new URL(publicOrigin) } catch { throw new Error('frp_template_input_invalid') }
  if (url.protocol !== 'https:' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '' || (!publicIpv4Address(url.hostname) && !publicDnsHostname(url.hostname))) {
    throw new Error('frp_template_input_invalid')
  }
  return [
    '# frps.toml',
    `bindPort = ${String(serverPort)}`,
    'proxyBindAddr = "127.0.0.1"',
    `vhostHTTPPort = ${String(FRP_VHOST_HTTP_PORT)}`,
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(token)}`,
    '',
    '# Caddyfile',
    `${url.hostname} {`,
    `  reverse_proxy 127.0.0.1:${String(FRP_VHOST_HTTP_PORT)}`,
    '}',
    '',
  ].join('\n')
}
