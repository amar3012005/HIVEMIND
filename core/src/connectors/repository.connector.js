import fs from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java']);

export class RepositoryConnector {
  listCodeFiles(rootPath) {
    const files = [];

    const walk = currentPath => {
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(fullPath);
          continue;
        }
        if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(fullPath);
        }
      }
    };

    walk(rootPath);
    return files;
  }

  buildCodeMemoryRequests(rootPath, { user_id, org_id, project, repository, branch, commit_sha }) {
    return this.listCodeFiles(rootPath).map(filepath => ({
      user_id,
      org_id,
      project,
      filepath,
      content: fs.readFileSync(filepath, 'utf-8'),
      tags: ['code', 'repository'],
      source_metadata: {
        source_type: 'repository',
        source_platform: 'github',
        source_id: commit_sha || filepath,
        source_url: null
      },
      metadata: {
        repository: repository || path.basename(rootPath),
        branch: branch || null,
        commit_sha: commit_sha || null
      }
    }));
  }
}
