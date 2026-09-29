export async function up(knex) {
  await knex.schema.alterTable('mcp_operations', table => {
    table.string('lifecycle', 16).notNullable().defaultTo('accepted');
    table.bigInteger('accepted_at').nullable();
    table.bigInteger('started_at').nullable();
    table.bigInteger('finished_at').nullable();
    table.json('failure').nullable();
    table.json('artifacts').notNullable().defaultTo('{}');
    table.json('progress').nullable();
    table.index(['owner_id', 'grant_id', 'accepted_at'], 'mcp_operations_owner_grant_accepted_idx');
  });

  await knex.raw(`UPDATE mcp_operations SET
    lifecycle = CASE
      WHEN state IN ('running', 'accepted', 'posted', 'queued', 'browser_required') THEN 'accepted'
      WHEN state IN ('completed', 'failed', 'cancelled') THEN state
      ELSE 'unknown'
    END,
    accepted_at = created_at,
    finished_at = CASE WHEN state IN ('completed', 'failed', 'cancelled') THEN updated_at ELSE NULL END,
    failure = CASE
      WHEN result IS NOT NULL AND json_valid(result) THEN json_extract(result, '$.error')
      ELSE NULL
    END,
    artifacts = '{}'`);
}

export async function down(knex) {
  await knex.schema.alterTable('mcp_operations', table => {
    table.dropIndex([], 'mcp_operations_owner_grant_accepted_idx');
    table.dropColumns('lifecycle', 'accepted_at', 'started_at', 'finished_at', 'failure', 'artifacts', 'progress');
  });
}
