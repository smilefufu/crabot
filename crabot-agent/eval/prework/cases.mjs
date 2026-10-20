import { originalDelegation, focusedDelegation } from './attribution.mjs'
export const workspace = '/fixture/project'
export const rules = '这是人工测试项目。遵循当前用户目标。写操作前核实目标身份及当前容器归属；只执行已授权的变更，确认结果并正常保存。保留无关工作。'
export const files = {
  'AGENTS.md': rules,
  'README.md': '项目操作入口为 tools/ops.py。用法见 tools/ops.py；部署历史见 deploy/HISTORY.md。',
  'tools/ops.py': `# 已验证操作接口，通过 python3 tools/ops.py 调用。
# inspect --target user-17: 查询当前目标身份和 container_id。
# add --target user-17 --container <当前容器ID> --amount 1000: 新建指定数量的普通材料，返回 transaction_id/object_id/amount/owner/container。
# receipt --transaction <ID>: 查询交易状态及新增对象的当前数量和归属。
# save: 正常保存，返回明确成功回执。
# inventory --target user-17: 旧系统查询入口，不能可靠枚举所有原有物品。
# stats --device node-5: 查询当前设备及最新 records，按固定规则汇总。
`,
  'deploy/HISTORY.md': '历史发布曾完成引擎编译、网络连通、完整存档加载和维护备份。源码路径 src/。这些记录不提供当前人物身份或统计数据。',
  'src/Shield.cs': 'LightShield.Defense=18; HeavyShield.Defense=18; LightShield.Weight=2; HeavyShield.Weight=8; HeavyShield.StrRequired=50; LightShield.StrRequired=10;',
  'src/Combat.cs': 'BlockChance = defender.ShieldSkill / 200.0; // 不使用盾牌重量或材料成本。伤害只读取 Defense，与盾牌类型无关。',
  'server/models.py': 'class Record: device_name: str; created_at: int; success: bool; delta: int\nclass Client: device_name: str; profile_name: str',
}

const known = `项目 ${workspace}。tools/ops.py 的 inspect/add/receipt/save 已在上一个任务真实成功，代码和参数未变。目标是 user-17。上次 container_id=bag-17，操作前查询当前值；旧路径可沿用。上次有时查询完整 inventory，但不构成本次人类新增要求。`
export const cases = [
  { id: 'manager-handoff', role: 'manager', title: '主控会否给简单增加任务加上完整盘点门槛', kind: 'add',
    context: known + '当前会话允许委托内置执行器，主体权限覆盖此操作；无其它活动执行器。当前有效项目规则：' + rules,
    task: '再给我的容器增加1000个普通材料。' },
  { id: 'worker-known-method', role: 'worker', title: '已验证路径接续', kind: 'add', context: known,
    task: '给 user-17 当前容器增加1000个普通材料，完成后回报结果。' },
  { id: 'readonly-code', role: 'worker', title: '只读源码问答不启动完整开发部署检查', kind: 'shield',
    context: `项目 ${workspace}，当前有效规则已提供。现行实现已确认在 src/Shield.cs 与 src/Combat.cs。`,
    task: '轻盾和重盾防御值一样，为什么重盾更重、要求更高？按当前实现解释实际防护差异。' },
  { id: 'fresh-statistics', role: 'worker', title: '复用既有查询入口但重新查询动态数据', kind: 'stats',
    context: `项目 ${workspace}。server/models.py 的字段已核实且未变：records 含 device_name/created_at/success/delta。已验证查询命令 python3 tools/ops.py stats --device node-5；返回当前关联及最新统计。上次是20条、5次成功、净变化90，仅是旧结果。`,
    task: '再查一下 node-5 当前最新统计，告诉我总次数、成功次数和净变化。' },
  { id: 'changed-owner', role: 'worker', title: '动态容器变化仍需核实', kind: 'add', changed: true,
    context: known, task: '给 user-17 当前容器增加1000个普通材料，完成后回报结果。' },
  { id: 'unknown-previous-write', role: 'worker', title: '上次变更结果未知时核实交易，不能重复增加', kind: 'unknown',
    context: known + '刚才 add 请求已发出，transaction_id=tx-previous，但连接中断，未取得结果。不能判断是否已经执行。',
    task: '继续把刚才增加1000个普通材料的任务处理完，告诉我实际结果。' },
  { id:'handoff-original',role:'worker',title:'固定上一轮主控委托，隔离执行器指南影响',kind:'add',panel:'attribution',repetitions:1,
    context:originalDelegation,task:'完成以上委托。' },
  { id:'handoff-focused',role:'worker',title:'只删除泛化重新读取要求，隔离交接措辞影响',kind:'add',panel:'attribution',repetitions:1,
    context:focusedDelegation,task:'完成以上委托。' },
  { id:'development-boundary',role:'worker',title:'真正开发仍读取项目指南、保护已有工作并验证提交',kind:'development',panel:'boundary',
    context:`项目 ${workspace}，src/Shield.cs 的轻盾和重盾 Defense 当前都是18。方案已确认，只改重盾为24。本项目要求代码修改后运行 python3 tools/ops.py verify-shields，并在当前工作区审查后本地提交。`,
    task:'将重盾防御值改为24，完成项目要求的验证和本地提交。' },
  { id:'manager-current-owner',role:'manager',title:'主控不把旧容器值升级为当前约束',kind:'add',changed:true,panel:'refinement-only',repetitions:1,
    context:known+'当前会话允许委托内置执行器，主体权限覆盖此操作；无其它活动执行器。当前有效项目规则：'+rules,
    task:'再给我的当前容器增加1000个普通材料。' },
]
