// Lightweight Spotify PKCE OAuth utilities for browser-only apps
// Uses localStorage for transient state. No server required.

const LS_KEYS = {
  codeVerifier: 'spotify_pkce_code_verifier',
  state: 'spotify_oauth_state',
  token: 'spotify_access_token',
  tokenExpiry: 'spotify_access_token_expiry',
  refreshToken: 'spotify_refresh_token',
};

function getBaseUrl() {
  return window.location.origin + window.location.pathname;
}

function uint8ToBase64Url(uint8) {
  return btoa(String.fromCharCode.apply(null, [...uint8]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256Base64Url(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return uint8ToBase64Url(new Uint8Array(digest));
}

function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => ('0' + byte.toString(16)).slice(-2)).join('');
}

export function getStoredAccessToken() {
  const token = localStorage.getItem(LS_KEYS.token);
  const expiry = Number(localStorage.getItem(LS_KEYS.tokenExpiry) || 0);
  if (!token || !expiry) return null;
  if (Date.now() >= expiry - 30_000) return null; // consider expired if <30s left
  return token;
}

export function hasRefreshToken() {
  return !!localStorage.getItem(LS_KEYS.refreshToken);
}

export function clearTokens() {
  for (const key of Object.values(LS_KEYS)) localStorage.removeItem(key);
}

export async function beginLogin(options = {}) {
  const {
    clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID,
    scopes = 'playlist-read-private playlist-read-collaborative user-library-read',
    redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI || getBaseUrl(),
  } = options;

  if (!clientId) throw new Error('Missing VITE_SPOTIFY_CLIENT_ID');

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = generateRandomString(16);

  localStorage.setItem(LS_KEYS.codeVerifier, codeVerifier);
  localStorage.setItem(LS_KEYS.state, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });

  window.location.assign('https://accounts.spotify.com/authorize?' + params.toString());
}

async function exchangeCodeForToken(code, { clientId, redirectUri }) {
  const codeVerifier = localStorage.getItem(LS_KEYS.codeVerifier);
  if (!codeVerifier) throw new Error('Missing PKCE code_verifier');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Token exchange failed');
  const json = await res.json();
  storeTokenResponse(json);
}

function storeTokenResponse(json) {
  const now = Date.now();
  if (json.access_token) localStorage.setItem(LS_KEYS.token, json.access_token);
  if (json.expires_in) localStorage.setItem(LS_KEYS.tokenExpiry, String(now + json.expires_in * 1000));
  if (json.refresh_token) localStorage.setItem(LS_KEYS.refreshToken, json.refresh_token);
}

async function refreshAccessToken({ clientId }) {
  const refreshToken = localStorage.getItem(LS_KEYS.refreshToken);
  if (!refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return null;
  const json = await res.json();
  storeTokenResponse(json);
  return json.access_token || null;
}

export async function handleRedirectCallback(options = {}) {
  const {
    clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID,
    redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI || getBaseUrl(),
  } = options;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = localStorage.getItem(LS_KEYS.state);
  if (!code) return false;
  if (!state || state !== storedState) throw new Error('State mismatch');
  await exchangeCodeForToken(code, { clientId, redirectUri });
  // Clean params from URL
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('iss');
  window.history.replaceState({}, document.title, url.toString());
  return true;
}

export async function getValidAccessToken(options = {}) {
  const { clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID } = options;
  const token = getStoredAccessToken();
  if (token) return token;
  const refreshed = await refreshAccessToken({ clientId });
  return refreshed;
}


