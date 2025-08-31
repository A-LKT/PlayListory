import { getValidAccessToken } from './spotifyAuth.js'
import { sanitizeTrack } from './sanitize.js'

async function apiFetch(path, options = {}) {
  const token = await getValidAccessToken({});
  if (!token) throw new Error('Not authenticated with Spotify');
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('Unauthorized');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getCurrentUserProfile() {
  return apiFetch('/me');
}

export async function getAllCurrentUserPlaylists() {
  const limit = 50;
  let url = `/me/playlists?limit=${limit}`;
  const all = [];
  while (url) {
    const page = await apiFetch(url.replace('https://api.spotify.com/v1', ''));
    all.push(...(page.items || []));
    url = page.next;
  }
  return all;
}

export async function getAllSavedTracks() {
  const limit = 50;
  let url = `/me/tracks?limit=${limit}`;
  const all = [];
  while (url) {
    const page = await apiFetch(url.replace('https://api.spotify.com/v1', ''));
    const items = (page.items || []).map(sanitizeTrack);
    all.push(...items);
    url = page.next;
  }
  return all;
}

export async function getAllPlaylistTracks(playlistId) {
  const limit = 100;
  let url = `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}`;
  const all = [];
  while (url) {
    const page = await apiFetch(url.replace('https://api.spotify.com/v1', ''));
    const items = (page.items || []).map(sanitizeTrack);
    all.push(...items);
    url = page.next;
  }
  return all;
}

export async function getPlaylistsWithTracks() {
  const playlists = await getAllCurrentUserPlaylists();
  const result = [];
  try {
    const liked = await getAllSavedTracks();
    result.push({
      id: 'liked-songs-virtual',
      name: 'liked songs ⭐',
      owner: null,
      tracks: liked,
      raw: { type: 'virtual', source: 'liked_songs' },
    });
  } catch (e) {
    // ignore
  }
  for (const p of playlists) {
    const tracks = await getAllPlaylistTracks(p.id);
    result.push({
      id: p.id,
      name: p.name,
      owner: p.owner?.display_name || p.owner?.id || null,
      tracks,
      raw: {
        owner: p.owner ? { id: p.owner.id || null, display_name: p.owner.display_name || null } : undefined,
      },
    });
  }
  return result;
}


