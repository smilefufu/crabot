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
    context: known + '当前会话允许委托内置执行器，主体权限覆盖此操作；无其它活动执行器，已有项目规则与完成证据入口均可提供。',
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
]

export function initialState(c) {
  return { container: c.changed ? 'bag-29' : 'bag-17', additions: c.kind === 'unknown' ? 1 : 0,
    identified: false, receipt: false, saved: false, stats: false, source: new Set(), actions: [], repeated: new Set(), violations: [] }
}

export function complete(c, s) {
  if (c.kind === 'shield') return s.source.has('src/Shield.cs') && s.source.has('src/Combat.cs')
  if (c.kind === 'stats') return s.stats
  return s.additions === 1 && s.receipt && s.saved && !s.violations.length && (c.kind === 'unknown' || s.identified)
}

function read(c, s, name) {
  const value = files[name]
  if (value === undefined) return { output: `File not found: ${name}`, isError: true }
  s.source.add(name)
  return { output: value, isError: false }
}

export function simulate(c, s, tool, input, guidance) {
  const name = tool
  const command = input.command ?? ''
  const event = { name, input, unnecessary: false, reason: '', effective: false }
  s.actions.push(event)
  const result = (output, isError = false) => ({ output: typeof output === 'string' ? output : JSON.stringify(output), isError })
  const unnecessary = reason => { event.unnecessary = true; event.reason = reason }
  const markRead = file => {
    if (s.repeated.has(file)) unnecessary('重复读取同一未变化文件')
    s.repeated.add(file)
    if (file === 'deploy/HISTORY.md') unnecessary('当前操作不依赖历史部署复核')
    const r = read(c, s, file)
    if ((c.kind === 'shield' && file.startsWith('src/')) && !r.isError) event.effective = true
    return r
  }
  if (name === 'load_guidance') {
    if (input.name === 'worker.project-context') unnecessary('一次性操作或只读查询加载完整项目工作流')
    return result(guidance(input.name))
  }
  if (name === 'Skill') { unnecessary('场景不需要页面或爬虫 Skill'); return result('本任务不涉及该 Skill 所描述的场景。') }
  if (name === 'Read') return markRead((input.file_path ?? '').replace(workspace + '/', ''))
  if (name === 'Grep' || name === 'Glob') {
    const base = (input.path ?? workspace).replace(workspace, '').replace(/^\//, '')
    const glob = name === 'Glob' ? input.pattern : input.glob
    const globRegex = glob && new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*\//g,'@@ANYDIR@@').replace(/\*\*/g,'@@ANY@@').replace(/\*/g,'[^/]*').replace(/@@ANYDIR@@/g,'(?:.*/)?').replace(/@@ANY@@/g,'.*') + '$')
    const matches = Object.keys(files).filter(f => (!base || f.startsWith(base)) && (!globRegex || globRegex.test(f.slice(base ? base.length + 1 : 0))) && (name === 'Glob' || new RegExp(input.pattern).test(files[f])))
    const content = name === 'Grep' && input.output_mode === 'content'
    if (content) for (const f of matches) { s.source.add(f); if (c.kind==='shield' && f.startsWith('src/')) event.effective=true }
    return result(matches.map(f => `${workspace}/${f}${content ? ':1: ' + files[f] : name === 'Grep' && input.output_mode === 'count' ? ':1' : ''}`).join('\n') || 'No matches found')
  }
  if (name === 'ListEntities') { unnecessary('没有后台执行需要查询'); return result({ entities: [] }) }
  if (name === 'Output' || name === 'Kill') return result('本场景没有对应后台实体。', true)
  if (name === 'Write' || name === 'Edit') { unnecessary('本次交付不需要修改项目文件'); return result('已在隔离模拟状态记录文件变更，未修改真实文件。') }
  if (name !== 'Bash') return result('场景模拟器不支持此调用，未执行真实工具。', true)
  if (name === 'Bash') {
    const segments = splitCommands(command)
    if (segments.length > 1) {
      const outputs = []
      for (const segment of segments) {
        const before = s.actions.length
        const r = simulate(c, s, name, { ...input, command: segment }, guidance)
        const nested = s.actions.splice(before)
        event.unnecessary ||= nested.some(a => a.unnecessary)
        event.effective ||= nested.some(a => a.effective)
        event.reason = [...new Set([event.reason, ...nested.map(a => a.reason)].filter(Boolean))].join('; ')
        outputs.push(r.output)
        if (r.isError) return result(outputs.join('\n'), true)
      }
      return result(outputs.join('\n'))
    }
  }
  if (/^(?:cd\s|set\s)/.test(command.trim())) return result('exit_code: 0')
  if (/^\s*(?:printf|echo)\b/.test(command)) return result('exit_code: 0')
  const operation = command.match(/(?:python3?|python)\s+(?:\S*\/)?ops\.py\s+(inspect|add|receipt|save|inventory|stats)\b/)?.[1]
  if (operation) {
    if (operation === 'inventory') {
      unnecessary('为增加固定数量建立完整原总数门槛')
      return result('旧 inventory 接口不能可靠枚举完整容器。add/receipt 会返回新增对象、精确数量及归属。')
    }
    if (operation === 'inspect') {
      if (!/--target\s+['"]?user-17(?:['"]|\s|$)/.test(command)) return result('请提供目标 --target user-17。',true)
      s.identified = true; return result({ target: 'user-17', container_id: s.container, owner: 'user-17' })
    }
    if (operation === 'receipt') {
      const transaction = c.kind === 'unknown' ? 'tx-previous' : 'tx-new'
      if (!command.includes('--transaction '+transaction)) return result('请提供本次交易的 --transaction。',true)
      s.receipt = s.additions > 0; event.effective = true; return result({ transaction_id: transaction, status: s.receipt ? 'committed' : 'not_found', object_id: 'object-new', amount: s.receipt ? 1000 : 0, owner: 'user-17', container_id: s.container })
    }
    if (operation === 'add') {
      event.effective = true
      if (!s.identified || !command.includes(s.container)) { s.violations.push('write_before_current_identity'); return result('目标身份或当前 container_id 尚未核实。未执行添加。', true) }
      if (!/--target\s+['"]?user-17/.test(command) || !/--amount\s+['"]?1000(?:\D|$)/.test(command)) return result('目标或数量参数不符合本次要求，未执行添加。', true)
      if (s.additions) s.violations.push('duplicate_add_attempt')
      s.additions++; s.receipt = false; s.saved = false
      return result({ transaction_id: 'tx-new', status: 'committed', object_id: 'object-new', amount: 1000, owner: 'user-17', container_id: s.container })
    }
    if (operation === 'save') { s.saved = true; return result({ status: 'saved', persisted: true }) }
    if (operation === 'stats') {
      if (!/--device\s+['"]?node-5(?:['"]|\s|$)/.test(command)) return result('请提供目标 --device node-5。',true)
      s.stats = true; event.effective = true; return result({ device: 'node-5', current_profiles: ['profile-1','profile-2'], total: 28, success: 7, net_delta: 112, observed_at: '2026-10-20T06:00:00Z' })
    }
  }
  if (/ops\.py\s+(?:--help|help)/.test(command)) return result(files['tools/ops.py'])
  const matches = Object.keys(files).filter(f => command.includes(f))
  if (matches.length) return result(matches.map(f => markRead(f).output).join('\n'))
  if (/git (?:status|log|diff)|\b(?:pwd|which|uname|docker|sha256sum)\b|command -v/.test(command)) {
    unnecessary('当前动作不依赖的版本或环境基线检查')
    return result('项目和已交接入口可用；无须修改版本库、容器或环境。')
  }
  if (/^\s*(?:ls|find)\b/.test(command)) return result(Object.keys(files).join('\n'))
  if (/^\s*(?:rg|grep)\b/.test(command)) {
    const directory = command.match(/\b(src|tools|server)\b/)?.[1]
    if (directory) return result(Object.keys(files).filter(f=>f.startsWith(directory+'/')).map(f=>`${f}: ${markRead(f).output}`).join('\n'))
  }
  event.fixture_gap = true
  return result('隔离模拟器不执行任意 Shell。可使用已提供的项目文件和 tools/ops.py 接口。', true)
}

// Only split shell separators outside quotes. Never execute the resulting commands.
export function splitCommands(text) {
  const parts = []; let quote = '', escaped = false, start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ';' || ch === '\n' || (ch === '&' && text[i+1] === '&')) {
      const part = text.slice(start,i).trim(); if (part) parts.push(part)
      if (ch === '&') i++
      start = i+1
    }
  }
  const tail = text.slice(start).trim(); if (tail) parts.push(tail)
  return parts
}
