#!/usr/bin/env python3
"""Consolidate the existing native Compose chain; secrets remain in managed ENVF."""
import argparse, copy, fcntl, hashlib, json, os, pathlib, re, subprocess, time, urllib.request

def capture(args):
    result=subprocess.run(args,text=True,capture_output=True,timeout=90)
    if result.returncode:raise RuntimeError('Compose/operator call failed; private output withheld')
    return result.stdout

def protected_file(path,text,owner):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as file:
        os.fchown(file.fileno(),owner.st_uid,owner.st_gid);file.write(text);file.flush();os.fsync(file.fileno())

def no_inline_secrets(model):
    for service in model.get('services',{}).values():
        for key,value in service.get('environment',{}).items():
            if value is None:continue
            if re.search(r'(PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL)$',key) and str(value) and '${' not in str(value):
                raise RuntimeError('Unmanaged literal credential in source Compose; refusing to persist it')
    def scan(value):
        if isinstance(value,dict):
            for item in value.values():scan(item)
        elif isinstance(value,list):
            for item in value:scan(item)
        elif isinstance(value,str) and re.search(r'\w+://[^/\s]*:[^/\s]*@',value) and '${' not in value:
            raise RuntimeError('Literal credential URL in source Compose')
    scan(model)

def normalize_paths(raw,project_dir):
    # Resolve static relative paths only. Variable-bearing paths retain the explicit original project anchor.
    def absolute(value):
        if isinstance(value,str) and '${' not in value and not pathlib.Path(value).is_absolute():return os.path.normpath(str(pathlib.Path(project_dir)/value))
        return value
    for service in raw.get('services',{}).values():
        build=service.get('build')
        if isinstance(build,dict) and 'context' in build:build['context']=absolute(build['context'])
        for volume in service.get('volumes',[]):
            if isinstance(volume,dict) and volume.get('type')=='bind':volume['source']=absolute(volume['source'])
        for item in service.get('env_file',[]):
            if isinstance(item,dict) and 'path' in item:item['path']=absolute(item['path'])
        for key in ['extends']:
            if isinstance(service.get(key),dict) and 'file' in service[key]:service[key]['file']=absolute(service[key]['file'])
    for category in ['configs','secrets']:
        for item in raw.get(category,{}).values():
            if isinstance(item,dict) and 'file' in item:item['file']=absolute(item['file'])

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--expected-image',required=True);parser.add_argument('--release',required=True);parser.add_argument('--execute',action='store_true');args=parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9-]+',args.release):raise RuntimeError('Invalid release name')
    lock=open('/var/lock/hivemind-release.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    envf=pathlib.Path('/root/hivemind/.env');owner=envf.stat()
    if owner.st_mode&0o077:raise RuntimeError('Managed ENVF must remain owner-only')
    envtext=envf.read_text();envhash=hashlib.sha256(envtext.encode()).hexdigest()
    info=json.loads(capture(['docker','inspect','hivemind-harness-runner-1']))[0]
    if info['Config']['Image']!=args.expected_image:raise RuntimeError('Runner image drift')
    labels=info['Config']['Labels'];files=labels['com.docker.compose.project.config_files'].split(',')
    project_dir=labels.get('com.docker.compose.project.working_dir') or str(pathlib.Path(files[0]).parent)
    prefix=['docker','compose','--env-file',str(envf),'-p',labels['com.docker.compose.project'],'--project-directory',project_dir]
    original=prefix+['--profile','harness-chat']
    for path in files:original+=['-f',path]
    raw_command=prefix+['--profile','*']
    for path in files:raw_command+=['-f',path]
    raw=json.loads(capture(raw_command+['config','--no-interpolate','--no-env-resolution','--no-path-resolution','--no-consistency','--format','json']))
    no_inline_secrets(raw)
    normalize_paths(raw,project_dir)
    root=pathlib.Path('/root/releases/manifests/compose-consolidation')/args.release;root.mkdir(parents=True,exist_ok=False,mode=0o700)
    managed=root/'managed-compose.json';protected_file(managed,json.dumps(raw,indent=2)+'\n',owner)
    candidate=prefix+['--profile','harness-chat','-f',str(managed)]
    raw_candidate=prefix+['--profile','*','-f',str(managed)]
    reread=json.loads(capture(raw_candidate+['config','--no-interpolate','--no-env-resolution','--no-path-resolution','--no-consistency','--format','json']))
    if raw!=reread:raise RuntimeError('All-profile raw Compose equivalence failed')
    old=json.loads(capture(original+['config','--format','json']));new=json.loads(capture(candidate+['config','--format','json']))
    if old!=new:raise RuntimeError('Resolved full Compose configuration differs')
    if old['services']['harness-runner']['image']!=args.expected_image:raise RuntimeError('Source image differs from live runner')
    actual=dict(x.split('=',1) for x in info['Config']['Env'] if '=' in x)
    for key,value in old['services']['harness-runner'].get('environment',{}).items():
        if actual.get(key)!=str(value):raise RuntimeError('Live runner environment differs from complete source chain')
    managedenv=dict(x.split('=',1) for x in envtext.splitlines() if '=' in x and not x.startswith('#'))
    secret=managedenv['HIVE_HARNESS_RUNNER_SERVICE_SECRET'].strip().strip('"\'')
    def status():
        request=urllib.request.Request('http://127.0.0.1:3080/internal/hivemind/runner-drain-status',headers={'Authorization':'Bearer '+secret})
        with urllib.request.urlopen(request,timeout=5) as response:result=json.load(response)
        if not isinstance(result.get('active_turns'),int) or result['active_turns']<0:raise RuntimeError('Native recovery status unavailable')
        return result
    def idle():
        if status()['active_turns']!=0:raise RuntimeError('Active work; consolidation deferred')
    idle();time.sleep(1);idle()
    record={'originalFiles':files,'managedFile':str(managed),'image':args.expected_image,'previousContainerId':info['Id'],'allProfilesRawEquivalent':True,'resolvedConfigEquivalent':True,'executed':False}
    protected_file(root/'review.json',json.dumps(record,indent=2)+'\n',owner)
    if not args.execute:
        print('Consolidation dry review passed: one managed config, exact equivalence, no credentials persisted.');return
    protected_file(root/'managed-env.rollback',envtext,owner)
    snapshots=root/'original-chain';snapshots.mkdir(mode=0o700)
    for index,path in enumerate(files):protected_file(snapshots/f'{index}.compose',pathlib.Path(path).read_text(),owner)
    before={x['Name']:x['Id'] for x in json.loads(capture(['docker','inspect',*capture(['docker','ps','-q']).split()]))}
    attempted=False
    try:
        if hashlib.sha256(envf.read_bytes()).hexdigest()!=envhash:raise RuntimeError('Managed configuration changed during review')
        idle();time.sleep(1);idle();attempted=True
        capture(candidate+['up','-d','--no-deps','--force-recreate','--timeout','60','harness-runner'])
        for _ in range(30):
            current=json.loads(capture(['docker','inspect','hivemind-harness-runner-1']))[0]
            if current['State'].get('Health',{}).get('Status')=='healthy':break
            time.sleep(2)
        else:raise RuntimeError('Runner health failed')
        if current['Config']['Image']!=args.expected_image or dict(x.split('=',1) for x in current['Config']['Env'])!=dict(x.split('=',1) for x in info['Config']['Env']):raise RuntimeError('Runner image or environment changed')
        if current['Mounts']!=info['Mounts']:raise RuntimeError('Runner mounts changed')
        if current['HostConfig']['PortBindings']!=info['HostConfig']['PortBindings']:raise RuntimeError('Runner ingress changed')
        if set(current['NetworkSettings']['Networks'])!=set(info['NetworkSettings']['Networks']):raise RuntimeError('Runner networks changed')
        if current['Config']['Labels']['com.docker.compose.project.config_files']!=str(managed):raise RuntimeError('Runner labels did not consolidate')
        after={x['Name']:x['Id'] for x in json.loads(capture(['docker','inspect',*capture(['docker','ps','-q']).split()]))}
        if any(after.get(name)!=identity for name,identity in before.items() if name!=info['Name']):raise RuntimeError('Sibling identity changed')
        status()
        protected_file(root/'complete.json',json.dumps(dict(record,executed=True,newContainerId=current['Id'],siblingsUnchanged=True),indent=2)+'\n',owner)
        print('Consolidation complete; image/environment/mounts/networks/ingress and siblings preserved.')
    except BaseException:
        if attempted:capture(original+['up','-d','--no-deps','--force-recreate','--timeout','60','harness-runner'])
        raise RuntimeError('Consolidation failed; original chain restored where recreation was attempted; ENVF unchanged')

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
