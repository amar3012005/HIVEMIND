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
    const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
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
