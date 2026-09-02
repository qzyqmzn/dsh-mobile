import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { validateFrpPublicOrigin, validateFrpServerAddress, validateFrpServerPort, validateFrpToken, type FrpSettings } from './frp-config.js'

const FRP_VERSION = '0.70.1'
const SSH_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 96 * 1024

const LINUX_ARTIFACTS = Object.freeze({
  x64: Object.freeze({
    directory: `frp_${FRP_VERSION}_linux_amd64`,
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz`,
    sha256: '333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6',
  }),
  arm64: Object.freeze({
    directory: `frp_${FRP_VERSION}_linux_arm64`,
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_arm64.tar.gz`,
    sha256: '3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d',
  }),
})

export interface VpsDeploymentInput {
  readonly sshUser: string
  readonly sshPort: number
  readonly sshKeyPath?: string
}

export interface VpsDeploymentCheck {
  readonly id: string
  readonly status: 'ok' | 'warning' | 'error'
  readonly detail: string
}

export interface VpsDeploymentResult {
  readonly version: 1
  readonly deployed: boolean
  readonly serverAddress: string
  readonly publicOrigin: string
  readonly checks: readonly VpsDeploymentCheck[]
}

export interface VpsDeploymentOptions {
  readonly runSsh?: (input: VpsDeploymentInput, serverAddress: string, script: string) => Promise<{ stdout: string; stderr: string }>
  readonly log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void
}

class VpsSshError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function validSshUser(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !/^[a-z_][a-z0-9_.-]*[$]?$/iu.test(value)) {
    throw new Error('vps_ssh_user_invalid')
  }
  return value
}

function validSshPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error('vps_ssh_port_invalid')
  return Number(value)
}

function validSshKeyPath(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('vps_ssh_key_invalid')
  }
  return resolve(value)
}

export function parseVpsDeploymentInput(value: unknown): VpsDeploymentInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('vps_deploy_input_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !['sshUser', 'sshPort', 'sshKeyPath'].includes(String(key)))) throw new Error('vps_deploy_input_invalid')
  const sshKeyPath = validSshKeyPath(record.sshKeyPath)
  return Object.freeze({
    sshUser: validSshUser(record.sshUser),
    sshPort: validSshPort(record.sshPort),
    ...(sshKeyPath === undefined ? {} : { sshKeyPath }),
  })
}

function safeOutput(value: string, token: string): string {
  return value.replaceAll(token, '<redacted>').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 8_192).trim()
}

function parseChecks(stdout: string, stderr: string, token: string): readonly VpsDeploymentCheck[] {
  const checks: VpsDeploymentCheck[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^DSH_MOBILE_CHECK\s+([a-z0-9_-]+)\s+(ok|warning|error)\s+(.+)$/iu.exec(line)
    if (match !== null) checks.push(Object.freeze({ id: match[1]!, status: match[2]!.toLowerCase() as VpsDeploymentCheck['status'], detail: safeOutput(match[3]!, token) }))
  }
  if (checks.length === 0 && stderr.trim() !== '') {
    checks.push(Object.freeze({ id: 'remote-command', status: 'error', detail: safeOutput(stderr, token) || 'VPS 返回了未分类错误。' }))
  }
  return Object.freeze(checks)
}

