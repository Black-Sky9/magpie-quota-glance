# magpie-quota-glance

一个 magpie 插件：把每个供应商的积分使用详情和总览显示在底部板块，同时也标记了3天内过期的积分详情。

它在「用量 › 概览」底部加一块面板，按供应商汇总该供应商下**所有账号**的积分——积分总量、已用积分与消耗百分比、剩余积分，以及**最近 3 天内到期**的积分（带到期时刻）。只报余额的供应商单列「余额」，只报百分比的（例如 Cline 的周期用量）显示最高用量。同一个面板也会出现在每个供应商的编辑页里，只显示该供应商。

这是一个纯面板插件：不碰你的请求、不调用厂商接口、不从 magpie 读取任何数据（`magpie plugin` 显示 `reads nothing`）。

![用量 › 概览底部的积分面板](docs/screenshot.png)

<sub>截图使用虚构的账号与数字。</sub>

## 面板显示什么

| 行 | 含义 |
| --- | --- |
| 积分总量 | 该供应商下各账号计分窗口 `limit` 之和 |
| 已用 / 消耗 | 窗口 `amount`（已用积分）之和，及其占总量比例 |
| 剩余 | 有上限的窗口的总量减已用 |
| 余额 | 只报余额、不报上限的窗口（`balance`，或 `display` 里的「剩余 N」「N credits」）之和 |
| 最高用量 | 只有百分比的周期窗口里最高的那个（例如 Cline 的 Weekly / Month） |
| 3 天内到期 | 批次在 72 小时内作废的积分（`runsOutAt`），以及 72 小时内重置的窗口 |

每个账号还会显示：套餐、已用 / 上限、余额或各周期用量、消耗百分比、逐窗口进度条、重置时间、到期积分与时刻。

余额不混进「积分总量 / 已用 / 剩余」：两者口径不同，相加会得出无法解释的数字。

额度一个都读不到的账号（已退登、已被删除、401、无套餐）**不进快照**——magpie 的 `quotas.json` 会保留旧记录，若不剔除，删掉的供应商会一直挂在面板上显示 0。只有说明性文案（例如「今日已签」）或掉登录提示的窗口同样不算额度。

## 只算你想算的供应商

- 右上角 **「选择供应商」**：列出当前识别到的所有供应商，勾选决定哪些纳入合计，支持「全选 / 全不选」。
- 每张供应商卡片右侧 **「排除」**：一键把该供应商去掉。
- 被排除的供应商不显示卡片，也不计入总量 / 已用 / 剩余 / 3 天内到期；表头会标明「已排除 N 个」。
- 选择保存在本插件自己的 options 里（`plugins.json` 中该插件条目的 `options.excluded`），重启、刷新都保留。

另外提供一个 MCP 工具 `quota_snapshot`（在 magpie 的 MCP 里显示为 `magpie-quota-glance_quota_snapshot`）：agent 可以直接问「现在还有多少积分、哪些快到期」，拿到的就是面板用的同一份快照 JSON。

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

- 每个窗口先归一成四类：有上限（`credit`）、只有余额（`balance`）、只有百分比（`percent`）、只有文案（`text`）。前两类分别计入总量与余额，百分比只取最高值展示，文案不参与合计。
- 有上限的窗口按 `limit` 计；`amount` 是已用积分，`used` 是百分比。单位不再必须是 `credits`，`points`、`积分` 等按积分类处理；`tokens`、`requests`、`usd`、`次` 等明显不是积分的单位会跳过。
- 只有余额的窗口取 `balance`，其次从 `display` 里读「剩余 N」「N credits」；只有百分比的窗口取 `used`。
- `display` 里的「已用 / 上限」（如 `0 / 500 credits`）也会被解析，用来补上厂商没放进 `limit` 的数字。
- 带 `aside` 标记的（或 `spans[i].aside`）是同一笔积分的拆分（例如 CodeArts 的「基础积分包」「赠送积分包」），跳过不重复计入；如果一组窗口全是 `aside`（例如 Loomy、CatPaw 把每个池都标成拆分），则把它们当作真正的池。
- 到期积分优先取 `runsOutAt`（批次作废时刻），其次取 `display` 里的到期日期（`12-02 到期`、`30 天后作废`），再次取 `resetsAt`（周期重置）；两者都有时取 `min(runsOut, 剩余)`。
- `runsOutAt` 不是「按当前速度会用完」的预测，只作为批次作废时刻使用。

## 隐私

- `magpie plugin` 显示 `reads nothing`：面板没有声明任何读取权限，也不会去请求厂商接口。
- 快照里的账号只用 `sha256(账号 ID)` 的前 8 位，不含真实账号 ID。
- 运行时生成的 `panel/live.js`（含你本地的额度数字）已被 `.gitignore` 排除，也不会打进 npm 包。

## 限制

- 面板只能追加在内置概览的末尾：magpie 的插件 UI 只在页面末尾（或供应商编辑页）提供 `panels` 插槽；用 `page.replaces` 接管整个用量页会顺带丢掉请求账本和上下文页，所以本插件刻意保持为面板。
- 数据新鲜度跟随 magpie 自身的配额刷新间隔（分钟级），不是实时。
- 余额与百分比是从厂商返回的 `display` 文案里解析出来的，口径由厂商决定；不同供应商的「余额」不一定能直接相加，所以单独一列。
- `quotas.json` 里没有额度窗口的供应商（未登录、未订阅、插件未上报）不会出现在面板上。

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
