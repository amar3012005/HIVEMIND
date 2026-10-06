/** Canonical IDs from the installed MIT Humation 1 manifest, asset version 1.0.1. */
const PARTS = {"head":["hm1-p-000001","hm1-p-000002","hm1-p-000003","hm1-p-000004","hm1-p-000005","hm1-p-000006","hm1-p-000007","hm1-p-000008","hm1-p-000009","hm1-p-000010","hm1-p-000011","hm1-p-000012","hm1-p-000013","hm1-p-000014","hm1-p-000015","hm1-p-000016","hm1-p-000017","hm1-p-000018","hm1-p-000019","hm1-p-000020","hm1-p-000021","hm1-p-000022","hm1-p-000023","hm1-p-000024"],"body":["hm1-p-000025","hm1-p-000026","hm1-p-000027","hm1-p-000028","hm1-p-000029","hm1-p-000030","hm1-p-000031","hm1-p-000032"],"bottom":["hm1-p-000033","hm1-p-000034","hm1-p-000035","hm1-p-000036","hm1-p-000037","hm1-p-000038","hm1-p-000039","hm1-p-000040"],"item":["hm1-p-000041","hm1-p-000042","hm1-p-000043","hm1-p-000044","hm1-p-000045","hm1-p-000046","hm1-p-000047","hm1-p-000048","hm1-p-000049","hm1-p-000050","hm1-p-000051","hm1-p-000052","hm1-p-000053","hm1-p-000054","hm1-p-000055","hm1-p-000070","hm1-p-000071","hm1-p-000072","hm1-p-000073","hm1-p-000074","hm1-p-000075","hm1-p-000076","hm1-p-000077","hm1-p-000078","hm1-p-000079","hm1-p-000080","hm1-p-000081","hm1-p-000082","hm1-p-000083","hm1-p-000084","hm1-p-000085","hm1-p-000086","hm1-p-000059","hm1-p-000060","hm1-p-000061","hm1-p-000062","hm1-p-000063","hm1-p-000064","hm1-p-000065","hm1-p-000066","hm1-p-000067","hm1-p-000068","hm1-p-000069"],"glasses":["hm1-p-000056","hm1-p-000057","hm1-p-000058"]};
export function validateEmployeeAppearance(value) {
  if (value == null) return null;
  const fail = () => { throw Object.assign(new Error('invalid_employee_appearance'), {status:400}); };
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version','provider','template','asset_version','seed','selections','colors','background','crop'].includes(key))
    || value.version !== 1 || value.provider !== 'humation' || value.template !== 'humation-1'
    || value.asset_version !== '1.0.1' || value.crop !== 'avatar'
    || typeof value.seed !== 'string' || !value.seed.trim() || value.seed.length > 160) fail();
  if (!value.selections || typeof value.selections !== 'object' || Array.isArray(value.selections)
    || Object.keys(value.selections).length !== 5) fail();
  const selections = {};
  for (const [slot, ids] of Object.entries(PARTS)) {
    if (!ids.includes(value.selections[slot])) fail();
    selections[slot] = value.selections[slot];
  }
  const colorKeys = ['stroke','hair','skin','clothes','bottom'];
  if (!value.colors || typeof value.colors !== 'object' || Array.isArray(value.colors)
    || Object.keys(value.colors).length !== colorKeys.length) fail();
  const colors = {};
  for (const key of colorKeys) {
    if (typeof value.colors[key] !== 'string' || !/^[0-9a-f]{6}$/i.test(value.colors[key])) fail();
    colors[key] = value.colors[key].toUpperCase();
  }
  if (value.background !== 'transparent' && (typeof value.background !== 'string' || !/^[0-9a-f]{6}$/i.test(value.background))) fail();
  return {version:1,provider:'humation',template:'humation-1',asset_version:'1.0.1',seed:value.seed,
    selections,colors,background:value.background==='transparent'?'transparent':value.background.toUpperCase(),crop:'avatar'};
}
