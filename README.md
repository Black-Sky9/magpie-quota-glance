# magpie-quota-glance

一个 magpie 插件：把每个账号的积分收在一处。

它在「用量 › 概览」底部加一块面板，按供应商汇总该供应商下**所有账号**的积分——积分总量、已用积分与消耗百分比、剩余积分，以及**最近 3 天内到期**的积分（带到期时刻）。同一个面板也会出现在每个供应商的编辑页里，只显示该供应商。

这是一个纯面板插件：不碰你的请求、不调用厂商接口、不从 magpie 读取任何数据（`magpie plugin` 显示 `reads nothing`）。

![用量 › 概览底部的积分面板](docs/screenshot.png)

<sub>截图使用虚构的账号与数字。</sub>

## 面板显示什么

| 行 | 含义 |
| --- | --- |
| 积分总量 | 该供应商下各账号计分窗口 `limit` 之和 |
| 已用 / 消耗 | 窗口 `amount`（已用积分）之和，及其占总量比例 |
| 剩余 | 总量减已用 |
| 3 天内到期 | 批次在 72 小时内作废的积分（`runsOutAt`），以及 72 小时内重置的窗口 |

每个账号还会显示：套餐、已用 / 上限、消耗百分比、逐窗口进度条、重置时间、到期积分与时刻。额度读不到的账号（401、未订阅、无套餐）会标为「额度暂不可读」，而不是被当成 0 计入合计。

## 安装

从本地目录（解压后）：

```bash
magpie plugin add "<该文件夹的绝对路径>"
magpie plugin            # 预期输出：panels  Credits on usage, Credits on provider (reads nothing)
```

或直接从 GitHub 拉：

```bash
magpie plugin add github:Black-Sky9/magpie-quota-glance
```

装好后打开「用量 › 概览」，滚到底部即是面板。详细步骤、卸载与排错见 [INSTALL.md](INSTALL.md)。

## 工作原理

magpie 的插件页面跑在沙盒里，只能读 `usage:summary` 与 `providers:list`，且 CSP 是 `connect-src 'none'`——所以页面拿不到按账号的积分。因此由插件宿主（Bun，`index.mjs`）读取 magpie 自己的配额缓存（`~/.config/magpie/quotas.json`，与内置卡片用的是同一份 `auth.usage` 结果），算好聚合快照后写入 `panel/live.js`；面板用沙盒允许的 `<script src="live.js?v=…">` 把它取回来。

```
quotas.json ──► index.mjs（聚合）──► panel/live.js ──► 面板（每 3 秒）
```

聚合口径：

- 只统计总额窗口；带 `aside` 标记的（或 `spans[i].aside`）是同一笔积分的拆分（例如 CodeArts 的「基础积分包」「赠送积分包」），跳过不重复计入。
- `used` 是百分比，`amount` 是已用积分，`limit` 是上限。
- 到期积分优先取 `runsOutAt`（批次作废时刻），其次取 `resetsAt`（周期重置）；两者都有时取 `min(runsOut, 剩余)`。
- `runsOutAt` 不是「按当前速度会用完」的预测，只作为批次作废时刻使用。

## 隐私

- `magpie plugin` 显示 `reads nothing`：面板没有声明任何读取权限，也不会去请求厂商接口。
- 快照里的账号只用 `sha256(账号 ID)` 的前 8 位，不含真实账号 ID。
- 运行时生成的 `panel/live.js`（含你本地的额度数字）已被 `.gitignore` 排除，也不会打进 npm 包。

## 限制

- 面板只能追加在内置概览的末尾：magpie 的插件 UI 只在页面末尾（或供应商编辑页）提供 `panels` 插槽；用 `page.replaces` 接管整个用量页会顺带丢掉请求账本和上下文页，所以本插件刻意保持为面板。
- 数据新鲜度跟随 magpie 自身的配额刷新间隔（分钟级），不是实时。

## 文件

```
package.json      插件清单（magpie.panels、magpie.icon）
index.mjs         宿主侧：读 quotas.json、聚合、写 panel/live.js
panel/quota.html  面板页面（沙盒 frame）
panel/quota.css   面板样式，走 --magpie-* 主题变量
panel/quota.js    面板渲染；标题图标为内联矢量
icon.svg          插件图标源文件（清单里以 data URI 内嵌）
panel/live.js     运行时生成，不提交
```

## 许可

MIT
