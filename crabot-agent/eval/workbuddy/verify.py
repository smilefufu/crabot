"""Run the pinned dataset's original CompositeVerifier after the Agent has exited."""
import argparse
import asyncio
import json
import os
import signal
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace

from harbor.models.task.config import TaskOS
from harbor.models.task.task import Task
from harbor.models.trial.paths import TrialPaths
from workbuddy_bench.judge import CompositeVerifier

EXEC = '''import json,os,subprocess,sys
p=json.load(sys.stdin)
r=subprocess.run(p['command'],shell=True,executable='/bin/bash',cwd=p.get('cwd'),env={**os.environ,**(p.get('env') or {})},capture_output=True,text=True)
print(json.dumps({'return_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}))
'''


async def command(*args, payload=None, timeout=1800):
    proc = await asyncio.create_subprocess_exec(*map(str, args), stdin=asyncio.subprocess.PIPE,
                                              stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(payload), timeout)
    if proc.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed ({proc.returncode}): {err.decode()[:500]}')
    return out


class ExistingContainer:
    os = TaskOS.LINUX
    capabilities = SimpleNamespace(mounted=False)

    def __init__(self, name):
        self.name = name

    async def upload_dir(self, source_dir, target_dir):
        await command('docker', 'exec', self.name, 'mkdir', '-p', target_dir)
        await command('docker', 'cp', str(source_dir) + '/.', self.name + ':' + target_dir + '/')

    async def download_dir(self, source_dir, target_dir):
        Path(target_dir).mkdir(parents=True, exist_ok=True)
        await command('docker', 'cp', self.name + ':' + source_dir + '/.', str(target_dir))

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, **kwargs):
        payload = json.dumps({'command': command, 'cwd': cwd, 'env': env}).encode()
        raw = await globals()['command']('docker', 'exec', '-i', self.name, 'python3', '-c', EXEC,
                                          payload=payload, timeout=timeout_sec or 1800)
        return SimpleNamespace(**json.loads(raw))


async def main(args):
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    for event in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(event, task.cancel)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    name = 'crabot-wb-verifier-' + uuid.uuid4().hex[:12]
    await command('docker', 'run', '-d', '--platform', 'linux/amd64', '--name', name,
                  '--network', 'bridge' if os.environ.get('WORKBUDDY_VERIFIER_LLM_BASE_URL') else 'none', '--security-opt', 'no-new-privileges',
                  args.image, 'sleep', 'infinity')
    try:
        environment = ExistingContainer(name)
        if args.workspace:
            await environment.exec('find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +')
            await environment.upload_dir(Path(args.workspace), '/workspace')
        route = {key: value for key, value in os.environ.items() if key.startswith('WORKBUDDY_VERIFIER_LLM_') or key == 'LLM_JUDGE_MAX_CONCURRENT'}
        verifier = CompositeVerifier(task=Task(args.task_dir), trial_paths=TrialPaths(out), environment=environment, override_env=route)
        result = await verifier.verify()
        await environment.download_dir('/logs/verifier', out / 'container-verifier')
        (out / 'result.json').write_text(json.dumps(result.model_dump(), indent=2))
        print(json.dumps(result.model_dump()))
    finally:
        await command('docker', 'rm', '-f', name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--task-dir', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--workspace')
    parser.add_argument('--output', required=True)
    asyncio.run(main(parser.parse_args()))
