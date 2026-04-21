# Friend Result-First Permission Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace non-master friend template selection with a result-first friend permission editor that matches group permission editing and becomes the unified private-session permission surface.

**Architecture:** Add a dedicated friend-permission config/read model in Admin instead of overloading `Friend.permission_template_id`. Expose explicit + resolved friend permissions through new APIs, teach Agent to resolve private-session permissions from friend configs first, then refactor Dialog Objects friend workbench to render and save direct effective values with the same UI model used by groups.

**Tech Stack:** TypeScript, Node.js Admin backend, React + Vite frontend, Vitest backend/frontend tests.

**Spec:** `docs/superpowers/specs/2026-04-21-friend-result-first-permission-editor-design.md`

---

## File Map

### Admin Backend (`crabot-admin/src/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `types.ts` | Modify | Add friend permission config/read types and API contracts |
| `index.ts` | Modify | Persist friend permission configs, expose friend permission APIs, resolve friend permissions from explicit config or template |
| `dialog-objects.ts` | Modify | Include friend permission summary fields in dialog-object friend rows if needed by the UI |
| `admin-web-api.test.ts` | Modify | Cover friend permission read/write/result resolution |

### Agent Runtime (`crabot-agent/src/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `types.ts` | Modify | Add friend permission config/read shapes if reused across calls |
| `unified-agent.ts` | Modify | Resolve private-session permissions from friend explicit config before template fallback |

### Frontend Services (`crabot-admin/web/src/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `services/friend.ts` | Modify | Add friend permission read/write methods |
| `services/friend.test.ts` | Create | Cover new friend permission request paths |
| `pages/DialogObjects/friend-permission-utils.ts` | Create | Shared friend permission summary/parse/build helpers |
| `pages/DialogObjects/friend-permission-utils.test.ts` | Create | Cover helper behavior and fallback semantics |

### Dialog Objects Friend UI (`crabot-admin/web/src/pages/DialogObjects/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `components/FriendWorkbench.tsx` | Modify | Replace template selector with result-first permission editor for non-master friends |
| `DialogObjectsPage.test.tsx` | Modify | Cover friend permission loading, rendering, and save behavior |
| `index.tsx` | Modify | Load/save friend permissions and wire workbench editor state |
| `components/DialogObjectsComponents.test.tsx` | Modify | Adjust friend workbench expectations for the new editor |
| `App.css` | Modify | Reuse/result-first permission editor styles in friend workbench |

---

## Task 1: Add Admin Friend Permission Config Model And APIs

**Files:**
- Modify: `crabot-admin/src/types.ts`
- Modify: `crabot-admin/src/index.ts`

- [ ] **Step 1: Add friend permission config/read types**

In `crabot-admin/src/types.ts`, add dedicated friend permission types near `SessionPermissionConfig`:

```ts
export interface FriendPermissionConfig {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  updated_at: string
}

export interface GetFriendPermissionResult {
  config: FriendPermissionConfig | null
  resolved: ResolvedPermissions | null
}
```

Also add the request body shape for explicit saves if the file already keeps API request contracts together:

```ts
export interface UpdateFriendPermissionBody {
  config: Omit<FriendPermissionConfig, 'updated_at'>
}
```

- [ ] **Step 2: Persist friend permission configs in AdminModule**

In `crabot-admin/src/index.ts`, add a new in-memory store and load/save it alongside `sessionConfigs`:

```ts
private friendPermissionConfigs = new Map<FriendId, FriendPermissionConfig>()
```

Use the same persistence pattern already used for `sessionConfigs`:

```ts
const friendPermissionConfigsFile = path.join(this.config.data_dir, 'friend-permission-configs.json')
```

Add:

- load on startup
- save after writes
- empty-store logging consistent with `sessionConfigs`

- [ ] **Step 3: Add helper methods to resolve friend permissions**

In `crabot-admin/src/index.ts`, add focused helpers above the REST handlers:

