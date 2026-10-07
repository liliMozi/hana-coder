#!/usr/bin/env python3
"""Read Git worktrees or GitHub PR facts without changing the repository."""
import argparse
import datetime
import json
import pathlib
import subprocess
import sys

PR_FIELDS = 'number,title,url,body,author,isDraft,headRefName,baseRefName,headRefOid,baseRefOid,updatedAt,reviewDecision,mergeable,statusCheckRollup,changedFiles,additions,deletions,headRepository,headRepositoryOwner,isCrossRepository,state,mergedAt'


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def run_text(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'Command failed: ' + argv[0])
    return result.stdout


def git(repo, *args):
    return run_text(['git', '--no-optional-locks', '-C', str(repo), *args])


def repo_root(repo):
    return pathlib.Path(git(pathlib.Path(repo).expanduser().resolve(), 'rev-parse', '--show-toplevel').strip()).resolve()


def parse_worktrees(value):
    records, current = [], {}
    for token in value.split('\0'):
        if not token:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, content = token.partition(' ')
        current[key] = content
    if current:
        records.append(current)
    return records


def parse_status(value):
    tokens, records, index = value.split('\0'), [], 0
    counts = {'staged': 0, 'unstaged': 0, 'untracked': 0, 'conflicts': 0}
    conflicts = {'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'}
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if not token:
            continue
        if len(token) < 4 or token[2] != ' ':
            raise ValueError('Unexpected Git status record')
        status, target = token[:2], token[3:]
        record = {'status': status, 'path': target}
        if 'R' in status or 'C' in status:
            if index >= len(tokens) or not tokens[index]:
                raise ValueError('Rename/copy status is missing its original path')
            record['originalPath'] = tokens[index]
            index += 1
        records.append(record)
        if status == '??':
            counts['untracked'] += 1
        elif status in conflicts:
            counts['conflicts'] += 1
        else:
            counts['staged'] += int(status[0] != ' ')
            counts['unstaged'] += int(status[1] != ' ')
    lines = []
    for record in records:
        name = json.dumps(record['path'], ensure_ascii=False)
        if 'originalPath' in record:
            name = json.dumps(record['originalPath'], ensure_ascii=False) + ' → ' + name
        lines.append(record['status'] + ' ' + name)
    return '\n'.join(lines), counts, records


def worktrees(repo):
    root = repo_root(repo)
    rows = []
    for record in parse_worktrees(git(root, 'worktree', 'list', '--porcelain', '-z')):
        path = record.get('worktree')
        if not path:
            raise ValueError('Git returned a worktree record without its path')
        ref = record.get('branch', '')
        row = {'id': path, 'branch': ref.removeprefix('refs/heads/') if ref else '(detached)',
               'head': record.get('HEAD', ''), 'status': '', 'commits': '', 'upstream': '',
               'detached': 'detached' in record, 'locked': 'locked' in record,
               'lockReason': record.get('locked', ''), 'prunable': 'prunable' in record,
               'pruneReason': record.get('prunable', '')}
        try:
            row['status'], row['counts'], row['files'] = parse_status(git(path, 'status', '--porcelain=v1', '-z'))
            row['commits'] = git(path, 'log', '-3', '--format=%h %s').strip()
            if ref:
                upstream = git(path, 'for-each-ref', '--format=%(upstream:short)%00%(upstream:track)', ref).strip()
                row['upstream'] = ' '.join(part for part in upstream.split('\0') if part).strip()
        except (RuntimeError, ValueError, OSError, subprocess.SubprocessError, UnicodeError) as error:
            row['error'] = str(error)
        rows.append(row)
    return {'at': now(), 'repoPath': str(root), 'repoLabel': root.name, 'rows': rows}


def checks(rollup):
    if not rollup:
        return '无检查结果', 'none', []
    success, failed, pending, skipped, unknown, links = 0, 0, 0, 0, 0, []
    for check in rollup:
        state = str(check.get('state') or '').upper()
        status = str(check.get('status') or '').upper()
        conclusion = str(check.get('conclusion') or '').upper()
        if status and status != 'COMPLETED':
            category = 'pending'
        else:
            result = conclusion or state
            if result == 'SUCCESS':
                category = 'success'
            elif result in {'NEUTRAL', 'SKIPPED'}:
                category = 'skipped'
            elif result in {'FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'}:
                category = 'failed'
            elif result in {'PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'}:
                category = 'pending'
            else:
                category = 'unknown'
        success += category == 'success'
        failed += category == 'failed'
        pending += category == 'pending'
        skipped += category == 'skipped'
        unknown += category == 'unknown'
        url = check.get('detailsUrl') or check.get('targetUrl')
        if url:
            links.append({'name': check.get('name') or check.get('context') or 'CI', 'url': url,
                          'conclusion': conclusion or state or status or 'UNKNOWN'})
    label = str(success) + '/' + str(len(rollup)) + ' 通过'
    if failed:
        return label + ' · ' + str(failed) + ' 未通过', 'failed', links
    if pending:
        return label + ' · ' + str(pending) + ' 进行中', 'pending', links
    if unknown:
        return label + ' · ' + str(unknown) + ' 状态未知', 'unknown', links
    if skipped:
        return label + ' · ' + str(skipped) + ' 中性/跳过', 'completed', links
    return label, 'passed', links


