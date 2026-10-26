"""Opt-in real HTTPS transport comparison, not a worker/Unity benchmark.

Creates one synthetic AMIGO task, waits for completion, then alternates reads of
that same task. No audio, GPT, user room or production database is touched.
Private credentials are read from a local ignored env file and never exported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import Settings
from app.neotalk import NeoTalkClient, NeoTalkResponse


def distribution(values):
    ordered = sorted(values)
    return {'count': len(values), 'mean': statistics.mean(values),
            'p50': ordered[(len(ordered) - 1) // 2],
            'p95': ordered[min(len(ordered) - 1, __import__('math').ceil(len(ordered) * .95) - 1)],
            'max': ordered[-1]}


def run(env_file, rounds, calls):
    allowed = {'NEOTALK_API_KEY', 'NEOTALK_API_BASE_URL'}
    values = {}
    for line in Path(env_file).read_text(encoding='utf-8').splitlines():
        key, separator, value = line.partition('=')
        if separator and key.strip() in allowed:
            values[key.strip()] = value.strip().strip('"').strip("'")
    if not values.get('NEOTALK_API_KEY'):
        raise RuntimeError('Missing local integration key')
    settings = replace(Settings(), neotalk_api_key=values['NEOTALK_API_KEY'],
                       neotalk_api_base_url=values.get('NEOTALK_API_BASE_URL', Settings().neotalk_api_base_url))
    if not settings.neotalk_api_base_url.startswith('https://'):
        raise RuntimeError('Real benchmark requires TLS')
    probe = NeoTalkClient(settings)
    with probe.lifespan():
        task = probe.submit_phrase('AMIGO').payload['task_id']
        for _ in range(40):
            ready = probe.task_status(task)
            if ready.status_code == 200:
                break
            time.sleep(.3)
        else:
            raise RuntimeError('Synthetic task not ready within bounded polling')
    reference = hashlib.sha256(json.dumps(ready.payload, sort_keys=True).encode()).hexdigest()

    def legacy():
        # Same pre-change urllib GET, key, JSON limit and timeout. No pool.
        request = Request(settings.neotalk_api_base_url.rstrip('/') + '/task-status-pose/' + task,
                          headers={'Accept': 'application/json', 'x-api-key': settings.neotalk_api_key})
        with urlopen(request, timeout=settings.neotalk_api_timeout_seconds) as response:
            raw = response.read(1_048_577)
            if len(raw) > 1_048_576:
                raise RuntimeError('Oversized benchmark response')
            return NeoTalkResponse(response.status, json.loads(raw))

    report = {'kind': 'real-https-same-completed-task-transport-comparison',
              'startedAt': datetime.now(timezone.utc).isoformat(), 'roundsPerVariant': rounds,
              'callsPerRound': calls, 'samples': [], 'equivalentResponses': True,
              'limitations': ['One synthetic completed task, not representative of all workers/endpoints.',
                              'Transport implementation comparison, not full old/new release A/B.',
                              'No Unity, GPT, acoustic ASR, live room, first-frame or fluency approval.',
                              'Pool creation/close included in round time; request distribution excludes client initialization.',
                              'Sequential same-host workload; no invented TLS/worker substage timings.']}
    for index in range(rounds):
        for variant in (['urllib', 'pool'] if index % 2 == 0 else ['pool', 'urllib']):
            request_times = []
            started = time.perf_counter()
            def sample(call):
                at = time.perf_counter()
                response = call()
                request_times.append((time.perf_counter() - at) * 1000)
                same = response.status_code == 200 and hashlib.sha256(
                    json.dumps(response.payload, sort_keys=True).encode()).hexdigest() == reference
                if not same:
                    report['equivalentResponses'] = False
                    raise RuntimeError('Comparison responses changed')
            if variant == 'pool':
                client = NeoTalkClient(settings)
                with client.lifespan():
                    for _ in range(calls):
                        sample(lambda: client.task_status(task))
            else:
                for _ in range(calls):
                    sample(legacy)
            report['samples'].append({'round': index + 1, 'variant': variant,
                                      'totalMs': (time.perf_counter() - started) * 1000,
                                      'requestMs': request_times})
            print(json.dumps({'round': index + 1, 'variant': variant,
                              'totalMs': round(report['samples'][-1]['totalMs'])}), flush=True)
    report['summary'] = {variant: {
        'roundMs': distribution([r['totalMs'] for r in report['samples'] if r['variant'] == variant]),
        'requestMs': distribution([ms for r in report['samples'] if r['variant'] == variant for ms in r['requestMs']]),
    } for variant in ['urllib', 'pool']}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--rounds', type=int, default=6)
    parser.add_argument('--calls', type=int, default=3)
    args = parser.parse_args()
    if not 2 <= args.rounds <= 10 or not 2 <= args.calls <= 5:
        parser.error('Bounded experiment: rounds 2..10, calls 2..5')
    try:
        report = run(args.env_file, args.rounds, args.calls)
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'result': 'PASS', 'equivalentResponses': report['equivalentResponses'],
                          'summary': report['summary']}))
    except Exception:
        print('Benchmark failed; details suppressed to protect integration credentials.', file=sys.stderr)
        sys.exit(1)
