import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

function checkpointSchema(value) {
  const schema = String(value || 'hivemind_langgraph').trim();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('langgraph_checkpoint_schema_invalid');
  }
  return schema;
}

/** Create and migrate the official LangGraph Postgres checkpointer. */
export async function createPostgresCheckpointer({
  connectionString,
  schema = 'hivemind_langgraph',
} = {}) {
  const databaseUrl = String(connectionString || '').trim();
  if (!databaseUrl) throw new Error('langgraph_checkpoint_database_url_missing');

  const checkpointer = PostgresSaver.fromConnString(databaseUrl, {
    schema: checkpointSchema(schema),
  });
  await checkpointer.setup();

  return {
    checkpointer,
    async close() {
      await checkpointer.end();
    },
  };
}