```ts
private resolveFriendTemplateId(friend: Friend): string | null {
  if (friend.permission === 'master') return 'master_private'
  return friend.permission_template_id ?? null
}

private buildResolvedFriendPermissions(friend: Friend): ResolvedPermissions | null {
  const explicitConfig = this.friendPermissionConfigs.get(friend.id) ?? null
  if (explicitConfig) {
    return {
      tool_access: { ...explicitConfig.tool_access },
      storage: explicitConfig.storage,
      memory_scopes: [...explicitConfig.memory_scopes],
    }
  }

  const templateId = this.resolveFriendTemplateId(friend)
  if (!templateId) return null
  return this.permissionTemplateManager.resolvePermissions(templateId, null)
}
```

This helper should preserve master `memory_scopes: []` if the template resolves to empty.

- [ ] **Step 4: Add friend permission read/write handlers**

In `crabot-admin/src/index.ts`, add:

```ts
private async handleGetFriendPermission(friendId: FriendId): Promise<GetFriendPermissionResult> {
  const friend = this.friends.get(friendId)
  if (!friend) throw new AdminApiError(404, 'FRIEND_NOT_FOUND', 'Friend not found')

  const config = this.friendPermissionConfigs.get(friendId) ?? null
  const resolved = this.buildResolvedFriendPermissions(friend)
  return { config, resolved }
}

private async handleUpdateFriendPermission(friendId: FriendId, config: Omit<FriendPermissionConfig, 'updated_at'>): Promise<{ config: FriendPermissionConfig }> {
  const friend = this.friends.get(friendId)
  if (!friend) throw new AdminApiError(404, 'FRIEND_NOT_FOUND', 'Friend not found')

  const nextConfig: FriendPermissionConfig = {
    tool_access: { ...config.tool_access },
    storage: config.storage,
    memory_scopes: [...config.memory_scopes],
    updated_at: generateTimestamp(),
  }

  this.friendPermissionConfigs.set(friendId, nextConfig)
  await this.saveFriendPermissionConfigs()
  return { config: nextConfig }
}
```

Do not add delete/reset endpoints in this feature; the spec intentionally does not expose a return-to-template action.

- [ ] **Step 5: Expose REST endpoints**

Add REST routes in `crabot-admin/src/index.ts`:

```ts
if (pathname.match(/^\/api\/friends\/[^/]+\/permissions$/) && req.method === 'GET') {
  const friendId = pathname.split('/')[3] as FriendId
  await this.handleGetFriendPermissionApi(res, friendId)
  return
}

if (pathname.match(/^\/api\/friends\/[^/]+\/permissions$/) && req.method === 'PUT') {
  const friendId = pathname.split('/')[3] as FriendId
  await this.handleUpdateFriendPermissionApi(req, res, friendId)
  return
}
```

Use JSON responses shaped like:

```ts
res.end(JSON.stringify({ config, resolved }))
```

and

```ts
res.end(JSON.stringify({ config: result.config }))
```

- [ ] **Step 6: Run the backend API test file**

Run: `cd crabot-admin && npm test -- src/admin-web-api.test.ts --run`

Expected: FAIL, because no tests target the new friend permission endpoints yet.

- [ ] **Step 7: Commit**

```bash
git add crabot-admin/src/types.ts crabot-admin/src/index.ts
git commit -m "feat(admin): add friend permission config APIs"
```

---

## Task 2: Cover Friend Permission APIs With Backend Tests

**Files:**
- Modify: `crabot-admin/src/admin-web-api.test.ts`

- [ ] **Step 1: Add helpers for friend permission reads and writes**

Near the other web-request helpers, add:

```ts
async function getFriendPermissions(token: string, friendId: string) {
  return makeWebRequest<{
    config: {
      tool_access: Record<string, boolean>
      storage: { workspace_path: string; access: 'read' | 'readwrite' } | null
      memory_scopes: string[]
      updated_at: string
    } | null
    resolved: {
      tool_access: Record<string, boolean>
      storage: { workspace_path: string; access: 'read' | 'readwrite' } | null
      memory_scopes: string[]
    } | null
  }>(TEST_WEB_PORT, `/api/friends/${friendId}/permissions`, 'GET', null, token)
}

async function putFriendPermissions(token: string, friendId: string, config: {
  tool_access: Record<string, boolean>
  storage: { workspace_path: string; access: 'read' | 'readwrite' } | null
  memory_scopes: string[]
}) {
  return makeWebRequest<{ config: { updated_at: string } }>(
    TEST_WEB_PORT,
    `/api/friends/${friendId}/permissions`,
    'PUT',
    { config },
    token,
  )
}
```

