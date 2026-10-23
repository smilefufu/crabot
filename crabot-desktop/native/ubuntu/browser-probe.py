"""Ordinary-UID installation probe; fixed bundled browsers, no Provider/MM."""
import json
import asyncio
import importlib.util
import os
from pathlib import Path
import re
import sys

assert os.getuid() != 0 and len(sys.argv) == 3
core, endpoint = Path(sys.argv[1]), sys.argv[2]
assert core.is_absolute() and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}/[a-f0-9]{64}', endpoint)
manifest = json.loads((core / 'product-runtime.json').read_text())
directory = json.loads((core / 'scrapling-runtime.json').read_text())['directory']
assert re.fullmatch(r'\.scrapling-runtime-[A-Za-z0-9.-]+-[a-f0-9]{16}-[a-f0-9]{8}', directory)
launcher = manifest['browser']
assert launcher == directory + '/chromium-launcher'
runtime = core / directory
sys.path.insert(0, str(runtime / 'packages'))
from playwright.sync_api import sync_playwright

roles = {
    'chromium': r'browsers/chromium-[0-9]+/chrome-linux(64)?/chrome',
    'headless': r'browsers/chromium_headless_shell-[0-9]+/chrome-headless-shell-linux(64)?/headless_shell',
}
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(runtime / 'browsers')
with sync_playwright() as playwright:
    for role, pattern in roles.items():
        choices = [core / name for name in manifest['files'] if name.startswith(str(Path(launcher).parent) + '/')
                   and re.fullmatch(pattern, name[len(str(Path(launcher).parent)) + 1:])]
        if role == 'headless' and not choices:
            continue  # Current products use --no-shell; full Chrome handles headless.
        assert len(choices) == 1
        browser = playwright.chromium.launch(executable_path=str(choices[0]), headless=True, chromium_sandbox=True,
                                             args=['--disable-setuid-sandbox'], timeout=45000)
        try:
            page = browser.new_page()
            page.goto(endpoint + '/' + role, wait_until='load', timeout=30000)
            page.wait_for_function("document.body.dataset.ready === 'yes'", timeout=15000)
            processes = browser.new_browser_cdp_session().send('SystemInfo.getProcessInfo')['processInfo']
            renderers = [int(item['id']) for item in processes if item['type'] == 'renderer']
            assert renderers
            for pid in renderers:
                status = Path(f'/proc/{pid}/status').read_text()
                assert re.search(r'^NoNewPrivs:\s+1$', status, re.M) and re.search(r'^Seccomp:\s+2$', status, re.M)
                mapping = Path(f'/proc/{pid}/uid_map').read_text().strip()
                assert mapping and mapping != Path('/proc/self/uid_map').read_text().strip()
        finally:
            browser.close()
# Exercise the actual bundled MCP fetch path, not only raw Playwright options.
spec = importlib.util.spec_from_file_location('crabot_install_scrapling', runtime / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
assert server.paired_linux_core()
server.enable_managed_browser_sandbox()
os.environ['FONTCONFIG_FILE'] = str(runtime / 'fonts.conf')
from scrapling.core.ai import ScraplingMCPServer
async def fetch():
    upstream = ScraplingMCPServer(executable_path=str(runtime / 'chromium-launcher'))
    result = await upstream.fetch(endpoint + '/scrapling', extraction_type='text', main_content_only=False,
                                  headless=True, google_search=False, wait_selector="body[data-ready='yes']", timeout=30000)
    assert result.status == 200 and result.url == endpoint + '/scrapling' and 'Crabot' in ''.join(result.content)
asyncio.run(fetch())
print('CRABOT_BROWSER_SANDBOX_VERIFIED')
