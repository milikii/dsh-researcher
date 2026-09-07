# dsh 搜索预设：SearXNG（主）+ Exa（备）

DeepSeek Harness（dsh）Web 会话的 `web_search` 能力由两个可切换的搜索预设供给：

| 预设 | 插件 | 版本 | 角色 | 成本 |
|---|---|---|---|---|
| **searxng** | `@dsh-local/web-search-searxng` | 0.2.0 | **主搜索**（日常钉死） | 零（自建聚合器） |
| **exa** | `@dsh-local/web-search-exa-settings` | 0.1.0 | **备份搜索**（语义检索 / 主搜索故障兜底） | Exa API 配额 |

两个 provider 同时注册进 dsh 的 `ctx.web` seam，`cordis.patch.yml` 里一行 `searchProvider` 钉死当前生效者；切换 = 改一个词 + 重启服务。

```bash
# config/cordis.patch.yml（节选，完整见仓库）
- id: web
  config:
    searchProvider: searxng    # ← 改成 exa 即切换备份预设
```

## 为什么是这两个预设（思路）

- **自建优先**：SearXNG 跑在自己机器的 Docker 里（`deploy/`），聚合 bing/baidu/sogou/google/brave/ddg 等 13 家引擎，查询不出家门、无配额、无 API 费用，且可按中文场景定制路由。这就是它当**主预设**的原因。
- **保留商业备份**：Exa 的 neural（语义）检索是关键词聚合器做不到的能力——"找和这篇论文相似的""找讨论过这个概念的长文"这类查询 Exa 更强；同时它是 SearXNG 整体故障时的兜底。两者能力互补，不是简单冗余。
- **插件化而非 fork**：两个预设都以 dsh 插件形式挂载（`cordis.patch.yml` insert 行），不改 harness 本体，升级 harness 不丢搜索能力。

## 当前状态（2026-09-07）

| 层 | 组件 | 状态 |
|---|---|---|
| 聚合器 | SearXNG Docker（`searxng/searxng:latest`，本机 8080 端口） | 运行中，13 引擎启用，JSON API 开放 |
| 主预设插件 | web-search-searxng 0.2.0 | 线上生效（`searchProvider: searxng`） |
| 备预设插件 | web-search-exa-settings 0.1.0 | 已注册可用，带 UI 设置卡片 + 热生效 |
| harness 运行时 | dsh 0.1.1-rc.2（web profile） | searxng 预设不依赖 dsh-settings API，升级 0.1.2 无需迁移；exa 预设需迁移（见 `docs/exa-preset.md` §5） |

## 目录

| 路径 | 内容 |
|---|---|
| `docs/searxng-preset.md` | 主预设详解：部署、引擎路由、清洗管线、查询语法、版本历史、改进方向 |
| `docs/exa-preset.md` | 备预设详解：包装官方包的思路、动态热生效机制、密钥回退链、改进方向 |
| `docs/comparison.md` | 双预设对比表、切换操作、选型决策、联动改进 |
| `plugins/web-search-searxng/` | 主预设源码（core.js 纯函数层 + index.js HTTP 层 + 冒烟测试） |
| `plugins/web-search-exa-settings/` | 备预设源码（node 半边 + browser 半边） |
| `deploy/` | SearXNG 容器部署：docker-compose.yml + settings.yml（已脱敏） |
| `config/cordis.patch.yml` | 两个预设的挂载与切换点（实际生效的 patch 层） |

## 快速操作

```bash
# 搜索引擎（聚合器）状态
docker ps | grep searxng
curl -s 'http://127.0.0.1:8080/search?q=test&format=json' | head -c 300

# 切换预设
#   1) 编辑 ~/.dsh/profiles/web/cordis.patch.yml: searchProvider: searxng → exa
#   2) systemctl restart dsh-web

# 冒烟测试（主预设纯函数层）
node plugins/web-search-searxng/test/smoke.mjs
```

## 密钥纪律

- 本仓库所有副本已脱敏：SearXNG `secret_key`、Exa `apiKey` 均为占位符。
- 真实值只存在于服务器：`/home/docker/searxng/config/secret_key`、`~/.dsh/profiles/web/cordis.patch.yml`（Exa 明文 key 待改造为 `$EXA_API_KEY` 环境引用，见 exa-preset.md 改进项 #1）。
