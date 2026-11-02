"""Research only: unchanged local browser defaults versus explicit sandbox."""
import asyncio
import importlib.util
import json
import os
import functools
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
def kernel(processes):
    expected = Path('/proc/self/uid_map').read_text().strip()
    renderers = []
    for process in processes:
        if process['type'] != 'renderer':
            continue
        pid = int(process['id'])
        status = Path(f'/proc/{pid}/status').read_text()
        renderers.append({'pid': pid,
            'no_new_privs': bool(re.search(r'^NoNewPrivs:\s+1$', status, re.M)),
            'seccomp': bool(re.search(r'^Seccomp:\s+2$', status, re.M)),
            'distinct_user_namespace': Path(f'/proc/{pid}/uid_map').read_text().strip() != expected})
    return renderers
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
        values = browser.new_browser_cdp_session().send('SystemInfo.getProcessInfo')['processInfo']
        print('CRABOT_RESEARCH_BROWSER_KERNEL=' + json.dumps({'role': 'chromium', 'renderers': kernel(values)}), flush=True)
    finally:
        browser.close()
spec = importlib.util.spec_from_file_location('crabot_research_scrapling', runtime / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
managed = server.paired_linux_core()
if managed:
    server.enable_managed_browser_sandbox()
def observed(method):
    @functools.wraps(method)
    async def goto(page, *args, **kwargs):
        result = await method(page, *args, **kwargs)
        browser = page.context.browser
        if browser:
            session = await browser.new_browser_cdp_session()
            values = (await session.send('SystemInfo.getProcessInfo'))['processInfo']
            print('CRABOT_RESEARCH_BROWSER_KERNEL=' + json.dumps({'role': 'scrapling', 'renderers': kernel(values)}), flush=True)
            await session.detach()
        return result
    return goto
from playwright.async_api import Page as PlaywrightPage
from patchright.async_api import Page as PatchrightPage
for page_type in (PlaywrightPage, PatchrightPage):
    page_type.goto = observed(page_type.goto)
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
