// Gives each DB test file its own migrated database so tests are order-independent and re-runnable.
// With TEST_ADMIN_DATABASE_URL (a superuser URL) a throwaway database is created and dropped; otherwise
// TEST_DATABASE_URL is migrated in place (migrations are idempotent) and left for inspection.
import {ADMIN_URL,freshDatabase} from '../../test/helpers/harness.mjs';
import {migrate} from '../../scripts/migrate.mjs';
export const available=Boolean(ADMIN_URL||process.env.TEST_DATABASE_URL);
export async function testDatabase(){
  if(process.env.TEST_ADMIN_DATABASE_URL){const db=await freshDatabase();return {url:db.url,drop:db.drop};}
  const url=process.env.TEST_DATABASE_URL;await migrate({connectionString:url});return {url,drop:async()=>{}};
}