- [ ] **Step 2: Add a resolved-read test for untouched normal friends**

Add:

```ts
it('returns resolved friend permissions from the bound template when no explicit config exists', async () => {
  const token = await loginAndGetToken()

  const createResponse = await makeWebRequest<{ friend: Friend }>(
    TEST_WEB_PORT,
    '/api/friends',
    'POST',
    { display_name: 'Session User', permission: 'normal', permission_template_id: 'standard' },
    token,
  )

  const response = await getFriendPermissions(token, createResponse.body.friend.id)

  expect(response.statusCode).toBe(200)
  expect(response.body.config).toBeNull()
  expect(response.body.resolved?.tool_access.memory).toBe(true)
  expect(response.body.resolved?.tool_access.file_io).toBe(false)
  expect(response.body.resolved?.memory_scopes).toEqual([])
})
```

- [ ] **Step 3: Add an explicit-save test**

Add:

```ts
it('returns explicit friend permissions after saving a full config', async () => {
  const token = await loginAndGetToken()

  const createResponse = await makeWebRequest<{ friend: Friend }>(
    TEST_WEB_PORT,
    '/api/friends',
    'POST',
    { display_name: 'Editable Friend', permission: 'normal', permission_template_id: 'standard' },
    token,
  )

  const explicitConfig = {
    tool_access: {
      memory: true,
      messaging: true,
      task: false,
      mcp_skill: false,
      file_io: true,
      browser: false,
      shell: false,
      remote_exec: false,
      desktop: false,
    },
    storage: { workspace_path: '/data/friend-1', access: 'read' as const },
    memory_scopes: ['friend:friend-1'],
  }

  const saveResponse = await putFriendPermissions(token, createResponse.body.friend.id, explicitConfig)
  expect(saveResponse.statusCode).toBe(200)

  const readResponse = await getFriendPermissions(token, createResponse.body.friend.id)
  expect(readResponse.statusCode).toBe(200)
  expect(readResponse.body.config?.tool_access.file_io).toBe(true)
  expect(readResponse.body.resolved).toEqual({
    ...explicitConfig,
  })
  expect(readResponse.body.config?.updated_at).toEqual(expect.any(String))
})
```

- [ ] **Step 4: Add a master friend read test**

Add:

```ts
it('keeps master friend resolved memory scopes empty', async () => {
  const token = await loginAndGetToken()

  const createResponse = await makeWebRequest<{ friend: Friend }>(
    TEST_WEB_PORT,
    '/api/friends',
    'POST',
    { display_name: 'Master Friend', permission: 'master' },
    token,
  )

  const response = await getFriendPermissions(token, createResponse.body.friend.id)

  expect(response.statusCode).toBe(200)
  expect(response.body.resolved?.storage).toEqual({ workspace_path: '/', access: 'readwrite' })
  expect(response.body.resolved?.memory_scopes).toEqual([])
})
```

- [ ] **Step 5: Run the backend API test file**

Run: `cd crabot-admin && npm test -- src/admin-web-api.test.ts --run`

Expected: PASS with the new friend permission cases.

- [ ] **Step 6: Commit**

```bash
git add crabot-admin/src/admin-web-api.test.ts
git commit -m "test(admin): cover friend permission config APIs"
```

---

## Task 3: Use Friend Explicit Permissions In Agent Private-Session Resolution

**Files:**
- Modify: `crabot-agent/src/types.ts`
- Modify: `crabot-agent/src/unified-agent.ts`

- [ ] **Step 1: Extend agent-side API shapes**

In `crabot-agent/src/types.ts`, add:

```ts
export interface FriendPermissionConfig {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  updated_at: string
}
```

Only add it if `unified-agent.ts` needs a named type; avoid duplicate inline object literals.

- [ ] **Step 2: Add a friend-permission fetch helper**

In `crabot-agent/src/unified-agent.ts`, add:

