"""Research only: unchanged local browser defaults versus explicit sandbox."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

core, endpoint = Path(sys.argv[1]), sys.argv[2]
manifest = json.loads((core / 'product-runtime.json').read_text())
runtime = core / json.loads((core / 'scrapling-runtime.json').read_text())['directory']
ready = json.loads((runtime / 'ready.json').read_text())
os.environ['PLAYWRIGHT_NODEJS_PATH'] = str((runtime / ready['node']).resolve())
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(runtime / 'browsers')
os.environ['FONTCONFIG_FILE'] = str(runtime / 'fonts.conf')
sys.path.insert(0, str(runtime / 'packages'))
from playwright.sync_api import sync_playwright
choices = [core / name for name in manifest['files']
           if re.search(r'/browsers/chromium-[0-9]+/chrome-linux(?:64)?/chrome$', name)]
assert len(choices) == 1
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=str(choices[0]), headless=True,
                                         chromium_sandbox=True, args=['--disable-setuid-sandbox'])
    try:
        page = browser.new_page()
        page.goto(endpoint + '/chromium')
        page.wait_for_function("document.body.dataset.ready === 'yes'")
    finally:
        browser.close()
spec = importlib.util.spec_from_file_location('crabot_research_scrapling', runtime / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
managed = server.paired_linux_core()
if managed:
    server.enable_managed_browser_sandbox()
from scrapling.core.ai import ScraplingMCPServer
async def fetch():
    upstream = ScraplingMCPServer(executable_path=str(runtime / 'chromium-launcher'))
    result = await upstream.fetch(endpoint + '/scrapling', extraction_type='text',
                                  main_content_only=False, headless=True, google_search=False,
                                  wait_selector="body[data-ready='yes']", timeout=30000)
    assert result.status == 200 and 'Crabot' in ''.join(result.content)
asyncio.run(fetch())
print('CRABOT_RESEARCH_BROWSER=' + json.dumps({'raw_fetch': True, 'upstream_mcp_fetch': True,
                                              'existing_managed_sandbox_guard': managed}))
