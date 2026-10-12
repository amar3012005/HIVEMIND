import importlib.util, json, pathlib, tempfile, unittest
from unittest.mock import patch

path=pathlib.Path(__file__).resolve().parents[1]/'preserve-crm-activation.py'
spec=importlib.util.spec_from_file_location('preserve_activation',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PreserveNativeAdmission(unittest.TestCase):
 def preserved(self,service,environment):
  with tempfile.TemporaryDirectory() as directory:
   output=pathlib.Path(directory)/'override.json'
   fixture=json.dumps([{'Config':{'Env':environment}}])
   with patch.object(module,'capture',return_value=fixture),patch.object(module.sys,'argv',['helper',str(output),str(pathlib.Path(directory)/'unused.env'),service]): module.main()
   self.assertEqual(output.stat().st_mode&0o777,0o600)
   return json.loads(output.read_text())['services']
 def test_approved_native_flag_survives_without_crm(self):
  self.assertEqual(self.preserved('control-plane',['HIVE_MOBILE_RUNNER_CONSENT_READY=true']),{'control-plane':{'environment':{'HIVE_MOBILE_RUNNER_CONSENT_READY':'true'}}})
 def test_missing_or_disabled_flag_is_not_enabled(self):
  for env in [[],['HIVE_MOBILE_RUNNER_CONSENT_READY=false']]: self.assertEqual(self.preserved('control-plane',env),{})
 def test_runner_does_not_inherit_control_gate(self):
  self.assertEqual(self.preserved('harness-runner',['HIVE_MOBILE_RUNNER_CONSENT_READY=true']),{})
 def test_existing_crm_and_native_flags_are_both_preserved(self):
  self.assertEqual(self.preserved('control-plane',['HIVE_APP_RUNTIME_ENABLED=true','HIVE_MOBILE_RUNNER_CONSENT_READY=true']),{'control-plane':{'environment':{'HIVE_APP_RUNTIME_ENABLED':'true','HIVE_MOBILE_RUNNER_CONSENT_READY':'true'}}})
if __name__=='__main__':unittest.main()
