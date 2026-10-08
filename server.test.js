import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import sharp from 'sharp';
import test from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, url) {
  let output = '';
  let timeout;
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('listening on port')) resolve();
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited (${code}): ${output}`)));
  });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15_000);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const response = await fetch(`${url}/api/health`);
  assert.deepEqual(await response.json(), { ok: true });
}

test('API enforces same-origin access, records votes privately, and deletes expired resumes', async (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-roast-test-'));
  const dataDir = path.join(temporaryRoot, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(temporaryRoot, 'backup');
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      UPLOAD_DIR: uploadDir,
      BACKUP_DIR: backupDir,
      PUBLIC_ORIGIN: origin,
      TRUST_PROXY: '0',
      REQUIRE_LOGIN: '0',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitForServer(child, origin);

  for (const url of ['/server.js', '/package.json', '/.env.example']) {
    assert.equal((await fetch(`${origin}${url}`)).status, 404);
  }

  const liveResponse = await fetch(`${origin}/api/live`);
  const cookie = liveResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  assert.match(liveResponse.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.deepEqual(await liveResponse.json(), { resume: null, queued: false });
  const authStatus = await fetch(`${origin}/api/auth/status`);
  assert.deepEqual(await authStatus.json(), { loginRequired: false, googleEnabled: false, user: null });

  const crossOriginResponse = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(crossOriginResponse.status, 403);

  const imageBuffer = await sharp({
    create: { width: 80, height: 120, channels: 3, background: '#f2f0e8' },
  }).png().toBuffer();
  async function uploadResume(label) {
    const form = new FormData();
    form.append('resume', new Blob([imageBuffer], { type: 'image/png' }), 'resume.png');
    form.append('label', label);
    return fetch(`${origin}/api/uploads`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
  }

  const firstUpload = await uploadResume('SWE intern');
  assert.equal(firstUpload.status, 201);
  assert.equal((await firstUpload.json()).queued, false);
  const firstLiveResponse = await fetch(`${origin}/api/live`, { headers: { Cookie: cookie } });
  const firstLive = await firstLiveResponse.json();
  assert.equal(firstLive.resume.label, 'SWE intern');
  assert.equal('counts' in firstLive.resume, false);

  const liveImage = await fetch(`${origin}/api/live/image`);
  assert.equal(liveImage.status, 200);
  assert.match(liveImage.headers.get('cache-control'), /no-store/);
  assert.equal(liveImage.headers.get('content-type'), 'image/jpeg');

  const voteResponse = await fetch(`${origin}/api/votes`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction: 'respect' }),
  });
  assert.equal(voteResponse.status, 200);
  const voteResult = await voteResponse.json();
  assert.equal(voteResult.resume.viewerReaction, 'respect');
  assert.equal('counts' in voteResult.resume, false);
  const duplicateVote = await fetch(`${origin}/api/votes`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction: 'shit' }),
  });
  assert.equal(duplicateVote.status, 409);

  const reportResponse = await fetch(`${origin}/api/reports`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'private-info' }),
  });
  assert.equal(reportResponse.status, 200);

  const databasePath = path.join(dataDir, 'resume-roast.sqlite');
  let database = new Database(databasePath);
  const firstResume = database.prepare("SELECT * FROM resumes WHERE label = 'SWE intern'").get();
  database.prepare('UPDATE resumes SET expires_at = ? WHERE id = ?')
    .run(Date.now() + 29 * 60 * 1000, firstResume.id);
  database.close();
  const unlockedResponse = await fetch(`${origin}/api/live`, { headers: { Cookie: cookie } });
  const unlocked = await unlockedResponse.json();
  assert.equal(unlocked.resume.resultsVisible, true);
  assert.deepEqual(unlocked.resume.counts, { shit: 0, mid: 0, respect: 1, total: 1 });

  const secondUpload = await uploadResume('Backend engineer');
  assert.equal(secondUpload.status, 201);
  assert.equal((await secondUpload.json()).queued, true);

  database = new Database(databasePath);
  const secondResume = database.prepare("SELECT * FROM resumes WHERE label = 'Backend engineer'").get();
  database.prepare('UPDATE resumes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, firstResume.id);
  database.close();

  const nextLiveResponse = await fetch(`${origin}/api/live`, { headers: { Cookie: cookie } });
  const nextLive = await nextLiveResponse.json();
  assert.equal(nextLive.resume.id, secondResume.id);
  assert.equal(nextLive.resume.viewerReaction, null);

  const verifyDatabase = new Database(databasePath, { readonly: true });
  assert.equal(verifyDatabase.prepare('SELECT 1 FROM resumes WHERE id = ?').get(firstResume.id), undefined);
  assert.equal(verifyDatabase.prepare('SELECT 1 FROM votes WHERE resume_id = ?').get(firstResume.id), undefined);
  assert.equal(verifyDatabase.prepare('SELECT 1 FROM reports WHERE resume_id = ?').get(firstResume.id), undefined);
  verifyDatabase.close();
  assert.equal(fs.existsSync(path.join(uploadDir, firstResume.image_name)), false);

  let snapshotDatabase;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshotPath = path.join(backupDir, 'latest', 'resume-roast.sqlite');
    if (fs.existsSync(snapshotPath)) {
      snapshotDatabase = new Database(snapshotPath, { readonly: true });
      const found = snapshotDatabase.prepare('SELECT 1 FROM resumes WHERE id = ?').get(secondResume.id);
      if (found) break;
      snapshotDatabase.close();
      snapshotDatabase = null;
    }
    await delay(50);
  }
  assert.ok(snapshotDatabase, 'expected a refreshed backup snapshot');
  assert.equal(snapshotDatabase.prepare('SELECT 1 FROM resumes WHERE id = ?').get(firstResume.id), undefined);
  snapshotDatabase.close();
  assert.equal(fs.existsSync(path.join(backupDir, 'latest', 'uploads', firstResume.image_name)), false);
});

test('login can be required and authenticated accounts are limited to one upload per 30 days', async (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-roast-auth-test-'));
  const dataDir = path.join(temporaryRoot, 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      UPLOAD_DIR: uploadDir,
      PUBLIC_ORIGIN: origin,
      REQUIRE_LOGIN: '1',
      TRUST_PROXY: '0',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitForServer(child, origin);

  const statusResponse = await fetch(`${origin}/api/auth/status`);
  assert.deepEqual(await statusResponse.json(), {
    loginRequired: true,
    googleEnabled: false,
    user: null,
  });
  assert.equal((await fetch(`${origin}/api/auth/google`)).status, 503);

  const unauthenticatedVote = await fetch(`${origin}/api/votes`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction: 'respect' }),
  });
  assert.equal(unauthenticatedVote.status, 401);
  assert.equal((await unauthenticatedVote.json()).code, 'AUTH_REQUIRED');
  const unauthenticatedUpload = await fetch(`${origin}/api/uploads`, {
    method: 'POST',
    headers: { Origin: origin },
  });
  assert.equal(unauthenticatedUpload.status, 401);
  const unauthenticatedReport = await fetch(`${origin}/api/reports`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'other' }),
  });
  assert.equal(unauthenticatedReport.status, 401);

  const weakPassword = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tester@example.com', password: 'short' }),
  });
  assert.equal(weakPassword.status, 400);

  const registration = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'Tester@Example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(registration.status, 201);
  const sessionCookie = registration.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(sessionCookie?.startsWith('rr_session='));
  assert.match(registration.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const { user } = await registration.json();
  assert.equal(user.email, 'tester@example.com');

  const invalidLogin = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'not the password' }),
  });
  assert.equal(invalidLogin.status, 401);

  const imageBuffer = await sharp({
    create: { width: 80, height: 120, channels: 3, background: '#f2f0e8' },
  }).png().toBuffer();
  async function uploadAuthenticated(label) {
    const form = new FormData();
    form.append('resume', new Blob([imageBuffer], { type: 'image/png' }), 'resume.png');
    form.append('label', label);
    return fetch(`${origin}/api/uploads`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: sessionCookie },
      body: form,
    });
  }

  const firstUpload = await uploadAuthenticated('First authenticated resume');
  assert.equal(firstUpload.status, 201);
  const limitedUpload = await uploadAuthenticated('Second authenticated resume');
  assert.equal(limitedUpload.status, 429);
  assert.equal((await limitedUpload.json()).code, 'UPLOAD_COOLDOWN');

  const vote = await fetch(`${origin}/api/votes`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction: 'respect' }),
  });
  assert.equal(vote.status, 200);
  assert.equal((await vote.json()).resume.viewerReaction, 'respect');
  const accountVoteIdentity = await fetch(`${origin}/api/votes`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction: 'shit' }),
  });
  assert.equal(accountVoteIdentity.status, 409);
  const database = new Database(path.join(dataDir, 'resume-roast.sqlite'), { readonly: true });
  assert.equal(database.prepare('SELECT owner_id FROM resumes').get().owner_id, user.id);
  database.close();

  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  const signedOutVote = await fetch(`${origin}/api/votes`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction: 'shit' }),
  });
  assert.equal(signedOutVote.status, 401);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  const authenticatedStatus = await fetch(`${origin}/api/auth/status`, { headers: { Cookie: loginCookie } });
  assert.equal((await authenticatedStatus.json()).user.id, user.id);
});
