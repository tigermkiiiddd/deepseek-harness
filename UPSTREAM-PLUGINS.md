# 上游插件备忘 / Upstream Plugin Provenance

本文件是**运维备忘**，不是 Agent Note（不走 `.agents/notes` 的分类与 i18n 规则）。
用途：有人问"上游是否又有更新"时，先按下面的对照表定位到正确的上游，别查错地方。

记录日期：2026-09-02。

## dsh-better-sidebar（DSH Web 右侧边栏插件）

- **是什么**：DSH web client 的 VSCode-like 右侧边栏（explorer / editor / terminal / git / sidechat / subagent 页）。
- **上游仓库（公开）**：<https://github.com/omdsh-dev/DSH-better-sidebar>（org `omdsh-dev`；npm 包名 `dsh-better-sidebar`）
- **本机安装位置**：`C:\Users\shinobi\.dsh\profiles\web\node_modules\dsh-better-sidebar`
  - 它装在 **DSH_HOME 的 web profile** 里，**不在 harness 仓库里**——在 fork 的 git 历史 / package.json / lockfile 里搜不到它是正常的，别据此下"没装过"的结论。
- **引入链**（见 `C:\Users\shinobi\.dsh\profiles\web\pnpm-lock.yaml`）：
  profile `package.json` → `@linxin666/dsh-web-all@0.3.12` → `dsh-better-sidebar@0.18.0-alpha.0`
- **查更新的两条线**（两条都要看，npm 常落后于 git main）：
  1. npm：`npm view dsh-better-sidebar dist-tags time --json`
     - 2026-09-02 时点：`alpha = 0.18.0-alpha.0`（= 本机版本，发布于 2026-08-30）、`latest = 0.17.1`
  2. git main：<https://github.com/omdsh-dev/DSH-better-sidebar/commits/main>
     - 2026-09-02 时点：已 bump **v0.19.0-alpha.0**（PR #516，适配 DSH 0.1.2-alpha.5），另有 terminal resize / 文件树聚焦刷新 / 折叠开关对齐 / editor 选区弹窗等修复；**尚未发 npm**。
- **升级方式**：npm alpha 发布后在 web profile 目录 `pnpm update`（或升 `dsh-web-all`）；急用则直接 `dsh-better-sidebar@github:omdsh-dev/DSH-better-sidebar#main`。
- **当前实际安装（2026-09-02 起）**：本地克隆 `G:\projects\DSH-better-sidebar`（upstream main @ v0.19.0-alpha.0，已 `pnpm install` + prepare 构建 lib/）；web profile 经**目录联接** `C:\Users\shinobi\.dsh\profiles\web\dsh-better-sidebar-local` → 该克隆，并在 `pnpm-workspace.yaml` 里 override：`dsh-better-sidebar: 'file:./dsh-better-sidebar-local'`（profile 的 pnpm-lock.yaml 已固化；package.json 未动）。以后同步 = 在克隆里 `git pull && pnpm install`（prepare 自动重建 lib/），profile 侧无需再动。
- **2026-09-02 乌龙根因（为什么"装过却跑不起来"）**：① web-ui-upgrade 把聚合包从 `dsh-web-ui-all`(0.2.x) 改名为 `dsh-web-all`(0.3.12) 时，**没有把它加回 `dsh.profile.bundles`**——bundles 之外的包其 patch 层根本不会应用，sidebar 连同全家桶 ~20 个插件全部未挂载（已修复：bundles 追加 `@linxin666/dsh-web-all`）。② 本 checkout 的 `packages/llm/llm`、`packages/subagent/subagent` 缺 `lib/index.js`（tsx 源码启动不需要，但社区插件走普通 Node 解析需要）——已用根 `pnpm run build:lib:host` 补齐。排查此类问题：profile 挂载 = `package.json` 的 `dsh.profile.bundles` 列表 + profile `cordis.patch.yml`，两处都没有就是没挂。

## "上游"对照表（防混淆）

| 问的"上游" | 正确的检查对象 |
|---|---|
| 侧边栏插件更新 | `omdsh-dev/DSH-better-sidebar` + npm `dsh-better-sidebar`（本文件） |
| harness 官方上游 | git remote `origin` = `deepseek-ai/deepseek-harness`（公开）；本机 fork = `tigermkiiiddd/deepseek-harness`（remote 名 `fork`） |
| vendor/ 框架层 | `vendor/README.md` manifest：`cordiverse/cordis`（公开）；`deepseek-harness` org 的 cosmokit / schemastery / cordis fork（私有，本机账号无权限，需在有权限的机器上查） |

## 教训（2026-09-02 乌龙记录）

问"上游是否又有更新"时，**先确认指的是哪个上游**：本部署语境下默认指上面第一行的社区插件；
不要默认去查 `vendor/` manifest，也不要对公开仓库说"没权限"。第三方 DSH 插件装在
DSH_HOME 的 profile node_modules 里（`C:\Users\shinobi\.dsh\profiles\<profile>\node_modules`），
排查时直接列该目录找非 `@deepseek-ai` scope 的包即可。
