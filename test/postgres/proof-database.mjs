import assert from "node:assert/strict";

export async function assertProofDatabase(queryable, environmentVariable) {
  const expected = process.env[environmentVariable];
  assert.ok(expected, `${environmentVariable} must identify the disposable proof database`);
  const identity = await queryable.query("SELECT current_database() AS name");
  assert.equal(identity.rows[0]?.name, expected, `DATABASE_URL must target ${environmentVariable}`);
}
