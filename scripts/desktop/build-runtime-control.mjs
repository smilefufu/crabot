import path from 'node:path'

// Fixed maintenance must keep its transport executable even when the installed Core is absent.
export async function buildRuntimeControl(build, repository, destination) {
  await build({ entryPoints: [path.resolve(repository, 'scripts/lib/runtime-control.cjs')], outfile: path.resolve(destination),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false,
    external: ['./process-identity.cjs'], logLevel: 'silent', plugins: [{ name: 'fixed-runtime-sources', setup(plugin) {
      plugin.onResolve({ filter: /crabot-(?:core|shared)\/dist\/runtime-(?:stream|rpc)\.js$/ }, args => ({
        path: path.resolve(repository, args.path.includes('crabot-core') ? 'crabot-core/src/runtime-stream.ts' : 'crabot-shared/src/runtime-rpc.ts'),
      }))
      plugin.onResolve({ filter: /^@msgpack\/msgpack$/ }, () => ({ path: path.resolve(repository, 'crabot-desktop/node_modules/@msgpack/msgpack/dist.esm/index.mjs') }))
    } }] })
}
