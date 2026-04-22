import { NextRequest, NextResponse } from 'next/server';
import { createHiveMindClient } from '../../../../lib/hivemind-client';

export async function GET() {
  const client = createHiveMindClient();
  if (!client) {
    return NextResponse.json({ connected: false, error: 'not_connected' }, { status: 401 });
  }

  try {
    const [status, tools] = await Promise.all([
      client.getConnectionStatus(),
      client.listTools()
    ]);

    return NextResponse.json({
      connected: true,
      workspaceId: status.workspace_id || null,
      scopes: status.scopes || [],
      tools
    });
  } catch (error) {
    return NextResponse.json({
      connected: false,
      error: error instanceof Error ? error.message : 'tool_list_failed'
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const client = createHiveMindClient();
  if (!client) {
    return NextResponse.json({ connected: false, error: 'not_connected' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name : '';
  const args = body?.arguments && typeof body.arguments === 'object' ? body.arguments : {};

  if (!name) {
    return NextResponse.json({ error: 'tool_name_required' }, { status: 400 });
  }

  try {
    const result = await client.callTool({
      name,
      arguments: args
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'tool_call_failed'
    }, { status: 500 });
  }
}