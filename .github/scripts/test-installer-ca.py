"""CA relocation preserves selected trust bytes and only affects unencodable Windows paths."""
import ast
import locale
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / "scripts/scrapling/server.py"
function = next(item for item in ast.parse(source.read_text(encoding="utf-8")).body if isinstance(item, ast.FunctionDef) and item.name == "prepare_windows_ca")
namespace = {"sys": SimpleNamespace(platform="win32"), "locale": locale, "Path": Path, "shutil": shutil, "os": os}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
original = os.getcwd()
with tempfile.TemporaryDirectory(prefix="ca-compat-") as temporary:
    root = Path(temporary)
    certificates = root / "selected-\u7a7a.pem"
    certificates.write_bytes(b"selected-trust-bundle\n")
    scratch = root / "scratch"
    scratch.mkdir()
    curl = SimpleNamespace(DEFAULT_CACERT=str(certificates))
    package = SimpleNamespace(curl=curl)
    try:
        with patch.dict(sys.modules, {"curl_cffi": package, "curl_cffi.curl": curl}), patch.object(locale, "getpreferredencoding", return_value="cp1252"):
            namespace["prepare_windows_ca"](scratch)
            assert os.path.samefile(Path.cwd(), scratch), f"cwd={Path.cwd()!s}, scratch={scratch!s}, ca={curl.DEFAULT_CACERT!r}"
            assert curl.DEFAULT_CACERT == "ca.pem"
            assert Path(curl.DEFAULT_CACERT).read_bytes() == certificates.read_bytes()
        os.chdir(original)
        curl.DEFAULT_CACERT = str(root / "ascii.pem")
        with patch.dict(sys.modules, {"curl_cffi": package, "curl_cffi.curl": curl}), patch.object(locale, "getpreferredencoding", return_value="cp1252"):
            namespace["prepare_windows_ca"](scratch)
            assert os.path.samefile(os.getcwd(), original)
            assert curl.DEFAULT_CACERT.endswith("ascii.pem")
    finally:
        os.chdir(original)
print("Windows CA path compatibility passed")
