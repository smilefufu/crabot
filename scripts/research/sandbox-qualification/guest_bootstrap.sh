#!/usr/bin/env bash
# Bootstrap only the explicitly selected, disposable qualification VM.
set -euo pipefail
umask 077
[[ $(uname -s) == Linux && $EUID == 0 && $# == 2 ]] || exit 2
task_root=$1
input=$(realpath -e -- "$2")
[[ $task_root == /var/lib/crabot-qualification && ! -L $task_root ]] || exit 2
[[ ! -e $task_root ]] || { echo 'Task root already exists; inspect before rerunning' >&2; exit 2; }
install -d -m 0700 "$task_root" "$task_root/scripts"
install -d -m 0755 "$task_root/fixtures"
printf 'crabot-sandbox-qualification-phase1\n%s\n' "$(cat /etc/machine-id)" > "$task_root/.guest-authorization"
chmod 0600 "$task_root/.guest-authorization"
for name in native_route.sh fixture.py osb_patch.py prepare_osb.sh; do
  [[ -f $input/$name && ! -L $input/$name ]] || exit 2
  install -o root -g root -m 0600 "$input/$name" "$task_root/scripts/$name"
done
install -m 0644 "$task_root/scripts/fixture.py" "$task_root/fixtures/fixture.py"
install -m 0444 "$task_root/.guest-authorization" "$task_root/fixtures/.guest-authorization"
bash "$task_root/scripts/native_route.sh" "$task_root" prepare
