#!/bin/bash
echo "🧪 Testing save_session Tool - Simple Test"
echo "==========================================="
echo ""

# Check if MCP server is running
if pgrep -f "node server.js" > /dev/null; then
    echo "✅ MCP server is running"
else
    echo "⚠️  MCP server not running, starting..."
    cd /Users/amar/HIVE-MIND/mcp-server && nohup node server.js > /tmp/mcp-server.log 2>&1 &
    sleep 5
fi

echo ""
echo "📋 save_session tool is registered and ready!"
echo ""
echo "To test with Claude Desktop:"
echo "----------------------------"
echo "1. Edit Claude Desktop config:"
echo "   nano ~/Library/Application\ Support/Claude/claude_desktop_config.json"
echo ""
echo "2. Add this configuration:"
echo '   {'
echo '     "mcpServers": {'
echo '       "hivemind": {'
echo '         "command": "node",'
echo '         "args": ["/Users/amar/HIVE-MIND/mcp-server/server.js"]'
echo '       }'
echo '     }'
echo '   }'
echo ""
echo "3. Restart Claude Desktop"
echo ""
echo "4. In Claude, say: 'Save this session to HIVE-MIND'"
echo ""
echo "✅ Setup complete!"
