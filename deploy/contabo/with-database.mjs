import { readFileSync } from 'node:fs';

// Import before either Next's server.js or the migration CLI. Never print the URL.
// URL setters percent-encode reserved characters in passwords and usernames.
const passwordFile = process.env.PGPASSWORD_FILE;
if (!passwordFile) throw new Error('PGPASSWORD_FILE is required.');
const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
if (!password) throw new Error('The database password file is empty.');
const url = new URL('postgresql://db:5432/oneshot');
url.hostname = process.env.PGHOST || 'db';
url.port = process.env.PGPORT || '5432';
url.username = encodeURIComponent(process.env.PGUSER || 'oneshot');
url.password = encodeURIComponent(password);
url.pathname = `/${encodeURIComponent(process.env.PGDATABASE || 'oneshot')}`;
process.env.DATABASE_URL = url.href;