def pr_record(item, host, remote):
    number = item['number']
    label, check_state, links = checks(item.get('statusCheckRollup'))
    review_decision = item.get('reviewDecision') or ''
    review = {'APPROVED': '已批准', 'CHANGES_REQUESTED': '请求修改', 'REVIEW_REQUIRED': '等待审阅', '': '尚未审阅'}.get(review_decision, review_decision)
    merge = {'MERGEABLE': '无冲突', 'CONFLICTING': '存在冲突', 'UNKNOWN': '尚未核验'}.get(item.get('mergeable'), '尚未核验')
    tone = 'pending'
    if item.get('mergedAt') or item.get('state') == 'MERGED':
        status = '已合并'
    elif item.get('state') == 'CLOSED':
        status = '已关闭'
    elif item.get('isDraft'):
        status = '草稿'
    elif check_state == 'failed':
        status, tone = '检查未通过', 'warn'
    elif review_decision == 'CHANGES_REQUESTED':
        status, tone = '请求修改', 'warn'
    elif review_decision == 'APPROVED':
        status, tone = '已批准', 'good'
    else:
        status = '待审阅'
    return {'id': host + '/' + remote + '#' + str(number), 'number': number, 'title': item.get('title', ''),
            'url': item.get('url', ''), 'body': item.get('body', ''), 'author': (item.get('author') or {}).get('login') or '未知作者',
            'isDraft': bool(item.get('isDraft')), 'branch': item.get('headRefName', ''), 'base': item.get('baseRefName', ''),
            'headSha': item.get('headRefOid', ''), 'baseSha': item.get('baseRefOid', ''), 'updatedAt': item.get('updatedAt', ''),
            'status': status, 'tone': tone, 'checks': label, 'checkState': check_state, 'checkLinks': links,
            'review': review, 'reviewDecision': review_decision, 'merge': merge,
            'files': item.get('changedFiles'), 'additions': item.get('additions'), 'deletions': item.get('deletions'),
            'headRepository': item.get('headRepository'), 'headRepositoryOwner': item.get('headRepositoryOwner'),
            'isCrossRepository': bool(item.get('isCrossRepository')), 'state': item.get('state', 'UNKNOWN')}


def prs(repo, remote, host='github.com', limit=100, number=None):
    root = repo_root(repo)
    if len(remote.split('/')) != 2 or not all(remote.split('/')):
        raise ValueError('--remote must be OWNER/REPO; pass a separate --host')
    if limit < 1 or limit > 100 or (number is not None and number < 1):
        raise ValueError('Use a limit from 1 to 100 and a positive PR number')
    target = remote if host == 'github.com' else host + '/' + remote
    argv = ['gh', 'pr', 'view', str(number)] if number is not None else ['gh', 'pr', 'list', '--state', 'open', '--limit', str(limit)]
    argv += ['--repo', target, '--json', PR_FIELDS]
    value = json.loads(run_text(argv))
    items = [value] if number is not None else value
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ValueError('GitHub returned an unexpected PR payload')
    return {'at': now(), 'repoPath': str(root), 'repoLabel': remote, 'remote': remote, 'host': host,
            'limit': limit, 'number': number, 'capped': number is None and len(items) >= limit,
            'prs': [pr_record(item, host, remote) for item in items]}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('kind', choices=['worktrees', 'prs'])
    p.add_argument('--repo', required=True)
    p.add_argument('--remote')
    p.add_argument('--host', default='github.com')
    p.add_argument('--limit', type=int, default=100)
    p.add_argument('--number', type=int)
    args = p.parse_args()
    try:
        if args.kind == 'prs' and not args.remote:
            raise ValueError('--remote is required for PR collection')
        result = worktrees(args.repo) if args.kind == 'worktrees' else prs(args.repo, args.remote, args.host, args.limit, args.number)
        print('HANA_SNAPSHOT=' + json.dumps(result, ensure_ascii=False))
        return 0
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError, UnicodeError) as error:
        print('Collection failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
