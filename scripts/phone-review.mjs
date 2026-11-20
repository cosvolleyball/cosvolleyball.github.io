// Start a disposable practice gym. All SQL, Auth and gameplay stay on the local stack.
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {serveTeamsPreview} from './serve-teams-staging.mjs';

const root = path.resolve(import.meta.dirname, '..');
const testing = process.argv.includes('--ci');
if (testing && process.env.CI !== 'true') throw Error('--ci is reserved for the local integration workflow.');
const directory = mkdtempSync(path.join(tmpdir(), 'cos-phone-'));
const localCLI = (args, options = {}) => execFileSync('supabase',
  ['--workdir', directory, ...args], {encoding:'utf8', ...options});
let initialized = false;
let server;

function cleanUp() {
  server?.close();
  if (!initialized) return;
  initialized = false;
  try {
    localCLI(['stop', '--no-backup'], {stdio:'ignore'});
    rmSync(directory, {recursive:true, force:true});
  } catch {
    console.error('The preview stopped. To remove its temporary containers, run supabase stop --no-backup in', directory);
  }
}

function runTest(file, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {cwd:root, stdio:'inherit',
      env:{...process.env, ...environment}});
    child.once('error', reject);
    child.once('exit', code => code===0 ? resolve() : reject(Error(file+' exited with '+code)));
  });
}

async function start() {
  localCLI(['init'], {stdio:'inherit'});
  initialized = true;
  // Initialization uses a unique local project ID. An existing stack on
  // these ports causes start to fail without editing that other stack.
  const migrations = path.join(root, 'db/release/migrations');
  const releases = readdirSync(migrations).filter(name => /^\d+_.*\.sql$/.test(name)).sort()
    .map(name => readFileSync(path.join(migrations, name), 'utf8'));
  const fixture = readFileSync(path.join(root, 'db/tests/local_supabase_baseline.sql'), 'utf8');
  writeFileSync(path.join(directory, 'supabase', 'seed.sql'), ['begin;', fixture, ...releases, 'commit;'].join('\n'));
  // Keep status output in memory. The CLI prints local service credentials on success.
  console.log('Starting the practice gym. The first run downloads the local Supabase containers.');

  localCLI(['start'], {stdio:['ignore','ignore','inherit']});
  const status = localCLI(['status','-o','env']);
  const settings = Object.fromEntries(status.split('\n').flatMap(line => {
    const match = line.match(/^([A-Z_]+)="([^"]*)"$/);
    return match ? [[match[1], match[2]]] : [];
  }));
  const api = new URL(settings.API_URL);
  const database = new URL(settings.DB_URL);
  for (const address of [api, database]) {
    if (!['127.0.0.1','localhost','[::1]'].includes(address.hostname)) throw Error('The preview requires a local Supabase stack.');
  }
  if (!settings.SERVICE_ROLE_KEY || !settings.ANON_KEY) throw Error('The local preview keys are missing.');
  if (testing) {
    for (const value of [settings.DB_URL, settings.ANON_KEY, settings.SERVICE_ROLE_KEY]) console.log('::add-mask::'+value);
  }
  const email = 'organizer@phone-review.example.invalid';
  const password = testing ? process.env.TM_PREVIEW_PASSWORD : randomBytes(12).toString('base64url');
  if (!password) throw Error('A temporary organizer password is required.');
  const response = await fetch(new URL('/auth/v1/admin/users', api), {
    method:'POST',
    headers:{'Content-Type':'application/json', apikey:settings.SERVICE_ROLE_KEY,
      Authorization:'Bearer '+settings.SERVICE_ROLE_KEY},
    body:JSON.stringify({email,password,email_confirm:true})
  });
  if (!response.ok) throw Error('Local organizer account creation failed (HTTP '+response.status+').');
  const {id} = await response.json();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('The local organizer ID was invalid.');
  const seed = readFileSync(path.join(root, 'db/tests/phone_roster.sql'), 'utf8').replace('__LOCAL_ORGANIZER_UUID__', id);
  const file = path.join(directory, 'phone-roster.sql');
  writeFileSync(file, seed);
  localCLI(['db','query','--local','--file',file], {stdio:['ignore','ignore','inherit']});

  const preview = await serveTeamsPreview({api, publicKey:settings.ANON_KEY, lan:!testing});
  server = preview.server;
  console.log('Practice gym:', preview.url);
  if (testing) {
    // Only the API checks need database/admin access. Browser checks sign in through the UI.
    await runTest('db/tests/local_supabase_api.mjs', {
      API_URL:api.origin, DB_URL:settings.DB_URL, ANON_KEY:settings.ANON_KEY,
      SERVICE_ROLE_KEY:settings.SERVICE_ROLE_KEY
    });
    await runTest('tests/browser/local-event.mjs', {TM_PREVIEW_URL:preview.url});
    cleanUp();
  } else {
    console.log('On the same private Wi-Fi, open the URL in Safari and tap Organizer Login.');
    console.log('The practice email is prefilled. Temporary password:', password);
    console.log('Press Ctrl+C to close this practice gym.');
  }
}

for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {cleanUp(); process.exit(0);});
try { await start(); }
catch (error) {
  // Subprocess errors may contain CLI output. Show the recovery action without keys.
  const message = error.code === 'ENOENT' ? 'Install the Supabase CLI and start Docker, then run this command again.' :
    error.status !== undefined ? 'A local Supabase command failed. Check that Docker is running and its local ports are available.' : error.message;
  console.error(message);
  cleanUp();
  process.exitCode = 1;
}
