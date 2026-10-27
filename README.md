# dsh-workspace-tree-status

[![npm](https://img.shields.io/npm/v/dsh-workspace-tree-status?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-workspace-tree-status)
[![license](https://img.shields.io/npm/l/dsh-workspace-tree-status?color=blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)](https://github.com/topics/dsh-plugin)

> DeepSeek Harness Web 的**工作区树状态点**：侧边栏工作区树的每个目录，在目录名左侧多一个状态点——里面有会话在等你回话、刚跑完、或还在跑时，一眼就能看到，不用逐个展开文件夹找。

> Aggregated session status on the workspace-tree folder rows of DSH Web's sidebar: a waiting / finished / running dot in front of every folder name, so a collapsed folder still tells you where someone needs you.

---

## 它解决什么问题

DSH 侧边栏的会话行本来就有状态点，但**折叠起来的文件夹**会把里面所有会话的状态一起藏掉。开着十几个工作区、几个会话同时在跑的时候，只能靠挨个展开去找“哪个跑完了”“哪个在等我点确认”。

这个插件把子会话的状态**向上聚合到父文件夹**：目录名左边亮一个点，颜色就是里面最高优先级的那个状态。

```
工作区树
  ● github                ← 里面有会话刚完成 / 在等你
    ⠋ django              ← 里面有会话在跑
      ● django-reference  ← 等你回答（黄色，最优先）
    ○ life                ← 空闲
```

## 状态点含义

| 点 | 含义 | 判定（聚合后优先级从高到低） |
| --- | --- | --- |
| 黄色实心点，呼吸动画 | 有会话**等你输入** | `pendingInteraction`（提问 / 审批 / 计划确认） |
| 绿色实心点 | 有会话**刚完成**、你还没看 | `completionUnread` |
| 灰色转圈 | 有会话**正在运行** | `running` |
| 不显示 | 空闲 | 以上都没有 |

- 一个文件夹同时有多个状态时只显示优先级最高的一个。
- **父文件夹会汇总所有嵌套工作区**：`/home/wangx/github` 的状态包含 `…/个人/life`、`…/django/django-reference` 等所有子工作区的会话，只按接口路径前缀判定，不做字符串前缀误判（`/a/b` 和 `/a/bc` 不会串）。
- 归档会话、子代理会话（`origin: 'subagent'` / 有 `parentId`）、空白新会话都不计入。
- 不属于任何工作区的会话汇总到“未分组”那一行。
- 只加显示，不拦截点击、不改变展开状态、不写任何会话数据。

## 安装

从本地目录安装（开发时用）：

```bash
dsh plugin --profile web add /home/wangx/github/dsh-workspace-tree-status
```

或从 npm / GitHub 安装：

```bash
dsh plugin --profile web add dsh-workspace-tree-status
dsh plugin --profile web add github:ramwin/dsh-workspace-tree-status
```

装完刷新一次页面。卸载：

```bash
dsh plugin --profile web remove dsh-workspace-tree-status
```

想让父目录聚合真正有用，把侧边栏切到树形：**工作区标题栏右侧「视图选项」→「工作区树」**。内置的「工作区」平铺模式也会显示每行的状态点，只是看不到父子缩进。

## 工作原理（以及为什么不是 slot 插件）

DSH 的侧边栏浏览区 `sidebar.workspaces` 由内置 `@deepseek-ai/dsh-client-ui-workspace` 独占，**工作区/文件夹行没有装饰槽**（会话行有 `sidebar.session.row.leading`，目录行没有；0.2.0-rc.2 与 0.2.1-rc.4 都一样）。所以本插件走的是运行时装饰：

1. 订阅 `sessions.list`、`workspaces.list`、`uiSession.sessionStatus` 三个快照，算出每个工作区的聚合状态；
2. 在 `data-slot="sidebar.workspaces"` 区域内找 `data-row-key="workspace:<id>"` 的行，插入一个自己的 `<span data-dsh-wts>`（`aria-hidden`，`pointer-events: none`）；
3. 注入一段只在 `[data-row-key^="workspace:"]` 下生效的样式，颜色全部用主题 token（`--dsw-alias-state-warn-primary` / `-success-primary` / `-label-tertiary`），跟随明暗主题。

用到的两个契约都是侧边栏自己发布的：`data-slot`（slot 出口）和 `data-row-key`（行身份，内置的拖拽/排序也依赖它）。**未来 DSH 若改掉它们，插件只会退化成“没有点”，不会影响其它界面**——它不读也不改任何其它插件的 DOM、样式或组件源码。

插件激活依赖三个客户端服务（Node 端的 `inject` 声明）：`sessions`、`workspaces`、`uiSession`。这是刻意的硬门槛——`dsh.client.inject` 只决定模块加载顺序，不等服务就绪，先 apply 会拿到空快照、点永远不出现；服务就绪后再订阅，快照变化时重算。禁用/卸载插件时，注入的 `<style>` 和所有状态点会随 effect 一起清掉。

## 验证

- 单测：`node --test test/`，覆盖路径父级判定（`/a/b` vs `/a/bc`）、嵌套工作区向上汇总且不重复计数、等待/完成/运行优先级、归档/子代理/空白会话排除、未分组汇总、状态基线缺失时回退到列表 `running`。
- 真机（DSH 0.2.0-rc.2，`dsh web` + 无头 Chromium 驱动真实页面）：
  - 正在运行：当前会话所在工作区与父目录显示灰色转圈；
  - 刚完成：在 `ai-accounting` 里跑一个回合后切到别的会话，回合结束 → 该工作区与父目录 `github` 同时变绿（`done`）；
  - 等我输入：在新会话里触发 `ask_user_question` 后切走 → 该工作区与父目录同时变黄并呼吸闪烁（`waiting`）；
  - 四种状态的配色、对齐与主题 token 都在真实页面上核对过，控制台没有本插件的报错。

## 已知限制

- 只装饰侧边栏的工作区行；「全部对话」平铺列表没有父目录，不受影响。
- 一个目录只显示一个点（最高优先级），不显示具体数量。

## 配置

无。想关掉时禁用/卸载插件行即可（不需要改任何数据）。

## 开发

```bash
node --test test/     # 纯聚合逻辑的单测（不需要浏览器）
```

调试时可在页面控制台看 `document.querySelectorAll('[data-dsh-wts]')`，或在 `设置 → 插件` 里看到本插件。

## 版本记录

| 版本 | 日期 | 说明 | 使用模型 |
| --- | --- | --- | --- |
| v0.1.0 | 2026-10-27 | 首个版本：工作区树目录行聚合状态点（等待 / 完成 / 运行），嵌套工作区向上汇总 | DeepSeek Harness `deepseek-flash` |