function deploymentScript(settings: FrpSettings): string {
  const amd64 = LINUX_ARTIFACTS.x64
  const arm64 = LINUX_ARTIFACTS.arm64
  const config = [
    'bindAddr = "0.0.0.0"',
    `bindPort = ${String(settings.serverPort)}`,
    'proxyBindAddr = "127.0.0.1"',
    'vhostHTTPPort = 7080',
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(settings.token)}`,
    '',
  ].join('\n')
  const publicHost = new URL(settings.publicOrigin).hostname
  const publicIp = isIP(publicHost) === 4
  const caddy = publicIp
    ? `# Managed by DSH Mobile\n{\n  default_sni ${publicHost}\n}\n\nhttp://${publicHost} {\n  redir https://${publicHost}{uri} permanent\n}\n\nhttps://${publicHost} {\n  tls /var/lib/caddy/dsh-mobile-certs/fullchain.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem\n  reverse_proxy 127.0.0.1:7080\n}\n`
    : `# Managed by DSH Mobile\n${publicHost} {\n  reverse_proxy 127.0.0.1:7080\n}\n`
  const ipCertificateSetup = publicIp ? `
export DEBIAN_FRONTEND=noninteractive
apt-get install -y python3-venv
if [ ! -x /opt/dsh-mobile/certbot-venv/bin/certbot ]; then
  python3 -m venv /opt/dsh-mobile/certbot-venv
  /opt/dsh-mobile/certbot-venv/bin/pip install --disable-pip-version-check 'certbot==5.8.0'
fi
systemctl stop caddy.service || true
if ! /opt/dsh-mobile/certbot-venv/bin/certbot certonly --standalone --preferred-profile shortlived --ip-address ${publicHost} --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring; then
  systemctl start caddy.service || true
  fail "公网 IP HTTPS 证书申请失败；请确认 80/tcp 可从公网访问。"
fi
install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem
cat > /usr/local/sbin/dsh-mobile-cert-renew <<'DSH_MOBILE_CERT_RENEW'
#!/bin/sh
set -eu
systemctl stop caddy.service
trap 'systemctl start caddy.service' EXIT
/opt/dsh-mobile/certbot-venv/bin/certbot renew --cert-name ${publicHost} --preferred-profile shortlived --non-interactive
install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem
DSH_MOBILE_CERT_RENEW
chmod 0755 /usr/local/sbin/dsh-mobile-cert-renew
cat > /etc/systemd/system/dsh-mobile-cert-renew.service <<'DSH_MOBILE_CERT_SERVICE'
[Unit]
Description=Renew DSH Mobile public IP TLS certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dsh-mobile-cert-renew
DSH_MOBILE_CERT_SERVICE
cat > /etc/systemd/system/dsh-mobile-cert-renew.timer <<'DSH_MOBILE_CERT_TIMER'
[Unit]
Description=Daily DSH Mobile public IP TLS certificate renewal check

[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
Unit=dsh-mobile-cert-renew.service

[Install]
WantedBy=timers.target
DSH_MOBILE_CERT_TIMER
check certificate ok "Let's Encrypt 公网 IP 证书已安装并启用每日自动续期。"
` : ''
  return `#!/bin/sh
set -eu
umask 077

fail() { echo "DSH_MOBILE_CHECK remote-command error $1" >&2; exit 1; }
check() { echo "DSH_MOBILE_CHECK $1 $2 $3"; }

[ "$(id -u)" = "0" ] || fail "请使用 root SSH 账号。"
command -v systemctl >/dev/null 2>&1 || fail "VPS 不支持 systemd。"
command -v tar >/dev/null 2>&1 || fail "VPS 缺少 tar。"
command -v curl >/dev/null 2>&1 || fail "VPS 缺少 curl。"
command -v sha256sum >/dev/null 2>&1 || fail "VPS 缺少 sha256sum。"
command -v useradd >/dev/null 2>&1 || fail "VPS 缺少 useradd。"

if [ -r /etc/os-release ]; then . /etc/os-release; else fail "无法识别 VPS 系统。"; fi
case "\${ID:-}" in
  debian|ubuntu) ;;
  *) fail "首版 VPS 部署只支持 Debian/Ubuntu。" ;;
esac
check os ok "\${PRETTY_NAME:-Debian/Ubuntu}"

if command -v ss >/dev/null 2>&1 && ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)${String(settings.serverPort)}$'; then
  systemctl is-active --quiet dsh-mobile-frps.service || fail "端口 ${String(settings.serverPort)} 已被占用。"
fi

caddy_preexisting=false
if command -v caddy >/dev/null 2>&1; then
  caddy_preexisting=true
else
  export DEBIAN_FRONTEND=noninteractive
  # A previous interrupted run may have left these files unreadable because
  # the deployment uses umask 077. APT reads repositories as the _apt user.
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
  chmod 0644 /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null || true
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
check caddy ok "Caddy 已安装。"

if [ "$caddy_preexisting" = true ] && [ -e /etc/caddy/Caddyfile ] && grep -vE '^[[:space:]]*(#|$)' /etc/caddy/Caddyfile | grep -q .; then
  caddy_default=false
  caddy_hash="$(sha256sum /etc/caddy/Caddyfile | awk '{print $1}')"
  if [ "$caddy_hash" = '66177d46fa761acb07208065db9b0274cb1b12c02ac43b9bfc9857b698b1ccfe' ]; then
    caddy_default=true
  elif grep -q '^# Managed by DSH Mobile$' /etc/caddy/Caddyfile; then
    caddy_default=true
  elif grep -q '^:80[[:space:]]*{' /etc/caddy/Caddyfile \
    && grep -q 'root [*] /usr/share/caddy' /etc/caddy/Caddyfile \
    && grep -q '^[[:space:]]*file_server[[:space:]]*$' /etc/caddy/Caddyfile; then
    caddy_default=true
  fi
  if [ "$caddy_default" != true ]; then
    fail "已有 Caddyfile，未覆盖现有配置；请先备份并清理冲突，或手动合并站点。"
  fi
fi

${ipCertificateSetup}

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) url=${shellQuote(amd64.url)}; expected=${shellQuote(amd64.sha256)}; directory=${shellQuote(amd64.directory)} ;;
  aarch64|arm64) url=${shellQuote(arm64.url)}; expected=${shellQuote(arm64.sha256)}; directory=${shellQuote(arm64.directory)} ;;
  *) fail "只支持 Linux x86_64 和 arm64。" ;;
esac

tmp="$(mktemp -d /tmp/dsh-mobile-frp.XXXXXX)"
cleanup() { rm -rf "$tmp"; [ -z "\${DSH_MOBILE_FRP_ARCHIVE:-}" ] || rm -f "$DSH_MOBILE_FRP_ARCHIVE"; }
trap cleanup EXIT HUP INT TERM
archive="$tmp/frp.tar.gz"
if [ -n "\${DSH_MOBILE_FRP_ARCHIVE:-}" ]; then
  [ -f "$DSH_MOBILE_FRP_ARCHIVE" ] || fail "上传的 frps 安装包不存在。"
  cp "$DSH_MOBILE_FRP_ARCHIVE" "$archive"
else
  curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
fi
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ] || fail "frps 下载校验失败。"
tar -xzf "$archive" -C "$tmp" "$directory/frps"

install -d -m 0755 /usr/local/libexec/dsh-mobile/frp/${FRP_VERSION}
install -m 0755 "$tmp/$directory/frps" /usr/local/libexec/dsh-mobile/frp/${FRP_VERSION}/frps
if ! id -u dsh-mobile >/dev/null 2>&1; then useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin --no-create-home dsh-mobile; fi
install -d -m 0750 -o root -g dsh-mobile /etc/dsh-mobile
cat > /etc/dsh-mobile/frps.toml <<'DSH_MOBILE_FRPS_CONFIG'
${config}DSH_MOBILE_FRPS_CONFIG
chown root:dsh-mobile /etc/dsh-mobile/frps.toml
chmod 0640 /etc/dsh-mobile/frps.toml

cat > /etc/systemd/system/dsh-mobile-frps.service <<'DSH_MOBILE_FRPS_UNIT'
[Unit]
Description=DSH Mobile self-hosted FRP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsh-mobile
Group=dsh-mobile
ExecStart=/usr/local/libexec/dsh-mobile/frp/${FRP_VERSION}/frps -c /etc/dsh-mobile/frps.toml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
DSH_MOBILE_FRPS_UNIT

cat > /etc/caddy/Caddyfile <<'DSH_MOBILE_CADDY'
${caddy}DSH_MOBILE_CADDY
chmod 0644 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now dsh-mobile-frps.service
systemctl enable --now caddy.service
${publicIp ? 'systemctl enable --now dsh-mobile-cert-renew.timer' : ''}
systemctl reload caddy.service || systemctl restart caddy.service

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow ${String(settings.serverPort)}/tcp comment 'DSH Mobile FRP control' >/dev/null
  ufw allow 80/tcp comment 'DSH Mobile HTTPS redirect' >/dev/null
  ufw allow 443/tcp comment 'DSH Mobile HTTPS' >/dev/null
  check firewall ok "UFW 已放行 FRP 控制端口和 HTTPS。"
else
  check firewall warning "未修改系统防火墙；请确认 ${String(settings.serverPort)}/tcp、80/tcp、443/tcp 已放行。"
fi

systemctl is-active --quiet dsh-mobile-frps.service || fail "frps 服务启动失败。"
systemctl is-active --quiet caddy.service || fail "Caddy 服务启动失败。"
check frps ok "frps ${FRP_VERSION} 已启动，7080 仅绑定回环地址。"
check caddy ok "Caddy 已加载 ${publicHost}。"
echo DSH_MOBILE_DEPLOYMENT_OK
`
}

