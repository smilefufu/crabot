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


if __name__ == "__main__":
    unittest.main()
