// Isolated Windows CI only: temporarily set the disposable runner user's fixed
// proxy through WinINet, exercise the real product reader, then restore settings.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.CRABOT_SYSTEM_PROXY_CI !== '1') {
  throw new Error('This probe changes only a disposable Windows CI user profile; explicit CI opt-in is required')
}

if (process.argv.includes('--fixture-child')) {
  process.env.CRABOT_PRODUCT_ROOT = root
  const { ProxyManager } = await import(pathToFileURL(path.join(root, 'crabot-shared/dist/proxy-manager.js')).href)
  const require = createRequire(import.meta.url)
  const native = require(path.join(root, 'crabot-native/build/Release/crabot-native.node'))
  const expected = process.env.CRABOT_PROXY_EXPECTED
  const manager = new ProxyManager()
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), expected || null)
  if (expected) {
    assert.ok(native.readWindowsFixedProxy())
    const response = await fetch('http://crabot-proxy-ci.invalid/actual-fetch', { signal: AbortSignal.timeout(5000) })
    assert.equal(await response.text(), 'fixed-proxy-fixture')
    process.env.HTTPS_PROXY = 'http://inherited.example:8080'
    manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), process.env.HTTPS_PROXY)
    delete process.env.HTTPS_PROXY
  } else assert.equal(native.readWindowsFixedProxy(), null)
  manager.updateConfig({ mode: 'none' })
  assert.equal(manager.getProxyUrl(), null)
  console.log(JSON.stringify({ windows_native_fixed_proxy: true, enabled: Boolean(expected), actual_fetch: Boolean(expected), environment_priority: Boolean(expected) }))
} else {
  const sockets = new Set(), tunnels = []
  const endpoint = http.createServer((_request, response) => response.end('fixed-proxy-fixture'))
  const proxy = http.createServer()
  for (const server of [endpoint, proxy]) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  })
  await Promise.all([endpoint, proxy].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.url)
    const upstream = net.connect(endpoint.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
  })
  // Read/restore all connection flags plus proxy, bypass and PAC URL. Query strings
  // are allocated by WinINet; release them using GlobalFree after copying.
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FixedProxyProbe {
  [StructLayout(LayoutKind.Explicit)] struct Value {
    [FieldOffset(0)] public int Number;
    [FieldOffset(0)] public IntPtr Text;
  }
  [StructLayout(LayoutKind.Sequential)] struct Option { public int Kind; public Value Data; }
  [StructLayout(LayoutKind.Sequential)] struct Options {
    public int Size; public IntPtr Connection; public int Count; public int Error; public IntPtr Items;
  }
  public sealed class State { public int Flags; public string Proxy; public string Bypass; public string Pac; }
  [DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool InternetQueryOptionW(IntPtr internet, int option, ref Options data, ref int size);
  [DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool InternetSetOptionW(IntPtr internet, int option, ref Options data, int size);
  [DllImport("wininet.dll", SetLastError=true, EntryPoint="InternetSetOptionW")]
  static extern bool Refresh(IntPtr internet, int option, IntPtr data, int size);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
  public static State Read() {
    int itemSize=Marshal.SizeOf(typeof(Option));
    var list=new Options { Size=Marshal.SizeOf(typeof(Options)), Count=4, Items=Marshal.AllocHGlobal(itemSize*4) };
    bool read=false;
    try {
      for(int i=0;i<4;i++) Marshal.StructureToPtr(new Option { Kind=i+1 }, IntPtr.Add(list.Items,i*itemSize),false);
      int size=list.Size;
      if(!InternetQueryOptionW(IntPtr.Zero,75,ref list,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      read=true;
      var values=new Option[4];
      for(int i=0;i<4;i++) values[i]=(Option)Marshal.PtrToStructure(IntPtr.Add(list.Items,i*itemSize),typeof(Option));
      return new State { Flags=values[0].Data.Number, Proxy=Marshal.PtrToStringUni(values[1].Data.Text),
        Bypass=Marshal.PtrToStringUni(values[2].Data.Text), Pac=Marshal.PtrToStringUni(values[3].Data.Text) };
    } finally {
      if(read) for(int i=1;i<4;i++) { var value=(Option)Marshal.PtrToStructure(IntPtr.Add(list.Items,i*itemSize),typeof(Option)); if(value.Data.Text!=IntPtr.Zero) GlobalFree(value.Data.Text); }
      Marshal.FreeHGlobal(list.Items);
    }
  }
  public static void Write(State state) {
    int itemSize=Marshal.SizeOf(typeof(Option));
    var list=new Options { Size=Marshal.SizeOf(typeof(Options)), Count=4, Items=Marshal.AllocHGlobal(itemSize*4) };
    var text=new IntPtr[3];
    try {
      var values=new string[] { state.Proxy,state.Bypass,state.Pac };
      Marshal.StructureToPtr(new Option { Kind=1,Data=new Value { Number=state.Flags } },list.Items,false);
      for(int i=0;i<3;i++) {
        text[i]=values[i]==null ? IntPtr.Zero : Marshal.StringToHGlobalUni(values[i]);
        Marshal.StructureToPtr(new Option { Kind=i+2,Data=new Value { Text=text[i] } },IntPtr.Add(list.Items,(i+1)*itemSize),false);
      }
      if(!InternetSetOptionW(IntPtr.Zero,75,ref list,list.Size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      Refresh(IntPtr.Zero,39,IntPtr.Zero,0); Refresh(IntPtr.Zero,37,IntPtr.Zero,0);
    } finally { foreach(var value in text) if(value!=IntPtr.Zero) Marshal.FreeHGlobal(value); Marshal.FreeHGlobal(list.Items); }
  }
}
'@
$original=[FixedProxyProbe]::Read()
try {
  foreach($value in @($env:CRABOT_PROXY_FIXED,('http=127.0.0.1:1;https='+$env:CRABOT_PROXY_FIXED))) {
    $fixture=New-Object FixedProxyProbe+State
    $fixture.Flags=3; $fixture.Proxy=$value; $fixture.Bypass='*zhihu.com;<local>'
    [FixedProxyProbe]::Write($fixture)
    $env:CRABOT_PROXY_EXPECTED='http://'+$env:CRABOT_PROXY_FIXED
    & $env:CRABOT_PROXY_NODE $env:CRABOT_PROXY_PROBE --fixture-child
    if($LASTEXITCODE -ne 0){throw 'Fixed proxy child failed'}
  }
  $fixture=New-Object FixedProxyProbe+State
  $fixture.Flags=1
  [FixedProxyProbe]::Write($fixture)
  $env:CRABOT_PROXY_EXPECTED=''
  & $env:CRABOT_PROXY_NODE $env:CRABOT_PROXY_PROBE --fixture-child
  if($LASTEXITCODE -ne 0){throw 'Disabled proxy child failed'}
} finally { [FixedProxyProbe]::Write($original) }
`
  try {
    const env = { ...process.env, CRABOT_PROXY_FIXED: `127.0.0.1:${proxy.address().port}`,
      CRABOT_PROXY_NODE: process.execPath, CRABOT_PROXY_PROBE: fileURLToPath(import.meta.url) }
    for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key]
    const executable = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
    })
    console.log(stdout.trim())
    assert.deepEqual(tunnels, ['crabot-proxy-ci.invalid:80', 'crabot-proxy-ci.invalid:80'])
    console.log(JSON.stringify({ settings_restored: true, native_connect_tunnels: tunnels.length }))
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([endpoint, proxy].map(server => new Promise(resolve => server.close(resolve))))
  }
}
