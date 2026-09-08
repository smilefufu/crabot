const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { boundedWorkerTools, runProjectTest } = require('./behavior.cjs')

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-eval-boundary-')))
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  const outside = path.join(root, 'outside.txt')
  await fs.writeFile(outside, 'fixture sentinel')
  try {
    const tools = boundedWorkerTools(project, { name: 'fixture-skill', skill_dir: root })
    assert(!tools.some((tool) => tool.name === 'Bash'))
    for (const name of ['Read', 'Write', 'Edit']) {
      const tool = tools.find((item) => item.name === name)
      assert((await tool.call({ file_path: outside, content: 'changed', old_string: 'fixture', new_string: 'changed' }, {})).isError)
      await fs.symlink(outside, path.join(project, 'AGENTS.md'))
      assert((await tool.call({ file_path: 'AGENTS.md', content: 'changed' }, {})).isError)
      await fs.unlink(path.join(project, 'AGENTS.md'))
    }
    const git = tools.find((tool) => tool.name === 'run_project_git')
    assert((await git.call({ operation: 'add', paths: ['../outside.txt'] }, {})).isError)
    assert((await git.call({ operation: 'push' }, {})).isError)
    const script = `const assert = require('node:assert/strict');
assert.throws(() => require('node:fs').readFileSync(${JSON.stringify(outside)}), {code:'ERR_ACCESS_DENIED'});
assert.throws(() => require('node:fs').writeFileSync('created.txt', 'no'), {code:'ERR_ACCESS_DENIED'});
assert.throws(() => require('node:child_process').execSync('pwd'), {code:'ERR_ACCESS_DENIED'});
const socket = require('node:net').connect({port:1, host:'127.0.0.1'});
socket.once('error', (error) => assert.equal(error.code, 'ERR_ACCESS_DENIED'));
socket.once('connect', () => assert.fail('network connection unexpectedly allowed'));
`
    await fs.writeFile(path.join(project, 'test.cjs'), script)
    await runProjectTest(project)
    assert.equal(await fs.readFile(outside, 'utf8'), 'fixture sentinel')
    console.log(JSON.stringify({ passed: true, blocked: ['outside_files', 'symlinks', 'arbitrary_git', 'test_file_writes', 'test_child_processes', 'test_network'] }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
