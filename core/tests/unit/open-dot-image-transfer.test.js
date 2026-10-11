import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const helper = path.join(root, 'scripts/verify-open-dot-image-archive.py');
const canonical = fs.readFileSync(path.join(root, 'scripts/release-canonical.sh'), 'utf8');
const quick = fs.readFileSync(path.join(root, 'scripts/quick-deploy.sh'), 'utf8');
const verifier = fs.readFileSync(path.join(root, 'scripts/verify-deployed.sh'), 'utf8');

test('preloaded Open Dot receipt binds source, registry digest, image ID, ref, and archive bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-dot-image-transfer-'));
  try {
    const archive = path.join(dir, 'open-dot-image.tar.gz');
    const receipt = path.join(dir, 'image-transfer-receipt.json');
    const sourceSha = 'b'.repeat(40);
    const preloadedRef = `hivemind/open-dot:transfer-${sourceSha}`;
    const config = Buffer.from('{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}');
    const imageId = `sha256:${createHash('sha256').update(config).digest('hex')}`;
    const createArchive = spawnSync('python3', ['-c', `
import io, json, sys, tarfile
archive, tag, image_id, config = sys.argv[1:]
config_bytes = config.encode()
with tarfile.open(archive, 'w:gz') as saved:
    entries = [{'Config': image_id.removeprefix('sha256:') + '.json', 'RepoTags': [tag], 'Layers': []}]
    payload = json.dumps(entries).encode()
    info = tarfile.TarInfo('manifest.json'); info.size = len(payload); saved.addfile(info, io.BytesIO(payload))
    info = tarfile.TarInfo(entries[0]['Config']); info.size = len(config_bytes); saved.addfile(info, io.BytesIO(config_bytes))
`, archive, preloadedRef, imageId, config.toString()], { encoding: 'utf8' });
    assert.equal(createArchive.status, 0, createArchive.stderr);
    const bytes = fs.readFileSync(archive);
    const expected = {
      registryImage: 'ghcr.io/amar3012005/hivemind-open-dot@sha256:' + 'a'.repeat(64),
      sourceSha,
      imageId,
      preloadedRef,
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    };
    fs.writeFileSync(receipt, JSON.stringify(expected));
    const args = ['--archive', archive, '--receipt', receipt, '--registry-image', expected.registryImage, '--source-sha', expected.sourceSha];
    const valid = spawnSync('python3', [helper, ...args], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), `${expected.preloadedRef}\t${expected.imageId}\t${expected.archiveSha256}`);

    fs.appendFileSync(archive, 'tampered');
    const tampered = spawnSync('python3', [helper, ...args], { encoding: 'utf8' });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /archive SHA256 mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical deployment loads only receipt-validated Open Dot archive and keeps registry digest label', () => {
  assert.match(canonical, /verify-open-dot-image-archive\.py/);
  assert.match(canonical, /docker load --input "\$OPEN_DOT_IMAGE_ARCHIVE"/);
  assert.match(canonical, /loaded_id=\$\(docker image inspect "\$OPEN_DOT_DEPLOY_IMAGE"/);
  assert.match(canonical, /com\.singulance\.open-dot\.image-digest: "%s"/);
  assert.match(canonical, /--open-dot-image-expected-id/);
  assert.match(quick, /--open-dot-image-archive "\$OPEN_DOT_IMAGE_ARCHIVE" --open-dot-image-receipt/);
  assert.match(verifier, /container_image_id=\$\(docker inspect "\$container" --format '\{\{\.Image\}\}'/);
});

test('OCI archive validates the manifest-based Docker load ID without an index platform hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-dot-oci-transfer-'));
  try {
    const archive = path.join(dir, 'open-dot-image.tar.gz');
    const receipt = path.join(dir, 'image-transfer-receipt.json');
    const sourceSha = 'c'.repeat(40);
    const preloadedRef = `hivemind/open-dot:transfer-${sourceSha}`;
    const layer = Buffer.from('representative uncompressed OCI rootfs layer');
    const generated = spawnSync('python3', ['-c', `
import hashlib, io, json, sys, tarfile
archive, tag, layer_hex = sys.argv[1:]
layer = bytes.fromhex(layer_hex)
layer_id = 'sha256:' + hashlib.sha256(layer).hexdigest()
config = {'architecture':'amd64','os':'linux','rootfs':{'type':'layers','diff_ids':[layer_id]}}
config_bytes = json.dumps(config, separators=(',', ':')).encode()
config_id = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
image = {'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':config_id,'size':len(config_bytes)},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar','digest':layer_id,'size':len(layer)}]}
image_bytes = json.dumps(image, separators=(',', ':')).encode()
image_id = 'sha256:' + hashlib.sha256(image_bytes).hexdigest()
index = {'schemaVersion':2,'mediaType':'application/vnd.oci.image.index.v1+json','manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':image_id,'size':len(image_bytes),'annotations':{'org.opencontainers.image.ref.name':tag.split(':',1)[1]}}]}
legacy = [{'Config':'blobs/sha256/' + config_id.removeprefix('sha256:'),'RepoTags':[tag],'Layers':['blobs/sha256/' + layer_id.removeprefix('sha256:')]}]
entries = {'manifest.json':json.dumps(legacy).encode(),'index.json':json.dumps(index).encode(),legacy[0]['Config']:config_bytes,'blobs/sha256/' + image_id.removeprefix('sha256:'):image_bytes,'blobs/sha256/' + layer_id.removeprefix('sha256:'):layer}
with tarfile.open(archive, 'w:gz') as saved:
  for name, payload in entries.items():
    info=tarfile.TarInfo(name); info.size=len(payload); saved.addfile(info, io.BytesIO(payload))
print(json.dumps({'configId':config_id,'loadedId':image_id}))
`, archive, preloadedRef, layer.toString('hex')], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const { configId, loadedId } = JSON.parse(generated.stdout);
    const bytes = fs.readFileSync(archive);
    const expected = {
      registryImage: 'ghcr.io/amar3012005/hivemind-open-dot@sha256:' + 'd'.repeat(64),
      sourceSha,
      imageId: configId,
      preloadedRef,
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    };
    fs.writeFileSync(receipt, JSON.stringify(expected));
    const args = ['--archive', archive, '--receipt', receipt, '--registry-image', expected.registryImage, '--source-sha', expected.sourceSha];
    const valid = spawnSync('python3', [helper, ...args], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), `${expected.preloadedRef}\t${loadedId}\t${expected.archiveSha256}`);

    const corrupted = spawnSync('python3', ['-c', `
import io, json, sys, tarfile
source, target = sys.argv[1:]
with tarfile.open(source, 'r:gz') as saved, tarfile.open(target, 'w:gz') as out:
  for member in saved.getmembers():
    payload = saved.extractfile(member).read() if member.isfile() else None
    if member.name == 'index.json':
      index=json.loads(payload); index['manifests'][0]['digest']='sha256:f' + index['manifests'][0]['digest'].split(':',1)[1]; payload=json.dumps(index).encode()
    info=tarfile.TarInfo(member.name); info.size=len(payload or b''); out.addfile(info, io.BytesIO(payload or b''))
`, archive, path.join(dir, 'corrupt.tar.gz')], { encoding: 'utf8' });
    assert.equal(corrupted.status, 0, corrupted.stderr);
    fs.copyFileSync(path.join(dir, 'corrupt.tar.gz'), archive);
    expected.archiveSha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(receipt, JSON.stringify(expected));
    const invalid = spawnSync('python3', [helper, ...args], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /manifest digest (mismatch|is invalid)|member is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
