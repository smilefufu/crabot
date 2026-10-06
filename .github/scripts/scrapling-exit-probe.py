from pathlib import Path
import asyncio, os, signal, json, sys, time

runtime=Path(sys.argv[1]).resolve()
private=Path(os.environ['DATA_DIR'])
private.mkdir(parents=True,exist_ok=True)
env=dict(os.environ, CRABOT_SCRAPLING_DATA_DIR=str(private), CRABOT_SCRAPLING_SYSTEM='1', TMPDIR=str(private/'tmp'), PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1')
Path(env['TMPDIR']).mkdir(exist_ok=True)
uid=os.getuid()

def browsers():
    out=[]
    for folder in Path('/proc').iterdir():
        if not folder.name.isdigit(): continue
        try:
            status=(folder/'status').read_text()
            owner=int(next(line for line in status.splitlines() if line.startswith('Uid:')).split()[1])
            cmd=(folder/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
            if owner==uid and any(x in cmd for x in ['/chrome ','/chrome_crashpad_handler','/driver/node']):
                out.append({'pid':int(folder.name),'command':cmd[:200]})
        except (OSError,StopIteration): pass
    return out

async def rpc(proc, value):
    proc.stdin.write((json.dumps(value)+'\n').encode())
    await proc.stdin.drain()
    if 'id' not in value: return
    while True:
        line=await asyncio.wait_for(proc.stdout.readline(),45)
        if not line: raise RuntimeError('MCP stdout closed before reply')
        answer=json.loads(line)
        if answer.get('id')==value['id']:
            assert not answer.get('error'),answer
            return answer['result']

async def run():
    outcomes=[]
    for mode in ['stdin-eof','sigterm']:
        with (private/(mode+'.stderr')).open('wb') as err:
            proc=await asyncio.create_subprocess_exec(str(runtime/'python-launcher'),'-I','-B',str(runtime/'server.py'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=err,env=env,start_new_session=True)
            try:
                await rpc(proc,{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'exit-audit','version':'1'}}})
                await rpc(proc,{'jsonrpc':'2.0','method':'notifications/initialized'})
                opened=await rpc(proc,{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'open_session','arguments':{'session_type':'dynamic','session_id':mode}}})
                assert not opened.get('isError'),opened
                assert browsers(),'no browser running before exit'
                if mode=='stdin-eof': proc.stdin.close()
                else: proc.send_signal(signal.SIGTERM)
                print(json.dumps({'uid':uid,'checkingExit':mode}),flush=True)
                await asyncio.wait_for(proc.wait(),10)
                for _ in range(40):
                    remaining=browsers()
                    if not remaining: break
                    await asyncio.sleep(0.2)
                outcomes.append({'exit':mode,'returncode':proc.returncode,'remaining':remaining})
                assert proc.returncode == 0, outcomes[-1]
                assert not remaining, outcomes[-1]
            finally:
                try: os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                if proc.returncode is None: await proc.wait()
    (private/'exit-result.json').write_text(json.dumps(outcomes,indent=2))
    print(json.dumps({'uid':uid,'exitAudit':outcomes}),flush=True)

asyncio.run(run())
