#!/usr/bin/env python3
"""Carry approved live CRM activation into a canonical service release, privately."""
import json, os, pathlib, stat, subprocess, sys, urllib.parse

def capture(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True)

def main():
    output, env_file, services = sys.argv[1:]
    names = {'core':'hm-core', 'control-plane':'hm-control', 'harness-runner':'hivemind-harness-runner-1'}
    overrides = {}
    for service in services.split(','):
        if service not in names:
            continue
        info = json.loads(capture(['docker','inspect',names[service]]))[0]
        live = dict(x.split('=',1) for x in info['Config']['Env'] if '=' in x)
        if live.get('HIVE_APP_RUNTIME_ENABLED') != 'true':
            continue
        environment = {'HIVE_APP_RUNTIME_ENABLED':'true'}
        if service == 'core':
            secret = pathlib.Path('/root/releases/secrets/crm-core-runtime.env')
            props = secret.lstat()
            assert stat.S_ISREG(props.st_mode) and props.st_uid == 0 and stat.S_IMODE(props.st_mode) == 0o600
            lines = [x for x in secret.read_text().splitlines() if x.strip() and not x.lstrip().startswith('#')]
            key = 'HIVE_APP_RUNTIME_DATABASE_URL'
            assert len(lines) == 1 and lines[0].startswith(key+'=')
            value = lines[0].split('=',1)[1]
            assert value == live.get(key)
            url, primary = urllib.parse.urlsplit(value), urllib.parse.urlsplit(live['DATABASE_URL'])
            assert url.scheme in ('postgres','postgresql') and url.username == 'hivemind_app_runtime' and url.password and not url.fragment
            assert len(urllib.parse.unquote(url.password)) >= 32
            assert (url.hostname,url.port or 5432,url.path) == (primary.hostname,primary.port or 5432,primary.path)
            global_keys = {x.split('=',1)[0].strip() for x in pathlib.Path(env_file).read_text().splitlines() if '=' in x and not x.lstrip().startswith('#')}
            assert not {key,'HIVE_APP_RUNTIME_DATABASE_PASSWORD'} & global_keys
            environment[key] = value
        assert not live.get('HIVE_APP_RUNTIME_DATABASE_PASSWORD')
        if service != 'core':
            assert not live.get('HIVE_APP_RUNTIME_DATABASE_URL')
        overrides[service] = {'environment':environment}
    fd = os.open(output,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump({'services':overrides},stream)
    print('CRM activation preserved for: '+(','.join(overrides) or 'none'))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FATAL: CRM activation preservation failed; check managed Core-only secret and live configuration',file=sys.stderr)
        sys.exit(1)
