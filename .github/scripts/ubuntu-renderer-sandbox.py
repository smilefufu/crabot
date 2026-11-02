"""CI-only kernel observation of a specified GUI/MCP process tree, never product code."""
import json
import os
from pathlib import Path
import sys

assert os.geteuid() == 0 and len(sys.argv) == 3
root, owner = map(int, sys.argv[1:])
assert root > 1 and owner > 0
processes = {}
host_map = Path('/proc/self/uid_map').read_text().strip()
for entry in Path('/proc').iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
        status = (entry / 'status').read_text()
        uid = int(next(line for line in status.splitlines() if line.startswith('Uid:')).split()[1])
        args = (entry / 'cmdline').read_bytes().decode(errors='replace').split('\0')
        processes[int(entry.name)] = (int(fields[1]), uid, args, status)
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        continue
assert root in processes and processes[root][1] == owner
owned = {root}
while True:
    added = {pid for pid, (parent, _, _, _) in processes.items() if parent in owned and pid not in owned}
    if not added:
        break
    owned.update(added)
renderers = []
for pid in sorted(owned):
    _, _, args, status = processes[pid]
    if '--type=renderer' not in args:
        continue
    try:
        result = {
            'pid': pid,
            'no_new_privs': any(line.split() == ['NoNewPrivs:', '1'] for line in status.splitlines()),
            'seccomp': any(line.split() == ['Seccomp:', '2'] for line in status.splitlines()),
            'distinct_user_namespace': Path(f'/proc/{pid}/uid_map').read_text().strip() != host_map,
            'sandbox_enabled': '--no-sandbox' not in args,
        }
        assert all(result[key] for key in ('no_new_privs', 'seccomp', 'distinct_user_namespace', 'sandbox_enabled')), result
        renderers.append(result)
    except (FileNotFoundError, ProcessLookupError):
        continue
assert renderers, 'No live renderer observed; this is not sandbox acceptance'
print(json.dumps({'root': root, 'renderers': renderers}))
