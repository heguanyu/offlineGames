// Auth for the admin save-recovery API. Two ways in:
//   1. ADMIN_TOKEN (env) as a bearer token — the bootstrap/fallback, works from any origin.
//   2. A PASSKEY (WebAuthn): enroll once using the token, then Face ID / Touch ID logins mint a
//      short-lived HMAC session token so the operator never types the raw token again.
//
// Passkeys are domain-bound, so this is scoped to ONE origin (the Azure app by default; override with
// WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN). Credentials live in the durable DB meta store (survives redeploys).
// The heavy crypto (attestation/assertion verification) is delegated to @simplewebauthn/server, which
// is LAZY-imported so the server still boots token-only if the dependency is ever missing.
import crypto from 'node:crypto';
import db from './db.js';

const RP_ID = process.env.WEBAUTHN_RP_ID || 'offlinegames.azurewebsites.net';
const RP_NAME = 'Offline Games Admin';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || ('https://' + RP_ID);
const SESSION_DAYS = 30;
const META_KEY = 'admin_passkeys';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const u8 = (b64) => new Uint8Array(Buffer.from(String(b64), 'base64url'));

let _wa = null;
async function wa() {
  if (!_wa) _wa = await import('@simplewebauthn/server'); // throws if the dep isn't installed
  return _wa;
}

// --- session tokens: "<payload>.<hmac>" signed with ADMIN_TOKEN (rotating the token invalidates all) ---
function mintSession(days = SESSION_DAYS) {
  const secret = process.env.ADMIN_TOKEN || '';
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + days * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function sessionOk(tok) {
  const secret = process.env.ADMIN_TOKEN || '';
  if (!tok || !secret) return false;
  const [payload, sig] = String(tok).split('.');
  if (!payload || !sig) return false;
  const want = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function tokenEq(supplied) {
  const want = process.env.ADMIN_TOKEN || '';
  if (!want) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// True if the request carries a valid admin token (header or ?token=) OR a valid passkey session.
export function adminAuthed(req, url) {
  if (!process.env.ADMIN_TOKEN) return false;
  const headerTok = req.headers['x-admin-token'];
  const queryTok = url && url.searchParams.get('token');
  if (tokenEq(headerTok) || tokenEq(queryTok)) return true;
  return sessionOk(req.headers['x-admin-session']);
}

// --- credential store (durable) ---
function loadCreds() { try { return JSON.parse((db.getMeta && db.getMeta(META_KEY)) || '[]'); } catch { return []; } }
function saveCreds(a) { try { db.setMeta && db.setMeta(META_KEY, JSON.stringify(a)); } catch { /* best effort */ } }

// Single-flight challenges (one operator) with a short TTL.
let regChallenge = null;
let authChallenge = null;

function readJson(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let bad = false;
    req.on('data', (c) => { if (bad) return; size += c.length; if (size > max) { bad = true; req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
    req.on('end', () => { if (bad) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', () => { if (!bad) reject(new Error('read error')); });
  });
}
function sendJson(res, code, obj, cors) {
  res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Handle /api/emu-admin/passkey/<sub>. `sub` is the trailing segment (status|reg-options|reg-verify|auth-options|auth-verify).
export async function handlePasskey(req, res, cors, sub) {
  const json = (code, obj) => sendJson(res, code, obj, cors);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-admin-token, x-admin-session', 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }
  if (!process.env.ADMIN_TOKEN) return json(503, { error: 'admin disabled: ADMIN_TOKEN not set' });
  const url = new URL(req.url, 'http://x');

  try {
    if (sub === 'status') { // unauthenticated: lets the page show "enroll" vs "sign in"
      const creds = loadCreds();
      return json(200, { enrolled: creds.length > 0, count: creds.length, rpId: RP_ID });
    }
    if (req.method !== 'POST') return json(405, { error: 'method' });

    if (sub === 'reg-options') { // enrolling a new passkey requires the bootstrap token
      if (!adminAuthed(req, url)) return json(401, { error: 'admin token required to enroll a passkey' });
      const { generateRegistrationOptions } = await wa();
      const creds = loadCreds();
      const opts = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID,
        userID: new TextEncoder().encode('admin'), userName: 'admin',
        attestationType: 'none',
        excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      regChallenge = { v: opts.challenge, exp: Date.now() + 300000 };
      return json(200, opts);
    }

    if (sub === 'reg-verify') {
      if (!adminAuthed(req, url)) return json(401, { error: 'admin token required to enroll a passkey' });
      const body = await readJson(req);
      if (!regChallenge || regChallenge.exp < Date.now()) return json(400, { error: 'enrollment challenge expired — retry' });
      const { verifyRegistrationResponse } = await wa();
      const v = await verifyRegistrationResponse({ response: body, expectedChallenge: regChallenge.v, expectedOrigin: ORIGIN, expectedRPID: RP_ID });
      regChallenge = null;
      if (!v.verified || !v.registrationInfo) return json(400, { error: 'passkey verification failed' });
      const info = v.registrationInfo;
      // @simplewebauthn v13 nests these under .credential; older versions expose them flat.
      const id = info.credential ? info.credential.id : b64url(info.credentialID);
      const publicKey = b64url(info.credential ? info.credential.publicKey : info.credentialPublicKey);
      const counter = (info.credential ? info.credential.counter : info.counter) || 0;
      const transports = (info.credential && info.credential.transports) || (body.response && body.response.transports) || [];
      const creds = loadCreds().filter((c) => c.id !== id);
      creds.push({ id, publicKey, counter, transports, added: Date.now() });
      saveCreds(creds);
      return json(200, { ok: true, count: creds.length });
    }

    if (sub === 'auth-options') { // login — no auth needed to START the challenge
      const { generateAuthenticationOptions } = await wa();
      const creds = loadCreds();
      if (!creds.length) return json(400, { error: 'no passkeys enrolled yet' });
      const opts = await generateAuthenticationOptions({
        rpID: RP_ID, userVerification: 'preferred',
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
      });
      authChallenge = { v: opts.challenge, exp: Date.now() + 300000 };
      return json(200, opts);
    }

    if (sub === 'auth-verify') {
      const body = await readJson(req);
      if (!authChallenge || authChallenge.exp < Date.now()) return json(400, { error: 'login challenge expired — retry' });
      const creds = loadCreds();
      const cred = creds.find((c) => c.id === body.id || c.id === body.rawId);
      if (!cred) return json(400, { error: 'unknown passkey' });
      const { verifyAuthenticationResponse } = await wa();
      const v = await verifyAuthenticationResponse({
        response: body, expectedChallenge: authChallenge.v, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        // v13 reads `credential`; older reads `authenticator`. Provide both; the unused one is ignored.
        credential: { id: cred.id, publicKey: u8(cred.publicKey), counter: cred.counter || 0, transports: cred.transports },
        authenticator: { credentialID: u8(cred.id), credentialPublicKey: u8(cred.publicKey), counter: cred.counter || 0 },
      });
      authChallenge = null;
      if (!v.verified) return json(400, { error: 'passkey verification failed' });
      const nc = v.authenticationInfo && v.authenticationInfo.newCounter;
      if (typeof nc === 'number') { cred.counter = nc; saveCreds(creds); }
      return json(200, { session: mintSession(), exp: Date.now() + SESSION_DAYS * 864e5 });
    }

    return json(404, { error: 'unknown passkey route' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Cannot find package|ERR_MODULE_NOT_FOUND|@simplewebauthn/.test(msg)) return json(501, { error: 'passkey support not installed on server' });
    return json(500, { error: msg });
  }
}
