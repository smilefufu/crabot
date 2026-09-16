// A closed synthetic fixture, never a shell interpreter or a filesystem reader.
export const initialFile = 'def add(a, b):\n    return a - b\n'
export const checkFile = 'from add import add\nassert add(2,3)==5\nassert add(-1,1)==0\nprint("PASS")\n'
export const errorLog = 'Read rejected before opening report.csv. Effective principal file_io=false. Authorization denial; credentials and report are present.'

export function fixtureCapabilities(caseId, workerId) {
  const allowed = caseId !== 'idle-with-error'
  return { can_spawn: caseId !== 'no-task-permission', principal_known: true,
    permission_source: workerId ? 'persisted_worker_principal' : 'current_delegation_principal',
    implementations: [{ impl: 'builtin', ready: true,
      permissions: { tool_access: { file_io: allowed, shell: allowed, desktop: allowed } },
      tools: allowed ? ['Read', 'Edit', 'Bash', 'mcp__computer-use__get_state'] : [], source: 'fixture' }] }
}

export function simulateFixtureTool(name, args, state) {
  if (name === 'Read') {
    if (args.file_path === '/fixture/add.py') return state.file
    if (args.file_path === '/fixture/check.py') return checkFile
    if (args.file_path === '/fixture/error.log') return errorLog
  }
  if (name === 'Edit' && args.file_path === '/fixture/add.py'
    && typeof args.old_string === 'string' && args.old_string.length
    && typeof args.new_string === 'string' && state.file.includes(args.old_string)) {
    state.file = state.file.replace(args.old_string, args.new_string)
    return 'Updated'
  }
  if (name === 'Bash' && typeof args.command === 'string') {
    const command = args.command.trim()
    if (/^(?:python|python3) \/fixture\/check.py$/.test(command)
      || /^cd \/fixture && (?:python|python3) check.py$/.test(command)
      || command === 'cat -A /fixture/add.py; echo ---; cat /fixture/check.py; echo ---; cd /fixture && python check.py') {
      state.passed = state.file === initialFile.replace('a - b', 'a + b')
      const result = state.passed ? 'PASS: add(2,3)=5; add(-1,1)=0' : 'FAIL: add fixture is not corrected'
      return command.startsWith('cat -A') ? state.file.replaceAll('\n', '$\n') + '\n---\n' + checkFile + '\n---\n' + result : result
    }
    if (command === 'ls -laR /fixture 2>&1 | head -100'
      || command === 'ls -la /fixture 2>&1; echo "---"; find /fixture -maxdepth 3 -type f | head -50') {
      return 'error.log\nreport.csv\n---\n/fixture/error.log\n/fixture/report.csv\n'
    }
    if (command === 'ls -la /fixture && echo "---" && cat /fixture/error.log') {
      return 'error.log\nreport.csv\n---\n' + errorLog
    }
  }
  if (name === 'finish_task') return { accepted: true }
  throw Error('Unsupported synthetic tool call')
}