async function runProcess(command: string, args: readonly string[], stdin?: string, timeoutMs = SSH_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES)
    const timer = setTimeout(() => { child.kill(); rejectRun(new VpsSshError('vps_ssh_timeout', stdout, stderr)) }, timeoutMs)
    timer.unref()
    child.stdout.on('data', chunk => { stdout = append(stdout, Buffer.from(chunk)) })
    child.stderr.on('data', chunk => { stderr = append(stderr, Buffer.from(chunk)) })
    child.once('error', error => { clearTimeout(timer); rejectRun(new VpsSshError('vps_ssh_unavailable', stdout, stderr, { cause: error })) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) rejectRun(new VpsSshError(stderr.includes('Permission denied') ? 'vps_ssh_auth_failed' : 'vps_deploy_failed', stdout, stderr))
      else resolveRun({ stdout, stderr })
    })
    child.stdin.end(stdin, 'utf8')
  })
}

async function downloadArtifact(artifact: (typeof LINUX_ARTIFACTS)[keyof typeof LINUX_ARTIFACTS], file: string): Promise<number> {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  await runProcess(curl, [
    ...(process.platform === 'win32' ? ['--ipv4'] : []),
    '--fail', '--location', '--silent', '--show-error',
    '--connect-timeout', '15', '--max-time', '180',
    '--proto', '=https', '--tlsv1.2', '--output', file, artifact.url,
  ], undefined, 200_000)
  const bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('vps_download_hash_mismatch')
  return bytes.byteLength
}

