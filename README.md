# dsh-researcher：dsh 搜索研究栈（搜索预设 + 浏览器层 + 爬虫项目）

DeepSeek Harness（dsh）Web 会话的 `web_search` 与其背后的完整研究栈——**分五层**：

```
L1  搜索预设层    web_search 后端，双预设可切换
      ├─ searxng（主）：自建 SearXNG 聚合器，零成本，中文优化
      └─ exa（备）：商业语义搜索，neural 检索 + 故障兜底
L2  平台专用搜索  shop-search（电商登录态搜索）、x-search
L3  URL 读取层   fetch-url（http → CDP 自动降级）
L4  登录态深读   Docker Chromium + CDP（持久登录态的真实浏览器）
L5  批量采集     MediaCrawler（复用 L4 登录态）+ shop-search 兜底链
```

核心原则（`skills/nas-core`）：**Chromium 是"登录态网页深度读取器"，不是搜索引擎——搜索第一入口永远是 web_search（SearXNG）。**

---

## 两个搜索预设（L1）

| 预设 | 插件 | 版本 | 角色 | 成本 |
|---|---|---|---|---|
| **searxng** | `@dsh-local/web-search-searxng` | 0.2.0 | **主搜索**（日常钉死） | 零（自建） |
| **exa** | `@dsh-local/web-search-exa-settings` | 0.1.0 | **备份**（语义检索 / 兜底） | Exa API 配额 |

切换 = `cordis.patch.yml` 改一行 `searchProvider: searxng|exa` + 重启 dsh-web。详见 `docs/comparison.md`。

## 当前状态（2026-09-07）

| 层 | 组件 | 状态 |
|---|---|---|
| L1 | SearXNG 容器（8080，13 引擎）+ 两插件 | 运行中；searxng 预设钉死生效 |
| L4 | chromium 容器（CDP `172.19.0.2:9222` 经 socat 暴露于 Docker 网络内，healthcheck 绿） | 运行中，登录态持久化 |
| L5 | mediacrawler 容器（WebUI 8088，CDP bridge 接 chromium 登录态） | 运行中 |
| 底座 | mihomo 代理（宿主机 7890） | 运行中 |
| harness | dsh 0.1.1-rc.2（web profile） | searxng 预设升级免迁移；exa 预设有 0.1.2 迁移方案（已验证） |

## 目录

| 路径 | 内容 |
|---|---|
| `docs/searxng-preset.md` | 主预设：部署、引擎路由、清洗管线、查询语法、版本、改进 |
| `docs/exa-preset.md` | 备预设：包装官方包思路、热生效机制、密钥回退链、改进 |
| `docs/comparison.md` | 双预设对比、切换操作、选型决策、联动 roadmap |
| `docs/browser-and-crawlers.md` | **L2-L5 全解**：Chromium CDP 设计、cdp-solve 验证接管、MediaCrawler、shop-search 栈、mihomo |
| `plugins/` | 两个搜索预设插件源码 |
| `deploy/` | 4 个容器部署：searxng / chromium(+cdp-proxy) / mediacrawler(+cdp-bridge) / mihomo |
| `tools/` | 11 个栈工具（cdp-solve、cdp_read、shop-search×3、mc-crawl、x-search、巡检×2、fetch-url-tests） |
| `skills/` | dsh 技能路由文档：nas-core（基座/纪律）、nas-search（L1-L5 路由）、nas-shop（电商比价） |
| `config/cordis.patch.yml` | 搜索预设的挂载与切换点 |

## 快速操作

```bash
# L1 搜索层
curl -s 'http://127.0.0.1:8080/search?q=test&format=json' | head -c 300   # SearXNG 直测
node plugins/web-search-searxng/test/smoke.mjs                            # 插件冒烟

# L4/L5 容器
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'chromium|searxng|mediacrawler|mihomo'

# 栈巡检
bash tools/nas-stack-status.sh

# 切换搜索预设
#   vim ~/.dsh/profiles/web/cordis.patch.yml → searchProvider: exa → systemctl restart dsh-web
```

## 密钥纪律

- 本仓库所有副本已脱敏：SearXNG `secret_key`、Exa `apiKey` 均为占位符；mihomo 代理配置（订阅/节点）不入库；cookie 名单只含**名字**不含值。
- 真实值只存在于服务器：`/home/docker/searxng/config/secret_key`、`~/.dsh/profiles/web/cordis.patch.yml`、`/opt/stacks/mihomo/config/`。
- chromium `/config` 卷含全部登录态 Cookie，绝不镜像入库。

## 范围说明

- 本仓库 = **搜索研究栈**（L1-L5 + 工具 + 技能文档 + 容器部署）。
- dsh harness 本身的部署/版本管理是另一个主题（systemd 服务、模型路由、版本回滚），不在本仓库范围。
- MediaCrawler 源码为本地 build 的 `mediacrawler:local` 镜像，源码目录不在本仓库（`deploy/` 只含容器编排）。
