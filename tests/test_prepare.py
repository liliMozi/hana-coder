import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


prepare = module('prepare')
runner = module('run_command')


class PrepareTests(unittest.TestCase):
    def test_command_package_fixed_bindings_and_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = pathlib.Path(tmp) / 'card'
            args = prepare.parser().parse_args(['commands', '--repo', tmp, '--out', str(output)])
            result = prepare.prepare(args)
            html = (output / 'index.html').read_text()
            manifest = prepare.read_block(html, 'data-card-manifest')
            state = prepare.read_block(html, 'data-card-state')
            self.assertEqual(result['kind'], 'commands')
            self.assertEqual(len(state['panel']['commands']), 4)
            for item in state['panel']['commands']:
                binding = manifest['toolBindings'][item['bindingId']]
                self.assertNotIn('slots', binding)
                self.assertEqual(binding['input']['workdir'], str(pathlib.Path(tmp).resolve()))
                self.assertIn('run_command.py', binding['input']['cmd'])
            for asset in manifest['packageAssets']:
                self.assertTrue((output / asset).is_file())
            with self.assertRaises(ValueError):
                prepare.prepare(args)

    def test_json_script_escaping(self):
        text = prepare.script_json({'title': '</script><script>alert(1)</script>'})
        self.assertNotIn('<', text)
        self.assertEqual(json.loads(text)['title'], '</script><script>alert(1)</script>')

    def test_issue_package_keeps_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = pathlib.Path(tmp) / 'state.json'
            state = {'uiLanguage': 'zh', 'title': '分组确认', 'repo': 'example/repo', 'rangeLabel': '指定范围', 'groups': [], 'notes': {}, 'submittedAt': None, 'page': 0}
            state_file.write_text(json.dumps(state))
            output = pathlib.Path(tmp) / 'card'
            result = prepare.prepare(prepare.parser().parse_args(['issue-gate', '--state', str(state_file), '--out', str(output)]))
            actual = prepare.read_block((output / 'index.html').read_text(), 'data-card-state')
            self.assertEqual(actual['groups'], [])
            self.assertTrue(actual['hero'])
            self.assertEqual(result['objects'], 0)

    def test_runner_success_failure_and_timeout(self):
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            success = runner.run([sys.executable, '-c', 'print("hello")'], tmp)
            self.assertEqual(success['exitCode'], 0)
            self.assertEqual(success['output'].strip(), 'hello')
            failed = runner.run([sys.executable, '-c', 'raise SystemExit(7)'], tmp)
            self.assertEqual(failed['exitCode'], 7)
            timeout = runner.run([sys.executable, '-c', 'import time;time.sleep(3)'], tmp, timeout=0.1)
            self.assertIsNone(timeout['exitCode'])
            self.assertIn('timeout', timeout['error'])
            long = runner.run([sys.executable, '-c', 'print("x" * 15000)'], tmp)
            self.assertTrue(long['outputTruncated'])


if __name__ == '__main__':
    unittest.main()
