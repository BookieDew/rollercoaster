import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (table) => {
    table.uuid('id').primary();
    table.string('entity_type').notNullable();
    table.string('entity_id').notNullable();
    table.string('action').notNullable();
    table.json('payload');
    table.timestamp('timestamp').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['entity_type', 'entity_id']);
    table.index('timestamp');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
