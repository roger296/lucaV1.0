import type { Knex } from 'knex';

// ---------------------------------------------------------------------------
// Make client_secret_hash nullable to support RFC 7591 public clients.
// Public clients (token_endpoint_auth_method: "none", e.g. Claude's MCP
// connector) do not have a client secret — PKCE is their proof of identity.
// ---------------------------------------------------------------------------

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('oauth_clients', (t) => {
    t.string('client_secret_hash').nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Revert: set any null hashes to a placeholder before re-adding NOT NULL
  await knex('oauth_clients')
    .whereNull('client_secret_hash')
    .update({ client_secret_hash: 'REVOKED' });

  await knex.schema.alterTable('oauth_clients', (t) => {
    t.string('client_secret_hash').notNullable().alter();
  });
}
