import { describe, expect, it } from 'vitest'
import { deployVps, parseVpsDeploymentInput, vpsDeploymentScriptForTesting } from '../src/vps-deploy.js'
import { parseFrpSettings } from '../src/frp-config.js'

const settings = parseFrpSettings({
  serverAddress: 'frp.example.com',
  serverPort: 7000,
  token: '0123456789abcdef0123456789abcdef',
  publicOrigin: 'https://dsh.example.com',
})

describe('VPS deployment', () => {
  it('validates SSH input without accepting arbitrary remote arguments', () => {
    expect(parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22 })).toEqual({ sshUser: 'root', sshPort: 22 })
    expect(parseVpsDeploymentInput({ sshUser: 'deploy-user', sshPort: 2222, sshKeyPath: 'C:\\keys\\dsh' })).toEqual({
      sshUser: 'deploy-user', sshPort: 2222, sshKeyPath: 'C:\\keys\\dsh',
    })
    expect(() => parseVpsDeploymentInput({ sshUser: 'root;rm -rf /', sshPort: 22 })).toThrow('vps_ssh_user_invalid')
    expect(() => parseVpsDeploymentInput({ sshUser: 'root', sshPort: 22, command: 'id' })).toThrow('vps_deploy_input_invalid')
  })

  it('generates a restricted, pinned server installation script', () => {
    const script = vpsDeploymentScriptForTesting(settings)
    expect(script).toContain('frp_0.70.1_linux_amd64')
    expect(script).toContain('333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6')
    expect(script).toContain('proxyBindAddr = "127.0.0.1"')
    expect(script).toContain('vhostHTTPPort = 7080')
    expect(script).toContain('dsh-mobile-frps.service')
    expect(script).toContain('reverse_proxy 127.0.0.1:7080')
    expect(script).toContain('chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list')
    expect(script).toContain('[ "$caddy_preexisting" = true ]')
  })

  it('installs a public IP certificate and automatic renewal for an IPv4 origin', () => {
    const ipSettings = parseFrpSettings({ ...settings, serverAddress: '203.0.113.10', publicOrigin: 'https://203.0.113.10' })
    const script = vpsDeploymentScriptForTesting(ipSettings)
    expect(script).toContain('--preferred-profile shortlived --ip-address 203.0.113.10')
    expect(script).toContain('certbot==5.8.0')
    expect(script).toContain('default_sni 203.0.113.10')
    expect(script).toContain('dsh-mobile-cert-renew.timer')
    expect(script).toContain('tls /var/lib/caddy/dsh-mobile-certs/fullchain.pem')
  })

  it('returns only redacted deployment checks after the remote script succeeds', async () => {
    let capturedScript = ''
    const result = await deployVps(settings, { sshUser: 'root', sshPort: 22 }, {
      runSsh: async (_input, host, script) => {
        expect(host).toBe('frp.example.com')
        capturedScript = script
        return {
          stdout: 'DSH_MOBILE_CHECK os ok Ubuntu\nDSH_MOBILE_CHECK frps ok started\nDSH_MOBILE_DEPLOYMENT_OK\n',
          stderr: '',
        }
      },
    })
    expect(result.deployed).toBe(true)
    expect(result.checks).toEqual([
      { id: 'os', status: 'ok', detail: 'Ubuntu' },
      { id: 'frps', status: 'ok', detail: 'started' },
    ])
    expect(capturedScript).toContain(settings.token)
  })

  it('redacts the token when a remote check reports it', async () => {
    await expect(deployVps(settings, { sshUser: 'root', sshPort: 22 }, {
      runSsh: async () => ({
        stdout: `DSH_MOBILE_CHECK remote-command error ${settings.token}\n`,
        stderr: '',
      }),
    })).rejects.toThrow('<redacted>')
  })
})