```ts
private async resolveFriendPermissions(friend: Friend): Promise<ResolvedPermissions | null> {
  try {
    const adminPort = await this.getAdminPort()
    const result = await this.rpcClient.call<
      { friend_id: string },
      {
        config: FriendPermissionConfig | null
        resolved: ResolvedPermissions | null
      }
    >(adminPort, 'get_friend_permissions', { friend_id: friend.id }, this.config.moduleId)

    return result.resolved
  } catch (err) {
    console.warn(`[Agent] Failed to resolve friend permissions for ${friend.id}:`, err)
    return null
  }
}
```

If the backend does not expose this RPC yet, add the RPC method in the same task on the Admin side instead of falling back to REST from Agent.

- [ ] **Step 3: Replace template-first private resolution**

Update the private-session path in `crabot-agent/src/unified-agent.ts`:

```ts
private async resolveSessionPermissions(friend: Friend, sessionId: string): Promise<ResolvedPermissions | null> {
  const explicitFriendPerms = await this.resolveFriendPermissions(friend)
  if (explicitFriendPerms) return explicitFriendPerms

  const templateId = friend.permission === 'master'
    ? 'master_private'
    : friend.permission_template_id

  if (!templateId) return null
  return this.resolvePermissionsForTemplate(templateId, sessionId)
}
```

This preserves current behavior for untouched friends while switching edited friends to explicit configs.

- [ ] **Step 4: Run the agent build/test command that covers compilation**

Run the smallest available validation command used on this branch for Agent changes, for example:

```bash
cd crabot-agent
npm test -- --run
```

If that suite is too broad, use the narrowest command that still compiles `unified-agent.ts`.

Expected: PASS, or a narrower passing command if the suite is known to be broader than this feature.

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/types.ts crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): resolve private permissions from friend configs"
```

---

## Task 4: Add Frontend Friend Permission Services And Helpers

**Files:**
- Modify: `crabot-admin/web/src/services/friend.ts`
- Create: `crabot-admin/web/src/services/friend.test.ts`
- Create: `crabot-admin/web/src/pages/DialogObjects/friend-permission-utils.ts`
- Create: `crabot-admin/web/src/pages/DialogObjects/friend-permission-utils.test.ts`

- [ ] **Step 1: Add service types and methods**

In `crabot-admin/web/src/services/friend.ts`, add:

```ts
export interface FriendPermissionConfig {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  updated_at: string
}

export interface FriendPermissionResponse {
  config: FriendPermissionConfig | null
  resolved: {
    tool_access: ToolAccessConfig
    storage: StoragePermission | null
    memory_scopes: string[]
  } | null
}
```

and methods:

```ts
async getPermissions(friendId: string): Promise<FriendPermissionResponse> {
  return api.get(`/friends/${encodeURIComponent(friendId)}/permissions`)
},

async updatePermissions(friendId: string, config: Omit<FriendPermissionConfig, 'updated_at'>): Promise<{ config: FriendPermissionConfig }> {
  return api.put(`/friends/${encodeURIComponent(friendId)}/permissions`, { config })
},
```

- [ ] **Step 2: Add friend permission helper utilities**

Create `crabot-admin/web/src/pages/DialogObjects/friend-permission-utils.ts`:

```ts
import type { StoragePermission, ToolAccessConfig } from '../../types'

export function getStorageSummary(storage: StoragePermission | null): string {
  if (!storage) return '未开启'
  return `${storage.workspace_path} · ${storage.access === 'read' ? '只读' : '读写'}`
}

export function getMemoryScopeSummary(scopes: string[]): string {
  if (scopes.length === 0) return '未设置范围'
  return scopes.join(', ')
}

export function parseMemoryScopes(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(scope => scope.trim())
    .filter(Boolean)
}

export function buildExplicitFriendPermissionConfig(input: {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
}) {
  return {
    tool_access: input.tool_access,
    storage: input.storage,
    memory_scopes: input.memory_scopes,
  }
}
```

- [ ] **Step 3: Add helper tests**

Create `crabot-admin/web/src/pages/DialogObjects/friend-permission-utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildExplicitFriendPermissionConfig,
  getMemoryScopeSummary,
  getStorageSummary,
  parseMemoryScopes,
} from './friend-permission-utils'

