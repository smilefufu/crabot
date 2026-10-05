import asyncio
import inspect
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


if __name__ == "__main__":
    unittest.main()