async function defaultRunSsh(
  input: VpsDeploymentInput,
  serverAddress: string,
  script: string,
  log?: VpsDeploymentOptions['log'],
): Promise<{ stdout: string; stderr: string }> {
  const ssh = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
  const scp = process.platform === 'win32' ? 'scp.exe' : 'scp'
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new']
  if (input.sshKeyPath !== undefined) common.push('-i', input.sshKeyPath)
  const target = `${input.sshUser}@${serverAddress}`
  const probe = await runProcess(ssh, [...common, '-p', String(input.sshPort), target, 'uname -m'])
  const architecture = probe.stdout.trim()
  const artifact = architecture === 'x86_64' || architecture === 'amd64'
    ? LINUX_ARTIFACTS.x64
    : architecture === 'aarch64' || architecture === 'arm64' ? LINUX_ARTIFACTS.arm64 : undefined
  if (artifact === undefined) throw new Error('vps_arch_unsupported')
  log?.('architecture', { architecture })
  const localDirectory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-'))
  const localArchive = join(localDirectory, 'frp.tar.gz')
  const remoteArchive = `/tmp/dsh-mobile-frp-${randomBytes(12).toString('hex')}.tar.gz`
  try {
    log?.('download-start', { source: 'local', architecture })
    const bytes = await downloadArtifact(artifact, localArchive)
    log?.('download-complete', { source: 'local', bytes })
    const scpResult = await runProcess(scp, [...common, '-P', String(input.sshPort), localArchive, `${target}:${remoteArchive}`])
    log?.('upload-complete', { bytes, stderrBytes: Buffer.byteLength(scpResult.stderr) })
    const remoteCommand = input.sshUser === 'root'
      ? `env DSH_MOBILE_FRP_ARCHIVE=${shellQuote(remoteArchive)} sh -s`
      : `sudo -n env DSH_MOBILE_FRP_ARCHIVE=${shellQuote(remoteArchive)} sh -s`
    return await runProcess(ssh, [...common, '-p', String(input.sshPort), target, remoteCommand], script)
  } finally {
    await rm(localDirectory, { recursive: true, force: true })
  }
}