describe('friend permission utils', () => {
  it('summarizes storage and memory scopes for result-first editing', () => {
    expect(getStorageSummary(null)).toBe('未开启')
    expect(getMemoryScopeSummary([])).toBe('未设置范围')
  })

  it('parses comma and newline separated scope input', () => {
    expect(parseMemoryScopes('alpha, beta\ngamma')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('builds a full explicit friend permission config', () => {
    expect(buildExplicitFriendPermissionConfig({
      tool_access: {
        memory: true,
        messaging: true,
        task: false,
        mcp_skill: false,
        file_io: false,
        browser: false,
        shell: false,
        remote_exec: false,
        desktop: false,
      },
      storage: null,
      memory_scopes: ['friend:friend-1'],
    })).toEqual({
      tool_access: expect.any(Object),
      storage: null,
      memory_scopes: ['friend:friend-1'],
    })
  })
})
```

- [ ] **Step 4: Add service tests**

Create `crabot-admin/web/src/services/friend.test.ts` by following the existing service-test pattern on this branch:

```ts
import { describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { friendService } from './friend'

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}))

describe('friendService permissions', () => {
  it('requests friend permissions from the dedicated endpoint', async () => {
    vi.mocked(api.get).mockResolvedValue({ config: null, resolved: null })

    await friendService.getPermissions('friend-1')

    expect(api.get).toHaveBeenCalledWith('/friends/friend-1/permissions')
  })

  it('writes explicit friend permissions to the dedicated endpoint', async () => {
    vi.mocked(api.put).mockResolvedValue({ config: { updated_at: '2026-04-21T00:00:00.000Z' } })

    await friendService.updatePermissions('friend-1', {
      tool_access: {
        memory: true,
        messaging: true,
        task: false,
        mcp_skill: false,
        file_io: false,
        browser: false,
        shell: false,
        remote_exec: false,
        desktop: false,
      },
      storage: null,
      memory_scopes: ['friend:friend-1'],
    })

    expect(api.put).toHaveBeenCalledWith('/friends/friend-1/permissions', {
      config: expect.objectContaining({
        memory_scopes: ['friend:friend-1'],
      }),
    })
  })
})
```

- [ ] **Step 5: Run the frontend helper/service tests**

Run:

```bash
cd crabot-admin/web
npm test -- --run src/pages/DialogObjects/friend-permission-utils.test.ts src/services/friend.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crabot-admin/web/src/services/friend.ts crabot-admin/web/src/services/friend.test.ts crabot-admin/web/src/pages/DialogObjects/friend-permission-utils.ts crabot-admin/web/src/pages/DialogObjects/friend-permission-utils.test.ts
git commit -m "test(web): add friend permission service helpers"
```

---

## Task 5: Replace Friend Template Selection With Result-First Permission Editing

**Files:**
- Modify: `crabot-admin/web/src/pages/DialogObjects/components/FriendWorkbench.tsx`
- Modify: `crabot-admin/web/src/pages/DialogObjects/index.tsx`
- Modify: `crabot-admin/web/src/pages/DialogObjects/DialogObjectsPage.test.tsx`
- Modify: `crabot-admin/web/src/pages/DialogObjects/components/DialogObjectsComponents.test.tsx`
- Modify: `crabot-admin/web/src/App.css`

- [ ] **Step 1: Update page tests first**

In `crabot-admin/web/src/pages/DialogObjects/DialogObjectsPage.test.tsx`, replace the friend template expectations with result-first ones:

```ts
it('opens friend result-first permissions instead of a template selector', async () => {
  render(<DialogObjectsPage />)

  expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()
  expect(screen.queryByLabelText('权限模板')).not.toBeInTheDocument()
  expect(screen.getByLabelText('记忆读写')).toBeChecked()
  expect(screen.getByLabelText('启用存储')).toBeChecked()
  expect(screen.getByLabelText('范围标识')).toHaveValue('friend:friend-1')
})
```

Add a save-path test:

```ts
it('saves explicit friend permissions from the workbench', async () => {
  render(<DialogObjectsPage />)

  expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

  fireEvent.click(screen.getByLabelText('消息操作'))
  fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: '/data/friend-1' } })
  fireEvent.click(screen.getByLabelText('自定义范围'))
  fireEvent.change(screen.getByLabelText('范围标识'), { target: { value: 'friend:friend-1, friend:shared' } })
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

  await waitFor(() => {
    expect(updateFriendPermissions).toHaveBeenCalledWith('friend-1', {
      tool_access: expect.objectContaining({
        messaging: false,
      }),
      storage: {
        workspace_path: '/data/friend-1',
        access: 'read',
      },
      memory_scopes: ['friend:friend-1', 'friend:shared'],
    })
  })
})
```

- [ ] **Step 2: Extend page state and data loading**

In `crabot-admin/web/src/pages/DialogObjects/index.tsx`, replace the `editTemplateId`-only friend permission path with explicit friend permission state:

```ts
const [friendPermissionLoading, setFriendPermissionLoading] = useState(false)
const [friendToolAccess, setFriendToolAccess] = useState<ToolAccessConfig>(() => buildToolAccess(false))
const [friendStorageEnabled, setFriendStorageEnabled] = useState(false)
const [friendStoragePath, setFriendStoragePath] = useState('')
const [friendStorageAccess, setFriendStorageAccess] = useState<'read' | 'readwrite'>('read')
const [friendMemoryMode, setFriendMemoryMode] = useState<'empty' | 'custom'>('empty')
const [friendMemoryScopesInput, setFriendMemoryScopesInput] = useState('')
```

Load friend permissions when the selected friend changes:

```ts
useEffect(() => {
  if (domain !== 'friends' || !selectedItem) return
  const friend = selectedItem as DialogObjectFriend
  if (friend.permission === 'master') return

  setFriendPermissionLoading(true)
  void friendService.getPermissions(friend.id)
    .then((result) => {
      const resolved = result.resolved
      if (!resolved) return
      setFriendToolAccess(resolved.tool_access)
      setFriendStorageEnabled(resolved.storage !== null)
      setFriendStoragePath(resolved.storage?.workspace_path ?? DEFAULT_STORAGE_PATH)
      setFriendStorageAccess(resolved.storage?.access ?? 'read')
      setFriendMemoryMode(resolved.memory_scopes.length === 0 ? 'empty' : 'custom')
      setFriendMemoryScopesInput(resolved.memory_scopes.join(', '))
    })
    .catch((err) => notifyError(err instanceof Error ? err.message : '加载好友权限失败'))
    .finally(() => setFriendPermissionLoading(false))
}, [domain, selectedItem, notifyError])
```

- [ ] **Step 3: Replace friend template UI in `FriendWorkbench`**

In `crabot-admin/web/src/pages/DialogObjects/components/FriendWorkbench.tsx`, remove the non-master template selector and render the same result-first sections used by groups:

```tsx
{editPerm === 'normal' && (
  <div style={{ display: 'grid', gap: '1rem' }}>
    <div className="session-modal-section">
      <div style={{ fontWeight: 600 }}>好友权限</div>
      <div className="session-permission-switch-list">
        {TOOL_CATEGORIES.map((category) => (
          <PermissionSwitchRow
            key={category}
            label={TOOL_CATEGORY_LABELS[category]}
            category={category}
            checked={friendToolAccess[category]}
            onChange={onFriendToolAccessChange}
          />
        ))}
      </div>
    </div>

    <div className="session-modal-section">
      <div style={{ fontWeight: 600 }}>存储权限</div>
      ...
    </div>

    <div className="session-modal-section">
      <div style={{ fontWeight: 600 }}>记忆范围</div>
      ...
    </div>
  </div>
)}
```

Keep masters locked: they may still show read-only resolved values, but do not expose editable controls if that is the established rule on this branch.

- [ ] **Step 4: Update save handling**

In `crabot-admin/web/src/pages/DialogObjects/index.tsx`, split friend metadata save from friend permission save:

```ts
const handleSaveFriendPermissions = async () => {
  if (domain !== 'friends' || !selectedItem) return
  const friend = selectedItem as DialogObjectFriend
  if (friend.permission === 'master') return

  const memoryScopes = friendMemoryMode === 'empty'
    ? []
    : parseMemoryScopes(friendMemoryScopesInput)

  await friendService.updatePermissions(friend.id, buildExplicitFriendPermissionConfig({
    tool_access: friendToolAccess,
    storage: friendStorageEnabled
      ? { workspace_path: friendStoragePath.trim(), access: friendStorageAccess }
      : null,
    memory_scopes: memoryScopes,
  }))
}
```

If the current `保存修改` button already commits friend metadata, either:

- expand it to save both metadata + permissions in sequence, or
- split the buttons into `保存基础信息` and `保存权限`

Pick one and make the tests explicit. Do not leave a mixed implicit behavior.

- [ ] **Step 5: Adjust component tests**

Update `crabot-admin/web/src/pages/DialogObjects/components/DialogObjectsComponents.test.tsx` so the friend workbench smoke test asserts:

```ts
expect(screen.getByLabelText('记忆读写')).toBeInTheDocument()
expect(screen.queryByLabelText('权限模板')).not.toBeInTheDocument()
```

- [ ] **Step 6: Run the Dialog Objects frontend tests**

Run:

```bash
cd crabot-admin/web
npm test -- --run src/pages/DialogObjects/DialogObjectsPage.test.tsx src/pages/DialogObjects/components/DialogObjectsComponents.test.tsx src/pages/DialogObjects/friend-permission-utils.test.ts src/services/friend.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the web build**

