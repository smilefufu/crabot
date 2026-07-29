#!/usr/bin/env node
// fake-codex-version.mjs — detect() 测试用的假 codex 二进制:只认 `--version`,打印
// FAKE_CODEX_VERSION(env,默认一个形似真实版本号的字符串)后退出。
const version = process.env.FAKE_CODEX_VERSION ?? '0.45.0'
process.stdout.write(version + '\n')
process.exit(0)