export async function deployVps(settings: FrpSettings, input: VpsDeploymentInput, options: VpsDeploymentOptions = {}): Promise<VpsDeploymentResult> {
  const serverAddress = validateFrpServerAddress(settings.serverAddress)
  const serverPort = validateFrpServerPort(settings.serverPort)
  const token = validateFrpToken(settings.token)
  const publicOrigin = validateFrpPublicOrigin(settings.publicOrigin)
  if (isIP(serverAddress) !== 0 && serverAddress.includes(':')) throw new Error('vps_ipv6_ssh_not_supported')
  const parsedInput = parseVpsDeploymentInput(input)
  if (parsedInput.sshKeyPath !== undefined) {
    const entry = await lstat(parsedInput.sshKeyPath).catch(() => undefined)
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) throw new Error('vps_ssh_key_invalid')
  }
  const runSsh = options.runSsh ?? ((sshInput, host, scriptBody) => defaultRunSsh(sshInput, host, scriptBody, options.log))
  options.log?.('validated', { serverAddress, serverPort, publicOrigin, sshUser: parsedInput.sshUser, sshPort: parsedInput.sshPort, keyProvided: parsedInput.sshKeyPath !== undefined })
  let result: { stdout: string; stderr: string }
  try {
    options.log?.('ssh-start', { serverAddress, sshPort: parsedInput.sshPort })
    result = await runSsh(parsedInput, serverAddress, deploymentScript({ ...settings, serverAddress, serverPort, token, publicOrigin }))
    options.log?.('ssh-complete', { stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) })
  } catch (error) {
    if (error instanceof VpsSshError) {
      const detail = safeOutput(`${error.stderr}\n${error.stdout}`, token)
      options.log?.('ssh-failed', { code: error.message, detail: detail || 'no remote output' })
      throw new Error(detail === '' ? error.message : `${error.message}:${detail}`, { cause: error })
    }
    options.log?.('ssh-failed', { code: error instanceof Error ? error.message : 'unknown' })
    throw error
  }
  const checks = parseChecks(result.stdout, result.stderr, token)
  for (const check of checks) options.log?.('remote-check', { id: check.id, status: check.status, detail: check.detail })
  if (!result.stdout.includes('DSH_MOBILE_DEPLOYMENT_OK')) {
    if (checks.length === 0) throw new Error('vps_deploy_failed')
    throw new Error(`vps_deploy_failed:${checks.map(check => check.detail).join(' ')}`)
  }
  return Object.freeze({ version: 1, deployed: true, serverAddress, publicOrigin, checks })
}

export function vpsDeploymentScriptForTesting(settings: FrpSettings): string {
  return deploymentScript(settings)
}
