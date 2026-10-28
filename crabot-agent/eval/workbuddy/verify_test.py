"""Run with the pinned WorkBuddy Python environment; never uses Docker or a model."""
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location('workbuddy_verify', Path(__file__).with_name('verify.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class ScorePreservationTest(unittest.IsolatedAsyncioTestCase):
    async def test_container_logs_cannot_overwrite_final_composite_score(self):
        class Environment:
            def __init__(self, name):
                pass

            async def download_dir(self, source, target):
                target = Path(target)
                target.mkdir(parents=True, exist_ok=True)
                (target / 'score.json').write_text(json.dumps({'test_pass_rate': 0.6805}))

        class Composite:
            def __init__(self, **kwargs):
                self.paths = kwargs['trial_paths']

            async def verify(self):
                self.paths.verifier_dir.mkdir(parents=True)
                (self.paths.verifier_dir / 'score.json').write_text(json.dumps({'reward': 0.7763, 'test_pass_rate': 0.6805}))
                return SimpleNamespace(model_dump=lambda: {'rewards': {'reward': 0.7763}})

        with tempfile.TemporaryDirectory(prefix='workbuddy-score-fixture-') as root:
            output = Path(root) / 'trial'
            args = SimpleNamespace(output=str(output), image='fixture', workspace=None, task_dir='fixture')
            with patch.object(verify, 'command', AsyncMock(return_value=b'')), patch.object(verify, 'ExistingContainer', Environment), patch.object(verify, 'CompositeVerifier', Composite), patch.object(verify, 'Task', lambda _: None), patch.object(verify, 'TrialPaths', lambda p: SimpleNamespace(verifier_dir=p / 'verifier')), contextlib.redirect_stdout(io.StringIO()):
                await verify.main(args)
            self.assertEqual(json.loads((output / 'verifier/score.json').read_text())['reward'], 0.7763)
            self.assertEqual(json.loads((output / 'container-verifier/score.json').read_text())['test_pass_rate'], 0.6805)
            self.assertEqual(json.loads((output / 'result.json').read_text())['rewards']['reward'], 0.7763)


if __name__ == '__main__':
    unittest.main()
