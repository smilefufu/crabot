// Explicitly approved validation only: bind exactly one disposable cgroup subtree, never the host tree.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const requestedImage = process.argv[2], nodeBinary = process.argv[3] ?? '/usr/local/bin/node'
if (!requestedImage || requestedImage.startsWith('-')) throw new Error('Supply a local Linux Node + pytest-xdist image; no image is pulled automatically')
const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const token = randomUUID(), anchor = `crabot-resource-anchor-${token}`, runner = `crabot-resource-runner-${token}`
const docker = (...args) => execFileSync('docker', args, { encoding:'utf8', stdio:['ignore','pipe','inherit'] }).trim()
const image = docker('image','inspect',requestedImage,'--format','{{.Id}}')
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Local image identity not verified')
try {
  const id = docker('run','-d','--name',anchor,'--memory=4g','--cpus=2','--pids-limit=1024','--network=none','--cgroupns=host','--init','--entrypoint','/bin/sh',image,'-c','exec sleep 600')
  const membership = docker('exec',anchor,'cat','/proc/self/cgroup').split('\n').find(line=>line.startsWith('0::'))?.slice(3)
  if (!membership?.startsWith('/') || membership.includes('..') || !membership.includes(id)) throw new Error('Disposable cgroup identity not verified')
  const mount = `type=bind,src=/sys/fs/cgroup${membership},dst=/cg`
  const setup = `const f=require('fs');for(const d of ['control','tools'])f.mkdirSync('/cg/'+d); for(const pid of f.readFileSync('/cg/cgroup.procs','utf8').trim().split(/\\s+/).filter(Boolean))f.writeFileSync('/cg/control/cgroup.procs',pid); f.writeFileSync('/cg/control/cgroup.procs',String(process.pid)); f.writeFileSync('/cg/cgroup.subtree_control','+cpu +memory +pids'); f.writeFileSync('/cg/tools/memory.max','2952790016'); f.writeFileSync('/cg/tools/memory.swap.max','0'); f.writeFileSync('/cg/tools/pids.max','512'); f.writeFileSync('/cg/tools/memory.oom.group','1'); f.writeFileSync('/cg/tools/cgroup.subtree_control','+cpu +memory +pids'); f.chownSync('/cg/cgroup.procs',1000,1000); f.chownSync('/cg/tools',1000,1000);`
  const bootstrap = `${setup};process.setgroups([]);process.setgid(1000);process.setuid(1000);require('/work/scripts/verify-tool-resource-containment.cjs')`
  const result = docker('run','--rm','--name',runner,'--pid',`container:${anchor}`,'--memory=4g','--cpus=2','--network=none','--cgroupns=host','--mount',mount,'--mount',`type=bind,src=${workspace},dst=/work,readonly`,'-e',`PATH=${path.posix.dirname(nodeBinary)}:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin`,'-e','CRABOT_TOOL_CGROUP_ROOT=/cg/tools','-e','CRABOT_EXECUTION_CPU_LIMIT=2','-e','CRABOT_EXECUTION_MEMORY_BYTES=4294967296','--entrypoint',nodeBinary,image,'-e',bootstrap)
  console.log(result)
} finally {
  for (const name of [runner,anchor]) {
    try { execFileSync('docker',['rm','-f',name],{stdio:'ignore'}) } catch { /* --rm may already have removed the runner. */ }
    let remains = false
    try { execFileSync('docker',['container','inspect',name],{stdio:'ignore'}); remains = true } catch {}
    if (remains) throw new Error(`Validation container cleanup not confirmed: ${name}`)
  }
}
