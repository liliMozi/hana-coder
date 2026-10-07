#!/usr/bin/env python3
"""Run one explicitly selected argv in its fixed directory and report its outcome."""
import argparse
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile

OUTPUT_LIMIT = 12000


def run(argv, cwd, timeout=300):
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and '\x00' not in a for a in argv):
        raise ValueError('argv must be a nonempty array of strings')
    directory = pathlib.Path(cwd).expanduser().resolve()
    if not directory.is_dir():
        raise ValueError('Working directory does not exist')
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(argv, cwd=str(directory), stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            code, error = result.returncode, None
        except subprocess.TimeoutExpired:
            code, error = None, 'Command exceeded the configured timeout'
        output.seek(0, 2)
        size = output.tell()
        output.seek(0)
        text = output.read(OUTPUT_LIMIT).decode('utf-8', errors='replace')
    return {'exitCode': code, 'output': text, 'outputTruncated': size > OUTPUT_LIMIT,
            'error': error, 'finishedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds')}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cwd', required=True)
    p.add_argument('--argv-json', required=True)
    p.add_argument('--timeout', type=int, default=300)
    a = p.parse_args()
    try:
        result = run(json.loads(a.argv_json), a.cwd, a.timeout)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        result = {'exitCode': None, 'output': '', 'outputTruncated': False, 'error': str(error),
                  'finishedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds')}
    print('HANA_COMMAND_RESULT=' + json.dumps(result, ensure_ascii=False))
    return 0 if result['exitCode'] == 0 and not result['error'] else 1


if __name__ == '__main__':
    sys.exit(main())
