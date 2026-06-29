# 修复方案：微信群分诊误判（dispatcher self-handle 应用群昵称而非 wxid）

## 1. 症状

群里同时挂多个 crabot 实例 + 真人。同一条消息引发两类**方向相反**的误判：

- **棉花糖**（master=fufu）：gaozhi 发了一条 `@实事求是 你可以通过 ssh ... 部署环境 ... 这条指令就是发送给你的不是给fufu的`，明确点名另一个 bot 且排除 fufu。棉花糖**却派 worker 去执行**（dispatcher 输出 `new_task`）。
- **实事求是**（master=gaozhi）：gaozhi `@实事求是` 让它部署，它**却 `stay_silent`**（trace 理由“用户在询问群成员 FuFu，不是在叫我”）。

线上 trace：棉花糖侧 `403b4f9a`。

## 2. 根因（已实测定位到单点）

dispatcher 注入给 LLM 的“自我身份”锚点是 **bot 的 wxid**：

`crabot-channel-wechat/src/wechat-channel.ts:334`
```js
...(event.puppet?.wxid ? { crab_self_handle: `@${event.puppet.wxid}` } : {}),
```

dispatcher 身份段（`crabot-agent/src/dispatcher/dispatcher-prompt.ts` 的 `buildSelfIdentitySection`）据此告诉模型：
> 你的 @handle: `@<wxid>`；正文出现它才是 @ 你；**其它 @xxx 是发给别人的，不要错把发给别人的内容当成发给自己的指令。**

但微信群消息正文里的 @ 全是**群昵称**（`@实事求是` / `@棉花糖🐶` / `@FuFu🐑`），**永远不会**出现 wxid。于是这个 self 锚点恒定匹配不上，模型既无法确认“`@实事求是` ≠ 我”，也无法解析“这条指令就是发送给你的”里的“你”，最终在“一条字面可执行的部署指令”面前误判。

## 3. 实测证据（忠实复现 + 变量隔离）

用 trace `403b4f9a` 的真实输入（`get_history` 取回当时 6h 窗口 47 条历史 + 触发批次 3 条 + 实际 provider）重建 dispatcher 的 system+user prompt，喂**同一个模型 gpt-5.5**，逐个施加修改：

| 变量 | self-handle | 历史发送者名 | gpt-5.5 实测 |
|---|---|---|---|
| baseline（忠实复现） | `@<wxid>` | wxid | **new_task ×3/3** ← 与线上一致 |
| 只改 self-handle | `@棉花糖🐶` | wxid | **stay_silent ×2/2** |
| 只改历史名 | `@<wxid>` | 昵称 | **new_task ×2/2**（无效） |
| 两个都改 | `@棉花糖🐶` | 昵称 | **stay_silent ×2/2** |

baseline 复现出的 new_task 正文与线上 trace 一字不差。**结论：self-handle 改群昵称是决定性修复（单独即 2/2 翻转）；历史名解析单独无效。**

修改后模型的 stay_silent 理由（原话）：“消息是在指派 @实事求是，并讨论 @FuFu🐑，未提到我”。

## 4. 修复方案

### 4.1 主修复（必须、决定性）

`crabot-channel-wechat/src/wechat-channel.ts:334`：self-handle 取值改用同函数上方已解析好的群昵称 `crabDisplayName`（来自 `getCrabGroupNick`，约 line 299），取不到时回退 wxid：

```js
// 当前
...(event.puppet?.wxid ? { crab_self_handle: `@${event.puppet.wxid}` } : {}),

// 改为
const selfHandle = crabDisplayName
  ? `@${crabDisplayName}`
  : (event.puppet?.wxid ? `@${event.puppet.wxid}` : undefined)
...(selfHandle ? { crab_self_handle: selfHandle } : {}),
```

- `crabDisplayName` 仅群聊解析（私聊为 undefined）——私聊本就两方对话、无需区分 @，自动回退 wxid 或省略即可。
- 效果：棉花糖 self=`@棉花糖🐶` → `@实事求是`/`@FuFu🐑` 都 ≠ 自己 → stay_silent（正确）；实事求是 self=`@实事求是` → 认出自己的 @ → 动手（正确）。**同一处修复同时治好正反两侧。**

### 4.2 次要修复（建议，非本案决定性）

1. **历史发送者名解析**：`connectorMsgToProtocolItem`（`wechat-channel.ts`）当前 `platform_display_name = content.group_sender`（原始 wxid）。应复用 live 入站路径（connector 端 `buildAndEmitRawEvent` 用 group 成员 `chatroom_nick`）那套解析，让历史发送者也呈现昵称。提升多 bot 群历史可读性（实测对本案无影响，但属真实缺陷）。
2. **`_self` 身份识别**：`connectorMsgToProtocolItem` 用 `_self` 标识 bot 自己的历史消息，而 `resolveSenderIdentity`（`crabot-agent/src/utils/sender-identity.ts`）判的是 `self`/`assistant`（少个下划线）→ bot 自己的历史消息被标 `identity="stranger"`，认不出自己的发言。建议对齐标识。
3. **（上游 wechat-connector）引用消息发送者解析**：`enrichQuoteMessageContent` 只查 contact 表 + refermsg `<displayname>`，不查 group 成员名册，导致引用前缀泄漏原始 wxid（如 `> assfox:` 本应是 `> gaozhi:`）。

## 5. 不采纳的方案

- **不**把 `is_mention_crab` 升级为硬 gate（“没 @ 就强制沉默”）：会误伤合法的“master 不重新 @、直接追加指令”等无 @ 场景；且不解决“认不出自己”的根因——实测中“只改历史名仍 new_task”恰恰说明问题在**身份识别**而非 mention 信号。

## 6. 影响面 / 风险 / 回归

- 主修复仅改 1 处取值；行为变化：dispatcher 身份段锚点从 wxid 变群昵称。
- 风险：群昵称可能含特殊字符或群内重复昵称——但相比“wxid 永不匹配”是**严格改善**；昵称匹配失败时退化为当前行为（wxid），不会更差。
- 需回归：群聊 `@bot` 应触发响应、`@他人` 不应触发；私聊不受影响；多 bot 同群时各自只认自己的昵称。
