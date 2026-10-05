import copy, importlib.util, json, pathlib, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('cutover',pathlib.Path(__file__).with_name('runner-role-cutover.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CutoverTests(unittest.TestCase):
 def run_case(self,execute=False,active=False,extra=False,health=True,sibling=True,ambiguous=False,ambiguous_absent=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);env=root/'env';env.write_text('HIVE_HARNESS_RUNNER_SERVICE_SECRET=fixture\n');env.chmod(0o600)
   original_path=type(root)
   def path(value):
    text=str(value)
    if text=='/root/hivemind/.env':return env
    if text=='/root/releases/manifests/runner-role':return root/'manifest'
    return original_path(value)
   actual={'DATABASE_URL':'postgresql://shared:fixture@postgres:5432/db?schema=hivemind'}
   info={'Id':'old','Name':'/runner','Config':{'Image':'fixture:image','Env':[f'{k}={v}' for k,v in actual.items()], 'Labels':{'com.docker.compose.project.config_files':'base.yml,previous.yml','com.docker.compose.project':'fixture'}},'NetworkSettings':{'Networks':{'fixture':{}}},'State':{'Health':{'Status':'healthy'}}}
   old={'services':{'harness-runner':{'image':'fixture:image','environment':actual},'core':{'image':'core:image'}}};actions=[];up=[];state={'changed':False}
   def capture(cmd,**kw):
    if cmd[:2]==['docker','run']:
     action=json.loads(kw['input'])['action'];actions.append(action)
     if action=='inspect':return json.dumps({'exists': 'provision' in actions and not ambiguous_absent})
     if action=='provision' and ambiguous:raise RuntimeError('ambiguous operator timeout')
     return '{}'
    if 'config' in cmd:
     value=copy.deepcopy(old)
     if any(str(x).endswith('database-only.yml') for x in cmd):
      value['services']['harness-runner']['environment']['DATABASE_URL']=kw.get('env',{}).get('HIVE_HARNESS_DATABASE_URL','dedicated')
      if extra:value['services']['core']['image']='changed'
     return json.dumps(value)
    if 'up' in cmd:
     up.append(cmd);state['changed']=any(str(x).endswith('database-only.yml') for x in cmd);return ''
    if cmd[:3]==['docker','ps','-q']:return 'runner core'
    if cmd[:2]==['docker','inspect']:
     if len(cmd)>3:return json.dumps([{'Name':'/runner','Id':'new' if state['changed'] else 'old'},{'Name':'/core','Id':'core-old' if sibling or not state['changed'] else 'core-new'}])
     value=copy.deepcopy(info)
     if state['changed']:
      value['Id']='new';value['State']['Health']['Status']='healthy' if health else 'unhealthy';value['Config']['Env']=['DATABASE_URL='+env.read_text().split('HIVE_HARNESS_DATABASE_URL=')[-1].strip()]
     return json.dumps([value])
    raise AssertionError(cmd)
   class Response:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self):return json.dumps({'active_turns':1 if active else 0}).encode()
   args=['cutover','--expected-image','fixture:image','--release','test']+(['--execute'] if execute else [])
   with patch.object(module.pathlib,'Path',side_effect=path),patch.object(module,'capture',side_effect=capture),patch.object(module.urllib.request,'urlopen',return_value=Response()),patch.object(module.time,'sleep'),patch.object(module.fcntl,'flock'),patch.object(module,'open',create=True),patch('sys.argv',args):
    try:module.main();error=None
    except Exception as failure:error=str(failure)
   return actions,up,env.read_text(),error
 def test_dry_run_only_database_delta(self):
  actions,up,_,error=self.run_case();self.assertIsNone(error);self.assertEqual(actions,['inspect']);self.assertEqual(up,[])
 def test_rejects_non_database_delta(self):self.assertIn('more than',self.run_case(extra=True)[3])
 def test_active_turn_defers(self):self.assertIn('active work',self.run_case(active=True)[3])
 def test_health_failure_restores_original_chain_and_env(self):
  actions,up,env,error=self.run_case(execute=True,health=False);self.assertEqual(actions[-1],'disable');self.assertEqual(len(up),2);self.assertNotIn('HIVE_HARNESS_DATABASE_URL',env);self.assertTrue(error)
 def test_sibling_change_rolls_back(self):self.assertTrue(self.run_case(execute=True,sibling=False)[3])
 def test_ambiguous_provision_reconciles_disable(self):
  actions,up,env,error=self.run_case(execute=True,ambiguous=True);self.assertEqual(actions[-1],'disable');self.assertEqual(up,[]);self.assertNotIn('HIVE_HARNESS_DATABASE_URL',env);self.assertTrue(error)
 def test_ambiguous_absent_role_is_reported(self):
  actions,_,_,error=self.run_case(execute=True,ambiguous=True,ambiguous_absent=True);self.assertNotIn('disable',actions);self.assertIn('role absent',error)
 def test_success_preserves_siblings_and_validates_role(self):
  actions,up,env,error=self.run_case(execute=True);self.assertIsNone(error);self.assertEqual(actions[-1],'validate');self.assertEqual(len(up),1);self.assertIn('HIVE_HARNESS_DATABASE_URL',env)
if __name__=='__main__':unittest.main()
