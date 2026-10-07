import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('collect', ROOT / 'scripts' / 'collect.py')
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


class CollectorTests(unittest.TestCase):
    def test_real_worktrees_spaces_rename_and_missing_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / 'repo with spaces'
            linked = pathlib.Path(temp) / 'linked tree'
            root.mkdir()
            def git(*args):
                return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, text=True).stdout
            git('init', '-b', 'main')
            git('config', 'user.email', 'test@example.invalid')
            git('config', 'user.name', 'Test')
            (root / 'old name.txt').write_text('initial')
            git('add', 'old name.txt')
            git('commit', '-m', 'initial')
            git('worktree', 'add', '-b', 'feature', str(linked), 'HEAD')
            git('mv', 'old name.txt', 'new\nname.txt')
            (root / 'untracked.txt').write_text('new')
            snapshot = collect.worktrees(root)
            self.assertEqual(len(snapshot['rows']), 2)
            dirty = next(r for r in snapshot['rows'] if r['branch'] == 'main')
            clean = next(r for r in snapshot['rows'] if r['branch'] == 'feature')
            self.assertEqual(dirty['counts']['staged'], 1)
            self.assertEqual(dirty['counts']['untracked'], 1)
            rename = next(f for f in dirty['files'] if 'originalPath' in f)
            self.assertEqual(rename['path'], 'new\nname.txt')
            self.assertEqual(rename['originalPath'], 'old name.txt')
            self.assertEqual(clean['status'], '')
            self.assertEqual(clean['upstream'], '')
            shutil.rmtree(linked)
            missing = next(r for r in collect.worktrees(root)['rows'] if r['branch'] == 'feature')
            self.assertIn('error', missing)
            self.assertTrue(missing['prunable'])

    def test_parser_and_conflict_counts(self):
        text, counts, files = collect.parse_status(' M file a\0UU conflict\0?? new\0')
        self.assertEqual(counts, {'staged': 0, 'unstaged': 1, 'untracked': 1, 'conflicts': 1})
        self.assertEqual(len(files), 3)
        self.assertIn('file a', text)
        records = collect.parse_worktrees('worktree /repo\0HEAD abc\0detached\0locked reason\0\0')
        self.assertIn('detached', records[0])
        self.assertEqual(records[0]['locked'], 'reason')

    def test_check_states_are_not_invented(self):
        self.assertEqual(collect.checks([])[:2], ('无检查结果', 'none'))
        for data, expected in [
            ({'status': 'QUEUED'}, 'pending'),
            ({'status': 'COMPLETED', 'conclusion': 'SUCCESS'}, 'passed'),
            ({'state': 'FAILURE'}, 'failed'),
            ({'status': 'COMPLETED', 'conclusion': 'SKIPPED'}, 'completed'),
            ({}, 'unknown'),
        ]:
            self.assertEqual(collect.checks([data])[1], expected)

    def test_pr_mapping_sources_fork_and_single_scope(self):
        sample = {'number': 7, 'title': 'PR', 'url': 'https://code.example/team/repo/pull/7', 'body': 'Description',
                  'headRefName': 'topic', 'baseRefName': 'main', 'headRefOid': 'head', 'baseRefOid': 'base',
                  'author': {'login': 'dev'}, 'isDraft': False, 'state': 'OPEN', 'reviewDecision': 'APPROVED',
                  'mergeable': 'UNKNOWN', 'isCrossRepository': True, 'headRepository': {'name': 'fork'},
                  'headRepositoryOwner': {'login': 'dev'}, 'statusCheckRollup': [{'name': 'CI', 'status': 'COMPLETED', 'conclusion': 'SUCCESS', 'detailsUrl': 'https://code.example/check/1'}]}
        seen = []
        def fake(argv):
            seen.append(argv)
            if argv[0] == 'git':
                return '/example/repo\n'
            return json.dumps(sample)
        with patch.object(collect, 'run_text', fake):
            result = collect.prs('/example/repo', 'team/repo', 'code.example', number=7)
        record = result['prs'][0]
        self.assertEqual(record['id'], 'code.example/team/repo#7')
        self.assertEqual(record['headSha'], 'head')
        self.assertEqual(record['merge'], '尚未核验')
        self.assertEqual(record['review'], '已批准')
        self.assertEqual(record['checkLinks'][0]['url'], 'https://code.example/check/1')
        self.assertTrue(record['isCrossRepository'])
        self.assertEqual(result['number'], 7)
        self.assertIn('code.example/team/repo', seen[-1])
        self.assertEqual(seen[-1][1:4], ['pr', 'view', '7'])

    def test_pr_empty_capped_and_failure(self):
        def fake(value):
            return lambda argv: '/example/repo\n' if argv[0] == 'git' else json.dumps(value)
        with patch.object(collect, 'run_text', fake([])):
            self.assertEqual(collect.prs('/example/repo', 'team/repo')['prs'], [])
        with patch.object(collect, 'run_text', fake([{'number': 1}])):
            self.assertTrue(collect.prs('/example/repo', 'team/repo', limit=1)['capped'])
        def failed(argv):
            if argv[0] == 'git':
                return '/example/repo\n'
            raise RuntimeError('authentication required')
        with patch.object(collect, 'run_text', failed), self.assertRaisesRegex(RuntimeError, 'authentication'):
            collect.prs('/example/repo', 'team/repo')


if __name__ == '__main__':
    unittest.main()