Run:

```bash
cd crabot-admin/web
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add crabot-admin/web/src/pages/DialogObjects/components/FriendWorkbench.tsx crabot-admin/web/src/pages/DialogObjects/index.tsx crabot-admin/web/src/pages/DialogObjects/DialogObjectsPage.test.tsx crabot-admin/web/src/pages/DialogObjects/components/DialogObjectsComponents.test.tsx crabot-admin/web/src/App.css
git commit -m "feat(web): make friend permission editor result-first"
```

---

## Task 6: Final Verification

**Files:**
- Modify: no code changes expected

- [ ] **Step 1: Run backend verification**

Run:

```bash
cd crabot-admin
npm test -- src/admin-web-api.test.ts --run
```

Expected: PASS including the new friend permission API cases.

- [ ] **Step 2: Run targeted frontend verification**

Run:

```bash
cd crabot-admin/web
npm test -- --run src/pages/DialogObjects/DialogObjectsPage.test.tsx src/pages/DialogObjects/components/DialogObjectsComponents.test.tsx src/pages/DialogObjects/friend-permission-utils.test.ts src/services/friend.test.ts
npm run build
```

Expected:

- all targeted friend/dialog-object tests pass
- web build passes

- [ ] **Step 3: Manual verification**

Check these cases in the browser:

