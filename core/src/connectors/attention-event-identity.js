import {createHash} from 'node:crypto';
/** Cross-transport identity only when upstream Slack provenance is complete. */
export function attentionEventIdentity(toolkit,data,orgId,userId,fallback) {
 if(toolkit!=='slack')return fallback;
 const team=data.team_id??data.team?.id,channel=data.channel_id??data.channel?.id??data.channel,ts=data.message_ts??data.message_timestamp??data.ts;
 if(typeof team!=='string'||typeof channel!=='string'||(!['string','number'].includes(typeof ts)))return fallback;
 return 'slack:'+createHash('sha256').update(JSON.stringify([orgId,userId,team,channel,String(ts),String(data.activity_type??data.event_type??'message'),String(data.subtype??''),data.reaction??''])).digest('hex');
}
