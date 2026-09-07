# 部署与运维手册

## 1. 运行环境

- Debian 13（`My-debian`），Node v22.23.1
- dsh 全局安装：`npm install -g @deepseek-ai/dsh@<version>`（当前 **0.1.1-rc.2**，包在 `/usr/lib/node_modules/@deepseek-ai/dsh`）
- Harness 主目录：`~/.dsh/`（`DSH_HOME`）

```
~/.dsh/
├── profiles/
│   ├── web/                 # 主 profile（Web UI）
│   │   ├── cordis.patch.yml    # 用户 patch 层 → harness/config/cordis.patch.yml
│   │   ├── package.json        # dsh.profile.bundles: dsh-base + dsh-web-app
│   │   └── node_modules/@dsh-local/   # 3 个自写插件的安装副本
│   ├── headless/            # 一次性任务 profile（bundles: dsh-base + dsh-headless）
│   └── node_modules/         # @deepseek-ai/* 全是指向全局安装的软链（226 个）
├── plugins/                 # 插件源码目录（provider-proxy-settings, web-search-searxng）
├── settings.yaml            # 运行时设置（UI 设置页写这里）
├── .credentials.yaml        # 密钥（chmod 600，绝不备份到公开处）
├── skills/  tools/          # 研究栈（skills/ 仓库内）
└── sessions/ storages/     # 会话数据
```

## 2. systemd 服务

`harness/config/dsh-web.service`：

```ini
ExecStart=/usr/bin/dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host dsh.19970626.xyz
Restart=always
RestartSec=5
```

drop-in `harness/config/dsh-web-proxy.conf`（第 0 层代理，管 Node fetch）：

```ini
Environment=NODE_OPTIONS=--use-env-proxy
Environment=HTTP_PROXY=http://192.168.1.220:7890
Environment=HTTPS_PROXY=http://192.168.1.220:7890
Environment=NO_PROXY=opencode.ai,api.deepseek.com,windhub.cc,localhost,127.0.0.1
```

安装：两文件分别放 `/etc/systemd/system/dsh-web.service` 和 `/etc/systemd/system/dsh-web.service.d/proxy.conf`，`systemctl daemon-reload && systemctl enable --now dsh-web`。

## 3. 访问方式

1. **SSH 端口转发（日常）**：Windows 上 `ssh -L 3080:127.0.0.1:3080 root@<server>`，浏览器开 `http://127.0.0.1:3080`。0.1.1-rc.2 无认证直接可用。
2. **域名**：`https://dsh.19970626.xyz`（反代到 loopback:3080，`--trusted-host` 放行该 Host）。

## 4. 密钥管理

| 环境变量名 | 用途 |
|---|---|
| `OPENCODE_GO_API_KEY` | opencode Console Go 网关 |
| `ANY_API_KEY` | anyrouter（anthropic 协议） |
| `AGENT_API_KEY` | agentrouter（agent + glm 共用） |
| `ARAK_API_KEY` | windhub（arak，未启用代理路由） |

真实值放 `~/.dsh/.credentials.yaml`（结构见 `harness/config/credentials.example.yaml`）。UI 的 设置 → 模型 → 密钥框 写入的就是这个文件。`settings.yaml` 中 provider 的 `apiKeyEnv` 只引用变量名。

## 5. 插件安装/更新

插件以 `@dsh-local/<name>` 本地包形式存在于 profile 的 `node_modules`（源码在 `~/.dsh/plugins/`，安装副本软链/拷贝过去）。**改插件源码后必须同步两份**：

```bash
cp ~/.dsh/plugins/provider-proxy-settings/lib/index.js \
   ~/.dsh/profiles/web/node_modules/@dsh-local/provider-proxy-settings/lib/index.js
systemctl restart dsh-web
```

## 6. 配置修改的坑（重要）

- **改 `settings.yaml` 前先 `systemctl stop dsh-web`**。运行中的服务持有设置内存态，watcher 竞争会把内存态 flush 回文件、覆盖你的手改（实测踩过）。改完再 start。
- **patch 层 config 是整体替换**：覆盖某插件 config 时，bundle 层原有字段要原样重抄。
- `cordis.patch.yml` 改动重启生效；`--dump-config` 可无损预览合成树。

## 7. 健康检查

```bash
systemctl is-active dsh-web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/     # 期望 200
journalctl -u dsh-web -n 50 | grep provider-proxy
# 正常 boot 序列（0.1.1-rc.2）：
#   loaded: proxy=(disabled) ...      ← settings 就绪前的初载，正常噪音
#   self-test FAIL: subprocess ...    ← 同上，正常噪音
#   config: proxy=http://... enabled=[agent, any, opencode-go]   ← 真正生效
# 聊天后应看到 [provider-proxy] ok <provider>/<model> via ... (HTTP 200, Nms)
```

## 8. 一次性任务（headless）

```bash
dsh --profile headless "任务文本"          # 用默认模型跑完退出
dsh --profile headless --patch <file> ...  # 临时挂插件/改配置的测试通道（本仓库用它做回归验证）
```

注意：0.1.1-rc.2 的 `--patch` 中**相对插件名按 profile 根目录解析**（0.1.2-rc.1 才锚定 patch 文件所在目录），跨目录挂载用绝对路径。
