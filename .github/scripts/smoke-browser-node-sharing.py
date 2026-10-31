"""Exercise both pinned browser drivers with only the shared bundled Node."""
import json
import os
from pathlib import Path
import sys

runtime = Path(sys.argv[1]).resolve()
manifest = json.loads((runtime / "ready.json").read_text())
node = runtime / manifest["node"]
duplicate = runtime / "packages/patchright/driver" / ("node.exe" if sys.platform == "win32" else "node")
assert node.is_file(), "Shared browser Node is missing"
assert not duplicate.exists(), "Unused second browser Node is still shipped"
sys.path.insert(0, str(runtime / "packages"))
os.environ["PLAYWRIGHT_NODEJS_PATH"] = str(node)
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(runtime / "browsers")
results = []
for name in ("playwright", "patchright"):
    api = __import__(name + ".sync_api", fromlist=["sync_playwright"])
    driver = __import__(name + "._impl._driver", fromlist=["compute_driver_executable"])
    assert Path(driver.compute_driver_executable()[0]) == node
    with api.sync_playwright() as engine:
        browser = engine.chromium.launch(executable_path=str(runtime / manifest["browser"]),
                                         headless=True, chromium_sandbox=True)
        try:
            page = browser.new_page()
            page.set_content('<input id="name"><button>提交</button><p id="value"></p>')
            page.evaluate("document.querySelector('button').onclick=()=>document.querySelector('#value').textContent=document.querySelector('#name').value")
            page.locator("#name").fill("共用内置 Node")
            page.locator("button").click()
            assert page.locator("#value").inner_text() == "共用内置 Node"
            assert page.screenshot().startswith(b"\x89PNG")
            results.append({"driver": name, "browser": browser.version, "input_click_screenshot": True})
        finally:
            browser.close()
print(json.dumps({"shared_bundled_node": True, "duplicate_absent": True, "cases": results}, ensure_ascii=False))
