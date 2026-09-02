# 自建 FRP 远程访问功能交接

## 目标与当前结果

本次改造完成了 DSH Mobile 自建 FRP 的配置、VPS 自动部署、本机组件安装、连通性验证和后续维护入口。用户可以使用域名，也可以直接使用公网 IPv4 建立 HTTPS 远程访问。

数据链路如下：

```text
手机 App
  -> HTTPS（域名或公网 IPv4）
  -> VPS 上的 Caddy
  -> 127.0.0.1:7080（frps HTTP vhost）
  -> 加密 FRP 隧道
  -> 运行 DSH 的电脑
  -> DSH HTTP gateway
```

公网入口仍需要在手机端完成 DSH 配对。FRP 只负责传输，不替代 DSH 的访问令牌和设备授权。

## 主要代码

- `src/frp-config.ts`：FRP 配置校验、持久化和脱敏状态。
- `src/frp-template.ts`：frps、frpc、Caddy 配置模板。
- `src/frp-component.ts`：固定版本官方 frpc 的下载、校验和安装。
- `src/vps-deploy.ts`：通过 SSH/SCP 自动部署 VPS，包含 systemd、Caddy 和证书配置。
- `src/frp.ts`：本机 frpc 生命周期、重连和状态管理。
- `src/file-logger.ts`：插件 JSONL 文件日志及启动时轮转。
- `src/plugin.ts`：插件路由、命令和各组件组装。
- `src/client.ts`、`src/client-messages.ts`：自建 FRP 配置和维护界面。
- `apps/mobile/android/.../RemoteHostPolicy.kt`：允许远程模式连接公网 IPv4，同时继续禁止私网地址冒充远程入口。

## 状态与敏感信息

FRP 设置保存在：

```text
$DSH_HOME/mobile-access/remote/frp/config/settings.json
```

该文件包含服务器地址、共享 Token 和公网入口，权限按仅当前用户可读写处理。状态接口不会返回 Token。

SSH 用户、端口和私钥路径只作为表单便利信息保存在当前浏览器的 `localStorage`，键名为：

```text
dsh-mobile.frp-vps-form.v1
```

共享 Token 不写入 `localStorage`。私钥文件本身不会复制到插件目录、DSH 状态目录或 VPS。

插件日志默认位于：

```text
$DSH_HOME/mobile-access/logs/dsh-mobile.log
```

日志为 JSONL，启动时在超过 5 MB 后轮转。日志不得记录共享 Token、私钥内容、DSH 配对令牌或 SSH 密码。

## VPS 自动部署内容

部署器面向带 systemd 的 Ubuntu/Debian，支持普通 sudo 用户或 root。主要路径和服务如下：

```text
/etc/dsh-mobile/frps.toml
/usr/local/libexec/dsh-mobile/frp/0.70.1/frps
/etc/caddy/Caddyfile
/opt/dsh-mobile/certbot-venv
/var/lib/caddy/dsh-mobile-certs
dsh-mobile-frps.service
dsh-mobile-cert-renew.timer
```

FRP 二进制先在运行插件的电脑下载并校验，再通过 SCP 上传，避免 VPS 访问 GitHub 超时。部署器不会覆盖无法识别的既有 Caddy 配置。

域名模式使用 Caddy 自动 HTTPS。公网 IPv4 模式使用 Certbot 5.8.0 申请 Let's Encrypt 短期 IP 证书，并由 systemd timer 每日检查续期；Caddy 使用该证书并配置对应的 `default_sni`。

## 安全边界

- frps HTTP vhost 仅监听 VPS 回环地址 `127.0.0.1:7080`，公网只暴露 Caddy 的 HTTPS 入口。
- 当前模板只创建一个受控 HTTP 代理，不开放任意 TCP/UDP 转发。
- frps 与 frpc 必须使用同一个高强度共享 Token。
- VPS 安全组通常只需放行 SSH、HTTP、HTTPS 和 frps 控制端口；管理端口不应公开。
- 公网访问仍依赖 DSH 配对令牌；二维码和带令牌的 URL 不应分享或写入日志。
- 私钥路径只在本机使用，不上传私钥。

## 验证与构建

仓库根目录：

```powershell
npm run typecheck
npm test
npm run build
```

Android：

```powershell
cd apps/mobile/android
.\gradlew.bat --no-daemon testDebugUnitTest assembleDebug
```

调试 APK 输出到：

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

发布 APK 仍需维护者提供正式签名配置。

## 运维检查

VPS 上可使用以下命令排查：

```bash
sudo systemctl status dsh-mobile-frps.service caddy dsh-mobile-cert-renew.timer
sudo journalctl -u dsh-mobile-frps.service -u caddy -n 200 --no-pager
sudo ss -lntp
curl -vk https://PUBLIC_HOST/
```

本机优先检查插件日志、frpc 进程状态，以及 DSH 是否仍在运行。Windows 杀毒软件可能隔离 frpc；如确有拦截，应只为已校验的组件目录设置最小范围例外，不建议长期关闭杀毒软件。

## 已知限制与后续建议

- 公网 IPv4 扫码需要安装包含本次地址策略修改的新 Android App；旧版可能把 IP 入口判为无效连接。
- SSH 表单记录按浏览器配置文件保存，换浏览器或清理站点数据后会丢失；若需要跨浏览器恢复，可增加服务端部署元数据，但不得保存私钥或密码。
- IPv4 证书是短期证书，必须保持续期 timer 和 Caddy 服务正常。
- 中国大陆未备案域名可能被云厂商或网络侧拦截；公网 IPv4 模式可减少对域名的依赖，但仍受云厂商策略约束。
- 后续可增加分阶段部署进度、可复制的失败诊断包、外部浏览器端到端测试和正式 Android 签名流水线。
