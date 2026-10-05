import copy,importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('consolidation',pathlib.Path(__file__).with_name('consolidate-runner-compose.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ConsolidationTests(unittest.TestCase):
 def run_case(self,execute=False,active=False,delta=False,inline=False,health=True,sibling=True):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);env=root/'env';env.write_text('HIVE_HARNESS_RUNNER_SERVICE_SECRET=fixture\n');env.chmod(0o600)
   source=root/'base.yml';source.write_text('services: {}\n');overlay=root/'overlay.yml';overlay.write_text('services: {}\n')
   real_path=type(root)
   def path(value):
    if str(value)=='/root/hivemind/.env':return env
    if str(value)=='/root/releases/manifests/compose-consolidation':return root/'manifest'
    return real_path(value)
   raw={'services':{'harness-runner':{'image':'fixture:image','environment':{'DATABASE_URL':'${HIVE_HARNESS_DATABASE_URL}'}},'core':{'image':'core:image'}}}
   if inline:raw['services']['harness-runner']['environment']['API_KEY']='literal-secret'
   actual={'DATABASE_URL':'postgresql://fixture:fixture@postgres:5432/db'}
   resolved=copy.deepcopy(raw);resolved['services']['harness-runner']['environment']=actual
   info={'Id':'old','Name':'/runner','Mounts':[],'HostConfig':{'PortBindings':{}},'Config':{'Image':'fixture:image','Env':[f'{k}={v}' for k,v in actual.items()],'Labels':{'com.docker.compose.project.config_files':str(source)+','+str(overlay),'com.docker.compose.project':'fixture'}},'NetworkSettings':{'Networks':{'fixture':{}}},'State':{'Health':{'Status':'healthy'}}}
   state={'changed':False,'managed':None};ups=[]
   def capture(cmd):
    if 'config' in cmd:
     value=copy.deepcopy(raw if '--no-interpolate' in cmd else resolved)
     if delta and any(str(x).endswith('managed-compose.json') for x in cmd) and '--no-interpolate' not in cmd:value['services']['core']['image']='different'
     return json.dumps(value)
    if 'up' in cmd:
     ups.append(cmd);state['changed']=any(str(x).endswith('managed-compose.json') for x in cmd)
     state['managed']=next((str(x) for x in cmd if str(x).endswith('managed-compose.json')),None);return ''
    if cmd[:3]==['docker','ps','-q']:return 'runner core'
    if cmd[:2]==['docker','inspect']:
     if len(cmd)>3:return json.dumps([{'Name':'/runner','Id':'new' if state['changed'] else 'old'},{'Name':'/core','Id':'core-old' if sibling or not state['changed'] else 'core-new'}])
     current=copy.deepcopy(info)
     if state['changed']:
      current['Id']='new';current['Config']['Labels']['com.docker.compose.project.config_files']=state['managed'];current['State']['Health']['Status']='healthy' if health else 'unhealthy'
     return json.dumps([current])
    raise AssertionError(cmd)
   class Response:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self):return json.dumps({'active_turns':1 if active else 0}).encode()
   args=['consolidation','--expected-image','fixture:image','--release','fixture']+(['--execute'] if execute else [])
   with patch.object(module.pathlib,'Path',side_effect=path),patch.object(module,'capture',side_effect=capture),patch.object(module.urllib.request,'urlopen',return_value=Response()),patch.object(module.time,'sleep'),patch.object(module.fcntl,'flock'),patch.object(module,'open',create=True),patch('sys.argv',args):
    try:module.main();error=None
    except Exception as failure:error=str(failure)
   persisted=''.join(p.read_text() for p in (root/'manifest').rglob('managed-compose.json')) if (root/'manifest').exists() else ''
   return error,ups,persisted,env.read_text()
 def test_dry_equivalence_keeps_interpolation(self):
  error,ups,text,_=self.run_case();self.assertIsNone(error);self.assertEqual(ups,[]);self.assertIn('${HIVE_HARNESS_DATABASE_URL}',text);self.assertNotIn('fixture:fixture',text)
 def test_secret_literal_rejected(self):self.assertIn('credential',self.run_case(inline=True)[0])
 def test_resolved_delta_rejected(self):self.assertIn('differs',self.run_case(delta=True)[0])
 def test_active_turn_deferred(self):self.assertIn('Active work',self.run_case(active=True)[0])
 def test_health_rollback_uses_original_chain(self):
  error,ups,_,env=self.run_case(execute=True,health=False);self.assertTrue(error);self.assertEqual(len(ups),2);self.assertFalse(any(str(x).endswith('managed-compose.json') for x in ups[-1]));self.assertEqual(env,'HIVE_HARNESS_RUNNER_SERVICE_SECRET=fixture\n')
 def test_success_preserves_siblings(self):
  error,ups,_,_=self.run_case(execute=True);self.assertIsNone(error);self.assertEqual(len(ups),1);self.assertIn('--no-deps',ups[0])
 def test_sibling_change_rolls_back(self):self.assertTrue(self.run_case(execute=True,sibling=False)[0])
if __name__=='__main__':unittest.main()
