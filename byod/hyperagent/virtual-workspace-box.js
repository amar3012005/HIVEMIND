import { Service } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'

const ID = 'org-sandbox'

function workspaceRoot() {
  const org = process.env.HIVEMIND_ORG_ID || 'default'
  const user = process.env.HIVEMIND_USER_ID || org
  const root = process.env.DSH_WORKSPACE || '/data/fs'
  const dir = path.join(root, 'org', org, 'users', user, 'workspace')
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
  return dir
}

class OrgSandboxWorkspace {
  constructor() {
    this.id = ID
    this.path = workspaceRoot()
    this.title = 'SINGULANCE'
    this.sessionIds = []
  }
  async attachSession(sessionId) {
    if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
  }
  async detachSession(sessionId) {
    this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
  }
}

export default class HivemindVirtualWorkspaceRegistry extends Service {
  constructor(ctx) {
    super(ctx, 'workspaceRegistry')
    this.entity = new OrgSandboxWorkspace()
  }
  get(id) {
    if (id === undefined || id === this.entity.id) return this.entity
    return this.entity
  }
  list() {
    return [this.entity]
  }
}
