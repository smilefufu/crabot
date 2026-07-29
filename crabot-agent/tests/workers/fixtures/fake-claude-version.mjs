#!/usr/bin/env node
// fake-claude-version.mjs — detect() 测试用的假 cc 二进制:只认 `--version`,打印
// FAKE_CLAUDE_VERSION(env,默认一个形似真实版本号的字符串)后退出。
const version = process.env.FAKE_CLAUDE_VERSION ?? '2.1.220 (Claude Code)'
process.stdout.write(version + '\n')
process.exit(0)
