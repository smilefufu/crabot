# uv 旧环境 bootstrap 原始字节

legacy-python-bootstrap.json.gz 仅供只读识别回归，不执行其中的 Python 代码。它包含 uv 0.10.1 官方源码的 _virtualenv.py 原字节，以及 virtualenv.rs 写入的 `import _virtualenv` 字节；来源 commit `b1b14d39aef8e307ec5cf1d7243819fd5a2cc544`。每次物化核对产品识别目录的长度与 SHA-256。本测试样本按 uv 的 MIT 许可保存，完整通知见同目录 legacy-python-bootstrap-LICENSE-MIT；来源仓库 https://github.com/astral-sh/uv 。

官方生成入口：https://github.com/astral-sh/uv/blob/b1b14d39aef8e307ec5cf1d7243819fd5a2cc544/crates/uv-virtualenv/src/virtualenv.rs 。上游 #20222 已取消 Python 3.10+ 的这两个 distutils patch 文件；目标内置 Python 3.12 不重新复制旧 hook。仅精确已知摘要可识别为该生成物，未知或修改过的同名文件仍阻止自动重建。参考 https://github.com/astral-sh/uv/pull/20222 。样本不代表旧环境所有依赖已恢复或完整接管通过。
