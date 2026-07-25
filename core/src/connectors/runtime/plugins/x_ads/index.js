import { ConnectorPlugin } from '../../connector-plugin.js';
import { makeResult, jsonContent } from '../../contracts.js';
import { NotConnectedError, classifyError } from '../../errors.js';
import { changeCampaignState, publishCampaign } from '../../../../x-ads/service.js';

function writeTool(name, description) {
  return {
    name, title: name, description,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { campaign_id: { type: 'string', format: 'uuid' }, confirmation_token: { type: 'string' } },
      required: name === 'x_ads__publish' ? ['campaign_id', 'confirmation_token'] : ['campaign_id'],
    },
    access: 'write', approval: 'required', concurrencySafe: false,
    idempotent: name !== 'x_ads__publish', destructive: false, openWorld: true,
    timeoutMs: name === 'x_ads__publish' ? 120_000 : 30_000,
    maxResultBytes: 32 * 1024, allowedSurfaces: ['dashboard'],
  };
}

export const X_ADS_MANIFEST = {
  id: 'x_ads', version: '1.0.0', displayName: 'X Ads',
  description: 'Create and control explicitly confirmed paid X campaigns',
  authProvider: 'twitter', connectionAliases: ['twitter'],
  supportedSurfaces: ['dashboard'], syncMode: 'none',
  tools: [
    writeTool('x_ads__publish', 'Publish a prepared X Ads campaign.'),
    writeTool('x_ads__pause', 'Pause an active X Ads campaign.'),
    writeTool('x_ads__resume', 'Resume a paused X Ads campaign.'),
  ],
};

export class XAdsPlugin extends ConnectorPlugin {
  constructor(deps = {}) {
    super(X_ADS_MANIFEST); this._deps = deps;
    this._publish = deps.publishCampaign || publishCampaign;
    this._changeState = deps.changeCampaignState || changeCampaignState;
  }

  async getConnection(context) {
    const prisma = context.db || this._deps.prisma;
    const row = await prisma?.nangoConnection?.findFirst({
      where: { userId: context.userId, orgId: context.orgId, providerKey: 'twitter', status: 'active' },
      select: { connectionId: true },
    });
    if (!row) throw new NotConnectedError('X Ads is not connected for this organization');
    return { connected: true, connectionId: row.connectionId };
  }

  async executeTool(toolName, input, context) {
    const prisma = context.db || this._deps.prisma;
    try {
      const common = { prisma, userId: context.userId, orgId: context.orgId, id: input.campaign_id };
      const result = toolName === 'x_ads__publish'
        ? await this._publish({ ...common, confirmationToken: input.confirmation_token })
        : await this._changeState({ ...common, action: toolName === 'x_ads__pause' ? 'pause' : 'resume' });
      return makeResult({ status: 'completed', content: jsonContent(result) });
    } catch (error) {
      throw classifyError(error);
    }
  }
}

export function createXAdsPlugin(deps = {}) { return new XAdsPlugin(deps); }
