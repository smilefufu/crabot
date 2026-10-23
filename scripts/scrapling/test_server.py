import asyncio
import inspect
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
import server
import unittest
from server import enforce_headless


class HeadlessPolicyTest(unittest.TestCase):
    def test_schema_and_ordinary_defaults_are_preserved(self):
        async def native(url: str, headless: bool = True, cdp_url: str | None = None) -> dict:
            return dict(url=url, headless=headless, cdp_url=cdp_url)
        guarded = enforce_headless(native)
        self.assertEqual(inspect.signature(guarded), inspect.signature(native))
        self.assertTrue(asyncio.run(guarded("https://example.com"))["headless"])
        with self.assertRaisesRegex(Exception, "headless=true"):
            asyncio.run(guarded("https://example.com", headless=False))
        remote = asyncio.run(guarded("https://example.com", headless=False, cdp_url="https://remote.example"))
        self.assertFalse(remote["headless"])
        self.assertEqual(remote["cdp_url"], "https://remote.example")


class PrivateBrowserPathsTest(unittest.TestCase):
    def test_linux_config_ignores_inherited_other_user_paths(self):
        with tempfile.TemporaryDirectory() as data:
            async def capture():
                expected = str(Path(data) / "scrapling" / "config")
                self.assertEqual(os.environ["XDG_CONFIG_HOME"], expected)
                self.assertEqual(os.environ["CHROME_CONFIG_HOME"], expected)
                self.assertTrue(Path(os.environ["TMPDIR"]).is_relative_to(Path(data)))
            with patch.dict(os.environ, {
                "CRABOT_SCRAPLING_DATA_DIR": data,
                "XDG_CONFIG_HOME": "/inaccessible/other-user/config",
                "CHROME_CONFIG_HOME": "/inaccessible/other-user/chrome",
            }), patch.object(server.sys, "platform", "linux"), patch.object(server, "serve", capture):
                try:
                    server.main()
                finally:
                    tempfile.tempdir = None


class ManagedSandboxPolicyTest(unittest.TestCase):
    def test_real_sdk_default_false_is_replaced_only_for_local_chromium_launch(self):
        async def launch(browser, *, chromium_sandbox=False, args=()):
            return {'sandbox': chromium_sandbox, 'args': args}
        guarded = server.enforce_browser_sandbox(launch)
        chromium = type('BrowserType', (), {'name': 'chromium'})()
        other = type('BrowserType', (), {'name': 'firefox'})()
        self.assertEqual(inspect.signature(guarded), inspect.signature(launch))
        self.assertTrue(asyncio.run(guarded(chromium))['sandbox'])
        self.assertFalse(asyncio.run(guarded(other))['sandbox'])
        self.assertTrue(asyncio.run(guarded(chromium, args=['--disable-setuid-sandbox']))['sandbox'])
        for option in ['--no-sandbox', '--no-sandbox=false', '--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox', '--single-process', '--disable-gpu-sandbox']:
            with self.assertRaisesRegex(Exception, '沙箱'):
                asyncio.run(guarded(chromium, args=[option]))
        with self.assertRaisesRegex(Exception, '沙箱'):
            asyncio.run(guarded(chromium, chromium_sandbox=False))

    def test_both_frozen_async_sdks_are_wrapped_once_without_changing_remote_cdp(self):
        from playwright.async_api import BrowserType as PlaywrightBrowserType
        from patchright.async_api import BrowserType as PatchrightBrowserType
        originals = {(cls, name): getattr(cls, name) for cls in (PlaywrightBrowserType, PatchrightBrowserType)
                     for name in ('launch', 'launch_persistent_context', 'connect_over_cdp')}
        try:
            server.enable_managed_browser_sandbox()
            for (cls, name), original in originals.items():
                current = getattr(cls, name)
                self.assertEqual(inspect.signature(current), inspect.signature(original))
                if name == 'connect_over_cdp':
                    self.assertIs(current, original)
                else:
                    self.assertTrue(current._crabot_managed_sandbox)
            once = {key: getattr(*key) for key in originals}
            server.enable_managed_browser_sandbox()
            for key, value in once.items():
                self.assertIs(getattr(*key), value)
        finally:
            for (cls, name), original in originals.items():
                setattr(cls, name, original)

    def test_paired_identity_does_not_change_legacy_cli_or_other_platforms(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            core = Path(directory)
            host = core / 'desktop-host.json'
            with patch.object(server, 'RUNTIME', core / '.scrapling-runtime-test'), patch.object(server.sys, 'platform', 'linux'):
                self.assertFalse(server.paired_linux_core())
                host.write_text(json.dumps({'schema_version': 1, 'platform': 'linux', 'arch': 'x64'}))
                self.assertFalse(server.paired_linux_core())
                host.write_text(json.dumps({'schema_version': 2, 'platform': 'linux', 'arch': 'x64'}))
                self.assertTrue(server.paired_linux_core())
                host.write_text(json.dumps({'schema_version': 2, 'platform': 'linux', 'arch': 'x64', 'disable_sandbox': True}))
                with self.assertRaisesRegex(RuntimeError, 'desktop'):
                    server.paired_linux_core()
                host.write_text('invalid')
                with self.assertRaises(Exception):
                    server.paired_linux_core()
                host.unlink()
                target = core / 'elsewhere'
                target.write_text(json.dumps({'schema_version': 2, 'platform': 'linux', 'arch': 'x64'}))
                host.symlink_to(target)
                with self.assertRaisesRegex(RuntimeError, 'desktop'):
                    server.paired_linux_core()
            with patch.object(server, 'RUNTIME', core / '.scrapling-runtime-test'), patch.object(server.sys, 'platform', 'darwin'):
                self.assertFalse(server.paired_linux_core())


if __name__ == "__main__":
    unittest.main()
