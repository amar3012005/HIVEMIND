#!/usr/bin/env python3
"""Source-only operator helper. Review before execution; no secrets in arguments/output."""
import argparse, copy, fcntl, json, os, pathlib, secrets, signal, subprocess, time, urllib.parse, urllib.request

def capture(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode: raise RuntimeError('private subprocess failed; output withheld')
    return result.stdout

def protected_write(path, text, stat):
    tmp = path.with_name(path.name + '.runner-role.tmp')
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.st_mode & 0o777)
    try:
        os.fchown(descriptor, stat.st_uid, stat.st_gid)
        with os.fdopen(descriptor, 'w') as file: file.write(text); file.flush(); os.fsync(file.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists(): tmp.unlink()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-image', required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.release.replace('-', '').isalnum(): raise RuntimeError('invalid release name')
    release_lock = open('/var/lock/hivemind-release.lock','a')
    fcntl.flock(release_lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(RuntimeError('operator interrupted')))
    container, service = 'hivemind-harness-runner-1', 'harness-runner'
    envf = pathlib.Path('/root/hivemind/.env')
    stat = envf.stat()
    if stat.st_mode & 0o077: raise RuntimeError('managed ENVF must be owner-only')
    old_text = envf.read_text()
    if any(line.startswith('HIVE_HARNESS_DATABASE_URL=') for line in old_text.splitlines()): raise RuntimeError('dedicated URL already configured')
    info = json.loads(capture(['docker', 'inspect', container]))[0]
    if info['Config']['Image'] != args.expected_image: raise RuntimeError('active image changed')
    actual = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
    operator_url = actual['DATABASE_URL']
    parts = urllib.parse.urlsplit(operator_url)
    if parts.hostname != 'postgres': raise RuntimeError('unexpected operator database target')
    files = info['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    base = ['docker','compose','--env-file',str(envf),'-p',info['Config']['Labels']['com.docker.compose.project'],'--profile','harness-chat']
    for file in files: base += ['-f',file]
    old = json.loads(capture(base + ['config','--format','json']))
    if old['services'][service]['image'] != args.expected_image: raise RuntimeError('compose image differs')
    for key,value in old['services'][service].get('environment',{}).items():
        if actual.get(key) != str(value): raise RuntimeError('live environment differs from complete compose chain')
    password = secrets.token_urlsafe(48)
    auth = 'hivemind_harness_runner:' + urllib.parse.quote(password, safe='')
    dedicated = urllib.parse.urlunsplit((parts.scheme, auth + '@' + parts.netloc.rsplit('@',1)[-1],parts.path,parts.query,parts.fragment))
    root = pathlib.Path('/root/releases/manifests/runner-role') / args.release
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    override = root / 'database-only.yml'
    override.write_text('services:\n  harness-runner:\n    environment:\n      DATABASE_URL: ${HIVE_HARNESS_DATABASE_URL:?Dedicated runtime database required}\n')
    candidate = base + ['-f',str(override)]
    candidate_env = dict(os.environ, HIVE_HARNESS_DATABASE_URL=dedicated)
    new = json.loads(capture(candidate + ['config','--format','json'], env=candidate_env))
    allowed = copy.deepcopy(old); allowed['services'][service].setdefault('environment',{})['DATABASE_URL']=dedicated
    if new != allowed: raise RuntimeError('candidate changes more than runner DATABASE_URL')
    source = pathlib.Path(__file__).resolve().parent
    network = next(iter(info['NetworkSettings']['Networks']))
    op = ['docker','run','--rm','-i','--network',network,'--read-only','--user','65534:65534','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--memory-swap','256m','--cpus','0.5','--pids-limit','32','--ulimit','fsize=1048576:1048576','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
        '--mount','type=bind,src='+str(source)+',dst=/source,readonly','--entrypoint','/usr/bin/env',args.expected_image,'-i','PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp','node','/source/runner-role-operator.mjs']
    def operator(action):
        payload = dict(action=action,operatorUrl=dedicated if action=='validate' else operator_url)
        if action=='provision': payload['password']=password
        return json.loads(capture(op,input=json.dumps(payload),timeout=30))
    if operator('inspect')['exists']: raise RuntimeError('dedicated role already exists')
    managed = dict(line.split('=',1) for line in old_text.splitlines() if '=' in line and not line.startswith('#'))
    secret = managed['HIVE_HARNESS_RUNNER_SERVICE_SECRET'].strip().strip('"\'')
    def native_status():
        request=urllib.request.Request('http://127.0.0.1:3080/internal/hivemind/runner-drain-status',headers={'Authorization':'Bearer '+secret})
        with urllib.request.urlopen(request,timeout=5) as response: body=json.load(response)
        if not isinstance(body.get('active_turns'),int) or body['active_turns']<0: raise RuntimeError('native recovery status unavailable')
        return body
    def idle():
        if native_status()['active_turns']!=0: raise RuntimeError('active work; cutover deferred')
    idle();time.sleep(1);idle()
    record=dict(files=files,image=args.expected_image,previousContainerId=info['Id'],databaseDeltaOnly=True,executed=False)
    protected_write(root/'release.json',json.dumps(record,indent=2)+'\n',stat)
    if not args.execute:
        print('Dry review passed: runner-only database delta; role absent; two idle observations. No mutation.');return
    backup=root/'managed-env.rollback';protected_write(backup,old_text,stat)
    before={item['Name']:item['Id'] for item in json.loads(capture(['docker','inspect',*capture(['docker','ps','-q']).split()]))}
    provision_attempted=False;configured=False
    try:
        provision_attempted=True;operator('provision')
        idle();time.sleep(1);idle()
        configured=True
        protected_write(envf,old_text.rstrip('\n')+'\nHIVE_HARNESS_DATABASE_URL='+dedicated+'\n',stat);configured=True
        capture(candidate+['up','-d','--no-deps','--force-recreate','--timeout','60',service],timeout=90)
        for _ in range(30):
            current=json.loads(capture(['docker','inspect',container]))[0]
            if current['State'].get('Health',{}).get('Status')=='healthy':break
            time.sleep(2)
        else: raise RuntimeError('runner health failed')
        if current['Config']['Image']!=args.expected_image: raise RuntimeError('runner image changed')
        current_env=dict(item.split('=',1) for item in current['Config']['Env'] if '=' in item)
        if current_env.get('DATABASE_URL')!=dedicated:raise RuntimeError('dedicated URL not active')
        after={item['Name']:item['Id'] for item in json.loads(capture(['docker','inspect',*capture(['docker','ps','-q']).split()]))}
        if any(after.get(name)!=identity for name,identity in before.items() if name!=info['Name']):raise RuntimeError('sibling changed')
        operator('validate');native_status()
        record.update(executed=True,newContainerId=current['Id'],siblingsUnchanged=True,restrictedRoleVerified=True,nativeRecoveryStatusVerified=True)
        protected_write(root/'release.json',json.dumps(record,indent=2)+'\n',stat)
        print('Runner-only restricted-role cutover healthy; image and sibling identities preserved.')
    except BaseException:
        if configured:
            protected_write(envf,old_text,stat)
            capture(base+['up','-d','--no-deps','--force-recreate','--timeout','60',service],timeout=90)
        recovery = 'dedicated role never attempted'
        if provision_attempted:
            try:
                if operator('inspect')['exists']:
                    operator('disable'); recovery = 'committed dedicated role login disabled'
                else: recovery = 'dedicated role absent after reconciliation'
            except Exception: raise RuntimeError('cutover failed; configuration recovery attempted; dedicated login revocation unconfirmed')
        raise RuntimeError('cutover failed; original protected configuration retained/restored; '+recovery)

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
