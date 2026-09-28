/**
 * Every plan a draft had before it was replaced, so a bad generation or
 * refinement can be inspected and undone.
 *
 * A trigger records the outgoing plan whenever `plan_json` changes, whichever
 * writer changed it (browser handlers, background generation and refinement,
 * MCP tools, issue creation), so no write path can skip the history.
 *
 * Plan Studio autosaves manual edits a second after typing stops, so edits
 * that keep the draft's status are coalesced: while the newest snapshot is
 * itself a recent edit, the plan it led to is not recorded again. Operations
 * that change status (generation, refinement, publication) always record the
 * plan they replace, and a snapshot identical to the newest one is skipped.
 */
const MAX_REVISIONS_PER_DRAFT = 50;
const EDIT_COALESCE_MINUTES = 10;

export async function up(knex) {
  await knex.schema.createTable('task_draft_plan_revisions', (table) => {
    table.increments('revision_id').primary();
    table.string('draft_id', 255).notNullable();
    table.text('plan_json').notNullable();
    // The draft's revision while this plan was current.
    table.integer('draft_revision').notNullable();
    table.string('status_before', 50).nullable();
    table.string('status_after', 50).nullable();
    table.timestamp('replaced_at').notNullable().defaultTo(knex.fn.now());

    table.foreign('draft_id')
      .references('draft_id')
      .inTable('task_drafts')
      .onDelete('CASCADE');
    table.index(['draft_id', 'revision_id']);
  });

  await knex.raw(`CREATE TRIGGER task_drafts_plan_history AFTER UPDATE OF plan_json ON task_drafts
    WHEN OLD.plan_json IS NOT NULL AND OLD.plan_json IS NOT NEW.plan_json
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT plan_json, status_before, status_after, replaced_at FROM task_draft_plan_revisions
            WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT 1
        ) AS latest
        WHERE latest.plan_json = OLD.plan_json
          OR (OLD.status IS NEW.status
            AND latest.status_before IS latest.status_after
            AND latest.replaced_at > datetime('now', '-${EDIT_COALESCE_MINUTES} minutes'))
      )
    BEGIN
      INSERT INTO task_draft_plan_revisions (draft_id, plan_json, draft_revision, status_before, status_after, replaced_at)
        VALUES (OLD.draft_id, OLD.plan_json, OLD.mcp_revision, OLD.status, NEW.status, CURRENT_TIMESTAMP);
      DELETE FROM task_draft_plan_revisions
        WHERE draft_id = OLD.draft_id
          AND revision_id NOT IN (
            SELECT revision_id FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT ${MAX_REVISIONS_PER_DRAFT}
          );
    END`);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS task_drafts_plan_history');
  await knex.schema.dropTableIfExists('task_draft_plan_revisions');
}
