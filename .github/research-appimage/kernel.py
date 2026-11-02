"""CI-only read-only view of the specified experiment process tree."""
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
    added = {pid for pid, (parent, uid, _, _) in processes.items() if parent in owned and pid not in owned}
    if not added:
        break
    owned.update(added)
result = {'root': root, 'tree_count': len(owned), 'renderers': [], 'profiles': []}
for pid in sorted(owned):
    parent, uid, args, status = processes[pid]
    try:
        current = Path(f'/proc/{pid}/attr/current').read_text().strip()
        result['profiles'].append({'pid': pid, 'profile': current,
            'comm': Path(f'/proc/{pid}/comm').read_text().strip(),
            'no_new_privs': any(line.split() == ['NoNewPrivs:', '1'] for line in status.splitlines()),
            'seccomp': any(line.split() == ['Seccomp:', '2'] for line in status.splitlines()),
            'distinct_user_namespace': Path(f'/proc/{pid}/uid_map').read_text().strip() != host_map})
        if not any('--type=renderer' in arg for arg in args):
            continue
        mapping = Path(f'/proc/{pid}/uid_map').read_text().strip()
        result['renderers'].append({'pid': pid,
            'no_new_privs': any(line.split() == ['NoNewPrivs:', '1'] for line in status.splitlines()),
            'seccomp': any(line.split() == ['Seccomp:', '2'] for line in status.splitlines()),
            'distinct_user_namespace': mapping != host_map,
            'disabled': '--no-sandbox' in args})
    except (FileNotFoundError, ProcessLookupError):
        continue
print(json.dumps(result))
