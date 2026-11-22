# Linux 沙盒资格原型（研究用途）

对应 [原型 spec](https://github.com/smilefufu/crabot-docs/blob/6cdccca/superpowers/specs/2026-11-22-sandbox-qualification-prototype-design.md) 的第一关。只在经人类选择、可丢弃的独立 Linux VM 内运行；不修改 Crabot 产品入口，不连接真实 Provider/渠道或旧 DATA_DIR。基础机制通过不代表真实 Crabot 已接入，更不代表生产发行已通过。

[2026-11-22 实测报告](https://github.com/smilefufu/crabot-docs/blob/main/superpowers/research/2026-11-22-sandbox-qualification-phase1-results.md)：N 的聚合整组 OOM 未通过，P 在当前固定存储配置下首次带 disk 创建被拒绝；两个组合均未完整通过资格门槛。这些是保留失败和证据的研究工具，不能用于启用产品沙盒，也不应对已有测试状态盲目重跑。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `lima.yaml`、`host_vm.py` | 固定 4 vCPU/12 GiB/40 GiB 的专用 VZ VM；独立 runtime、环境白名单、无 home/agent/X11 共享和业务端口转发 |
| `verify_images.py` | Lima/Ubuntu 固定 SHA-256、Canonical 公钥指纹与校验清单签名；需要 PGPy 0.6.0。PGPy 不是完整撤销/PKI 验证器 |
| `pull_fixed_images.py` | 宿主仅经官方 Registry v2 下载三个固定 arm64 child manifest、config 和 layer，验 hash/size/diff ID；生成离线导入归档与 provenance。无 Docker 调用，不解包镜像层 tar |
| `pull_fixed_images_test.py` | 无网络的假 Registry/blob 测试：opaque 封装、manifest/config/diff 身份、坏 hash、缓存、限额与 HTTPS；不运行镜像 |
| `guest_bootstrap.sh` | 从已绑定的 host_vm shell 进入专用 VM 后，一次性建立测试根、marker、脚本及预算；禁止在其他 Linux 机器直接调用 |
| `native_route.sh` | 原生 N 路线：固定 NsJail 3.6、systemd/cgroup v2、受限卷、私有 namespace、有限输出和精确收口 |
| `fixture.py` | 两路线共用的有限载荷与合成文件/网络探针；不是授权或资源执行边界 |
| `osb_patch.py`、`prepare_osb.sh` | 对 OpenSandbox 1.2.1 的固定资源创建/核验补丁；没有新增产品身份、所有权或恢复语义 |
| `guest_osb_bootstrap.sh`、`osb_probe.py` | N 清零后准备私有 Docker/XFS/固定工作镜像，顺序测试 P 基础边界和资源；不使用宿主已有 Docker |

## 执行顺序

先按 spec 审查/确认目标、下载校验材料、资源与清理范围。`QUAL_ROOT` 是专用任务目录，`QUAL_RUNTIME` 是短路径的私有 Lima runtime；不得指向已有 Lima 或业务目录，也不得重写 HOME。软件包、镜像 digest、实际配置和源码 hash 随本次运行登记。bootstrap 中的资产 hash 属于这次冻结载荷，不能为通过检查随意改成另一个包。

```bash
python3 verify_images.py "$QUAL_ROOT/downloads"
python3 host_vm.py --root "$QUAL_ROOT" --runtime "$QUAL_RUNTIME" create
python3 host_vm.py --root "$QUAL_ROOT" --runtime "$QUAL_RUNTIME" start
```

host_vm 只操作自己的固定实例，runtime 的私有 owner marker 绑定任务目录和版本。失败的创建保留状态，拒绝自动重新认领；先核对现场。输入只从任务 input/downloads 传入，证据只能导出到 evidence；没有任意 VM 间复制。

进入 guest 后先核对实际内核、systemd、cgroup v2/controller、无共享挂载、无敏感环境继承；再经已绑定的 host_vm shell 调用一次性 guest bootstrap。guest 任务根固定为本原型专用目录，后续脚本仍显式传入它。依赖安装、构建和平台 server/daemon 均进入已准备的 infrastructure slice。不得在宿主运行压力载荷。

```bash
# 以下命令只在已选择的 guest 内，以显式参数运行。
sudo bash native_route.sh "$GUEST_TASK_ROOT" build
sudo bash native_route.sh "$GUEST_TASK_ROOT" paths
sudo bash native_route.sh "$GUEST_TASK_ROOT" run a work -- \
  /usr/bin/python3 /fixtures/fixture.py --root /workspace \
  --authorization-file /fixtures/.guest-authorization \
  --allow-unmapped-root-marker --deadline-seconds 45 inspect
sudo bash native_route.sh "$GUEST_TASK_ROOT" cleanup
```

N 的未映射 root marker 旗标默认关闭，只在真实只读挂载、owner65534、严格单 UID 映射 1000→62001/62002 且 kind/machine-id 匹配时接受。它处理 namespace 的 owner 显示，不放宽宿主 marker、cgroup 或身份边界。普通宿主映射/可写挂载均拒绝。

N 实测发现 systemd 创建子 service 会重置手写的 work slice `memory.oom.group`。当前总预算和控制面保留有证据，聚合工具整组 OOM 策略仍未通过；不能把 prepare 后的一次读数当作稳定运行配置。

N 的全部登记单元和预算组清零后，P 才能开始。P bootstrap 只使用已核验的固定资产，在专用 8 GiB XFS loop 卷开启 project quota；不格式化系统盘、不使用全局 Docker context。无法兑现 writable-layer quota 就记录失败，不删掉 disk 请求。P 的资源补丁没有解决 stock 多 Server 共用 daemon 的恢复归属，相关项必须单独标未测。

```bash
# 只在 N 清零后的 guest 内；输入目录仅含本次冻结资产。
sudo bash guest_osb_bootstrap.sh "$GUEST_TASK_ROOT" "$GUEST_INPUT_DIR"
# observer 必须经 systemd-run 进入实际 infrastructure slice 后调用。
sudo python3 osb_probe.py --root "$GUEST_TASK_ROOT"
```

每个 fixture 有有限时间、内存/任务数/写盘尝试量与输出上限，外层还必须有内核预算及独立 watchdog。先验证实际归属再施压；fixture 的 marker 不证明资源保护。不能把 API 返回成功、标签或本地模拟当作实际 cgroup/进程证据。

## 固定镜像与离线导入

guest 访问 Registry 受阻时，可以在本次宿主任务目录准备下列资产；不是从宿主已有 Docker 导出镜像，也不在宿主运行容器。

| 名称 | 官方 arm64 child manifest |
| --- | --- |
| execd | `opensandbox/execd@sha256:49b717e2c43b242f80bcd350403186ee8ec8a28576b2cb45471b015d5120f28f` |
| egress | `opensandbox/egress@sha256:2741d5fb796ab859a855e99b5255e740e3562fbaaa2a6d85428e2ed6d3eb19e3` |
| python | `library/python@sha256:c61cffc3bacb94ed026ff8b45d5114b7693dd0420baca0a1ace0e3d0ce9035fd` |

```bash
# 仅下载、校验与封装；不访问任何 Docker engine。
python3 pull_fixed_images.py --root "$QUAL_ROOT"
```

缓存与输出在 `downloads/fixed-images`：压缩 blob 累计上限 1 GiB，展开层 2 GiB，归档 3 GiB，宿主至少保留 30 GiB；每个请求 60 秒，整轮 20 分钟。gzip 仅展开成 opaque `layer.tar`，不解析或提取层内路径。已验证的完整 blob/layer 可以复用；不接受 hash 不符的缓存，不承诺未完成 blob 的 Range 续传。不支持的 manifest/layer 媒体类型直接拒绝。

输出 `execd-arm64.tar`、`egress-arm64.tar`、`python-arm64.tar` 和 `provenance.json`，包含 `source_manifest`、`config_id`、`diff_ids`、`local_tag`、`archive_sha256`。`--image python` 可用于单项诊断，但 provenance 每次只保存本轮选择；离线准备结束前必须再运行一次不带 `--image` 的完整命令，生成三项记录，不凭片段推定其他镜像已经验证。

先按 `archive_sha256` 核对归档，再通过已绑定的 `host_vm.py copy` 从任务 downloads 传入 guest。本轮受信准备流程只能向已就绪的专用 daemon 导入；下面的操作仅在 guest、实际 infrastructure slice 下执行，三个归档分别导入：

```bash
sudo systemd-run --quiet --wait --pipe --collect \
  --slice="$GUEST_INFRA_SLICE" --property=MemoryMax=128M \
  --property=TasksMax=16 --property=RuntimeMaxSec=60s \
  --property=TimeoutStopSec=5s --property=KillMode=control-group \
  "$GUEST_TASK_ROOT/p/bin/docker" --host "unix://$GUEST_TASK_ROOT/docker.sock" \
  load --input "$GUEST_INPUT_DIR/python-arm64.tar"
```

离线 load 不一定保留 `RepoDigests`。将本轮核验后的 provenance 作为 root-owned、0600 的 `p/image-provenance.json` 保存；继续准备前对比专用 daemon 中的实际 image ID、Linux/arm64 和 RootFS diff IDs。execd/egress 使用 prepare 已支持的本地 `sha256:<config ID>`，仍绑定上表官方源 manifest；不能用相同 tag 代替来源证明。下载器不会自动恢复失败的 bootstrap、改用宿主 daemon 或改变 P 的测试边界。

## 验证和收口

以下命令在本目录运行。本地测试只验证参数上限、路径安全、误操作守卫、固定源码补丁和有界解析，不运行压力：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p '*test*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest pull_fixed_images_test -v
bash -n native_route.sh prepare_osb.sh guest_bootstrap.sh guest_osb_bootstrap.sh
```

下载器的持久测试使用本地假 metadata/blob，验证 raw manifest、压缩 blob 和展开 diff ID，故意使用不可解析为 tar 的层验证 opaque 封装，并检查同大小坏 hash、缓存复验、硬写入限额、不支持媒体类型、HTTPS 降级拒绝及 Bearer 不随重定向转发。它不联系真实 Registry，不调用 Docker；真正的 guest load 与运行结果须另记。

运行报告分通过、失败、未测；保留初始失败和修正。合成 canary 可以用于私密性负例，不能读取真实私钥/业务凭据。只导出脱敏证据，不导出平台 API key、egress token、VM 私钥或整个 runtime。

结束时先按登记对象停止各路线工作、沙盒、server/engine，核对实际残留；不执行全局 prune、宽泛进程名强杀或删除未知目录。最后通过已绑定的 host_vm 停止专用 VM并确认 Stopped/管理端口收口。保留数据和诊断，清理未知如实记录；不自动重放。第二关真实 Crabot 离线集成须另有明确授权。
