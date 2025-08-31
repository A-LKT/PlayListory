// Sanitizes fetched playlists/tracks to only the minimal fields used by the app

export function sanitizeTrack(item) {
  const track = item?.track || item || {};
  const rawArtists = track?.artists || track?.artist || [];
  const artists = Array.isArray(rawArtists)
    ? rawArtists.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean)
    : [typeof rawArtists === 'string' ? rawArtists : rawArtists?.name].filter(Boolean);

  return {
    // Keep Spotify-like keys so existing normalizer can consume directly
    name: track?.name || item?.title || item?.name || 'Unknown',
    artists,
    album: typeof track?.album === 'string' ? track.album : (track?.album?.name ?? null),
    added_at: item?.added_at || item?.addedAt || track?.added_at || null,
    uri: track?.uri || item?.uri || null,
    duration_ms: track?.duration_ms || item?.duration_ms || null,
  };
}

export function sanitizePlaylistsForStorage(playlists) {
  if (!Array.isArray(playlists)) return [];
  return playlists.map((p) => ({
    // Only fields referenced by the UI/normalizer
    id: p?.id || null,
    name: p?.name || 'Untitled playlist',
    owner: p?.owner || p?.user || (p?.raw?.owner?.display_name || p?.raw?.owner?.id || null) || null,
    tracks: Array.isArray(p?.tracks) ? p.tracks.map(sanitizeTrack) : [],
  }));
}