```text
1. Open a normal friend: there is no 权限模板 selector, and direct permission controls are visible.
2. Open a master friend: the old template-selector path is still absent and master behavior remains locked/consistent.
3. Open a group: its result-first permission editor still behaves the same after the friend refactor.
4. Open private pool: no permission editor is shown.
5. Edit and save a normal friend, reload the page, and confirm the same effective values are shown.
```

- [ ] **Step 4: Commit any verification-only fixes**

```bash
git add crabot-admin/src/admin-web-api.test.ts crabot-admin/web/src/pages/DialogObjects/DialogObjectsPage.test.tsx crabot-admin/web/src/pages/DialogObjects/components/DialogObjectsComponents.test.tsx
git commit -m "test(web): verify friend result-first permission editing"
```

---

## Self-Review

### Spec Coverage

- Friend and group permission editing use the same result-first model: covered by Tasks 4-5.
- Private pool remains permissionless: covered by Task 5 and manual verification in Task 6.
- Friend permissions become their own direct read/write model: covered by Tasks 1-2.
- Agent private-session resolution uses friend explicit permissions: covered by Task 3.
- Template selection exits the friend UI main path: covered by Task 5.

### Placeholder Scan

Checked for `TODO`, `TBD`, vague “handle later”, or “similar to” instructions. None remain.

### Type Consistency

- Backend uses `FriendPermissionConfig` / `GetFriendPermissionResult` consistently.
- Frontend uses `FriendPermissionResponse` and explicit friend permission helpers consistently.
- Save paths always submit full `tool_access`, `storage`, and `memory_scopes`.
