# 积分总览 · 安装说明

在 magpie 的「用量 › 概览」底部加一块面板：按供应商汇总该供应商下**所有账号**的积分总量、
已用积分与消耗百分比、剩余积分，以及**最近 3 天内到期**的积分总量和到期时刻。
每个供应商的编辑页里也有一块同样的面板（只显示该供应商）。

## 要求

- magpie 已安装并能正常打开（本插件在 0.12.6 上验证）
- 已经通过插件登录至少一个带积分的供应商（CodeArts、MiniMax Code 等）

## 安装

1. 解压 `magpie-quota-glance-0.1.1.zip`，得到一个 `magpie-quota-glance` 文件夹（放进任意固定目录，不要删）。
2. 在该文件夹的**上一级**打开终端，执行：

   ```
   magpie plugin add "<解压后的 magpie-quota-glance 目录绝对路径>"
   ```

   Windows 例：`magpie plugin add "C:\Tools\magpie-quota-glance"`

   也可以在应用里「插件 → 添加」选这个文件夹。或者直接从 GitHub 拉：

   ```
   magpie plugin add github:Black-Sky9/magpie-quota-glance
   ```

3. 确认已加载：

   ```
   magpie plugin
   ```

   应看到：

   ```
   <路径>\magpie-quota-glance  on
       panels  Credits on usage, Credits on provider (reads nothing)
   ```

4. 打开「用量 → 概览」，滚到页面底部即是「积分总览」面板。若没出现，执行
   `magpie plugin off <路径>` 再 `magpie plugin on <路径>`，然后关掉用量页重进。

## 卸载

```
magpie plugin rm "<magpie-quota-glance 目录绝对路径>"
```

## 数据从哪来

面板不请求任何厂商接口、不读密钥、不上报任何内容（`magpie plugin` 里的 `reads nothing`）。
插件宿主直接读 magpie 自己缓存的 `~/.config/magpie/quotas.json`（就是概览卡片渲染用的那份
`auth.usage` 结果），在本地算好聚合后写进 `panel/live.js`，面板每 3 秒取一次。

- **积分总量**：该供应商下各账号计分窗口的 `limit` 之和；只算总额窗口，跳过 `aside`
  标记的拆分窗口（例如 CodeArts 的「基础积分包」「赠送积分包」），避免重复计数。
- **已用 / 消耗%**：窗口的 `amount`（已用积分）之和，除以总量。
- **3 天内到期**：窗口的 `runsOutAt`（积分批次作废时刻）落在未来 72 小时内时，取
  `min(runsOut, 剩余)`；没有 `runsOutAt` 但 `resetsAt`（周期重置）落在窗口内时，取剩余积分。
  `runsOutAt` 只是「按当前速度会用完」的预测，不计入到期。

数据新鲜度跟随 magpie 自己的配额刷新节奏（设置里的「用量刷新间隔」，默认约 3 分钟）。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 面板显示「还没有收到积分数据」 | 插件宿主没跑起来，或本机还没有 `quotas.json`。先在应用里发一次对话/打开一次概览，再等几秒；仍不行就 `magpie plugin off/on`。 |
| 数字和上方卡片对不上 | 卡片是即时值，面板取的是最近一次写入 `quotas.json` 的快照，最多差一个刷新周期。 |
| 某个账号没算进合计 | 该账号的额度读取失败（例如 401、未订阅），窗口为空；供应商行会显示「N 个额度不可读」。 |
| 改了插件文件不生效 | `magpie plugin off <路径>` 再 `on`（会重启插件宿主）。 |

## 文件

```
package.json     插件清单（magpie.panels / magpie.icon）
index.mjs        宿主侧：读 quotas.json、算聚合、写 panel/live.js
panel/quota.html 面板页面
panel/quota.css  面板样式（跟随 magpie 主题变量）
panel/quota.js   面板渲染（标题图标为内联矢量，无外部请求）
icon.svg         插件图标源文件（清单里以 data URI 内嵌）
panel/live.js    运行时生成，勿手工编辑，可不随包分发
```
