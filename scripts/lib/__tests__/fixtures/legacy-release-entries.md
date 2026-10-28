# 旧发行关键入口测试样本

legacy-release-entries.json.gz 是 UTF-8 JSON 的 gzip，不是可运行的发行包。它仅包含旧安装识别目录所列八个关键文件的原始字节（base64）和来源归档 SHA-256，不含 Provider、用户数据、依赖或账号。测试每次物化都重新核对 scripts/desktop/legacy-releases.json 的正式指纹，不使用生成后的新代码模拟旧入口。

| 原始归档 | SHA-256 |
| --- | --- |
| crabot-v2026.10.14.1-darwin-arm64.tar.gz | 8274dbf59b876fac1687a4846ad9854915fb55f54069d413a339f4536e75278a |
| crabot-v2026.10.15.1-darwin-arm64.tar.gz | 3624c57ac8a7b68fe1936c564b0ded4b2b0bc1ae68f0b32acbc802834b97b13b |

原始来源为本项目对应 GitHub Release 资产。上述样本用于关键入口兼容、阻断和故障恢复测试；不能证明完整旧 MM、依赖、环境或旧安装实际迁移成功。它随 __tests__ 一同排除出产品载荷，CI 不必下载和启动旧业务 Core。

Windows 样本保留原始 CRLF 字节，先校验完整公开 ZIP 后才读取指定条目：

- v2026.10.14.1 windows-x64: `0818267002393e765c75eb6a4bf1d911feae5e975f395a95b380a353f06106a9` (398632968 bytes).
- v2026.10.15.1 windows-x64: `50bab1bf8dabdac7dc3235336f056d7738f048aa3e89bce9f9443ace2bad25b8` (398655802 bytes).

两版四个源入口逐字节相同，编译后 Core 条目匹配原每版本目录。识别按平台比较原始摘要，仅修改换行也会被拒绝。另核验完整 v2026.10.15.1 linux-x64 归档（`735c56bdc74b12a67b8d889fa211aa35dc916b20d2b509262d51898307bb3f64`，439576227 字节），八项入口均匹配 Unix 目录。指定脚本样本不能代替原生整套旧发行迁移验收。
