import http.server, os, pathlib, subprocess, tempfile, threading
import sys, json, shutil
repo=pathlib.Path(sys.argv[1]).resolve()
uv=sys.argv[2]
root=pathlib.Path(tempfile.mkdtemp(prefix='crabot-uv-config-audit-'))
requests=[]
class Server(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  requests.append(self.server.label)
  if getattr(self.server,'version_page',False):
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<a href="hatchling-1.0.0-py3-none-any.whl">hatchling</a>')
  else:self.send_response(404);self.end_headers()
 def log_message(self,*args):pass
servers=[]
for label in ['public','private']:
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Server);server.label=label
 threading.Thread(target=server.serve_forever,daemon=True).start();servers.append(server)
public=f'http://127.0.0.1:{servers[0].server_port}/simple'
private=f'http://127.0.0.1:{servers[1].server_port}/simple'
(root/'requirements.txt').write_text('missing-source-audit-package==0.0.1\n')
env={k:v for k,v in os.environ.items() if not k.startswith('UV_')}
env.update(UV_CACHE_DIR=str(root/'cache'),NO_PROXY='localhost,127.0.0.1')
driver=root/'transport.mjs'
module=(repo/'scripts/lib/install-network.mjs').as_uri()
driver.write_text('import { uvTransport } from ' + json.dumps(module) + '; console.log(JSON.stringify(await uvTransport(process.argv[2], process.argv[3])));')
base=[uv,'pip','compile',str(root/'requirements.txt'),'--index',public,'--default-index',public,'--no-cache']
try:
 for native, downloads, preference in [('true','never','only-system'),('false','manual','system')]:
  config=f'native-tls={native}\npython-downloads="{downloads}"\npython-preference="{preference}"\n[[index]]\nname="private"\nurl="{private}"\n'
  (root/'uv.toml').write_text(config)
  requests.clear()
  before=subprocess.run(base,cwd=root,env=env,text=True,capture_output=True,timeout=20)
  assert before.returncode!=0 and 'private' in requests,before.stderr
  settings=subprocess.check_output(['node',str(driver),uv,str(root)],cwd=root,env=env,text=True,timeout=10)
  transport=json.loads(settings)
  assert transport['UV_NATIVE_TLS']==native,transport
  assert transport.get('UV_PYTHON_DOWNLOADS')==downloads,transport
  assert transport.get('UV_PYTHON_PREFERENCE')==preference,transport
  requests.clear()
  isolated=env|transport
  after=subprocess.run(base,cwd=root,env=isolated,text=True,capture_output=True,timeout=20)
  assert after.returncode!=0 and requests and 'private' not in requests,after.stderr
  assert (root/'uv.toml').read_text()==config
  print(f'Private index isolated; native TLS {native} preserved; source config unchanged',flush=True)
 offline_config='offline=true\n'
 (root/'uv.toml').write_text(offline_config)
 requests.clear()
 transport=json.loads(subprocess.check_output(['node',str(driver),uv,str(root)],cwd=root,env=env,text=True,timeout=10))
 assert transport.get('UV_OFFLINE')=='1',transport
 offline=subprocess.run(base,cwd=root,env=env|transport,text=True,capture_output=True,timeout=20)
 assert offline.returncode!=0 and not requests,offline.stderr
 assert (root/'uv.toml').read_text()==offline_config
 print('Configured offline mode retained; no registry requests',flush=True)
 servers[0].version_page=True
 (root/'missing-version.txt').write_text('hatchling==999999.0.0\n')
 missing=subprocess.run([uv,'--no-config','pip','compile',str(root/'missing-version.txt'),'--default-index',public,'--no-cache'],cwd=root,env=env,text=True,capture_output=True,timeout=20)
 assert missing.returncode!=0 and 'there is no version of hatchling==999999.0.0' in missing.stderr,missing.stderr
 fallback=root/'fallback.mjs'
 fallback.write_text('import {packageSource,withPackageSource} from '+json.dumps(module)+';let n=0;const s=packageSource("python","https://mirrors.aliyun.com/pypi/simple/");await withPackageSource(s,async()=>{if(++n===1)throw new Error(process.env.CRABOT_UV_FAILURE)});if(n!==2||s.url!==s.official)process.exit(1);')
 subprocess.run(['node',str(fallback)],env=env|{'CRABOT_UV_FAILURE':missing.stderr},check=True,timeout=10)
 print('Real uv missing locked version triggers exactly one official fallback',flush=True)
finally:
 for server in servers:server.shutdown()
shutil.rmtree(root)
