import { useEffect, useMemo, useState } from 'react'
import { beginLogin, handleRedirectCallback, getStoredAccessToken, clearTokens, hasRefreshToken, getValidAccessToken } from './spotifyAuth.js'
import { getPlaylistsWithTracks, getCurrentUserProfile } from './spotifyApi.js'
import { sanitizePlaylistsForStorage } from './sanitize.js'
import { loadPlaylistsCache, savePlaylistsCache, purgeCache as purgeCacheDb } from './cacheDb.js'

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      try {
        const text = reader.result
        const json = JSON.parse(text)
        resolve(json)
      } catch (e) {
        reject(e)
      }
    }
    reader.readAsText(file)
  })
}

function detectSchema(data) {
  // Heuristic: accept objects with playlists, or arrays of playlists/tracks
  if (Array.isArray(data)) return { type: 'arrayRoot' }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.playlists)) return { type: 'objectWithPlaylists' }
    if (Array.isArray(data.items)) return { type: 'objectWithItems' }
  }
  return { type: 'unknown' }
}

function normalizeData(data) {
  const schema = detectSchema(data)
  let playlists = []

  const ensureTrack = (t) => {
    // Attempt to normalize common Spotify dump fields
    const track = t.track || t
    const rawArtists = track?.artists || track?.artist || []
    const album = track?.album || t.album || null
    const title = track?.name || track?.title || t.title || t.name || 'Unknown'
    const addedAt = t.added_at || t.addedAt || track?.added_at || null
    const uri = track?.uri || t.uri || null
    const durationMs = track?.duration_ms || t.duration_ms || null
    const artists = Array.isArray(rawArtists)
      ? rawArtists.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean)
      : [typeof rawArtists === 'string' ? rawArtists : rawArtists?.name].filter(Boolean)
    return {
      title,
      artists,
      album: typeof album === 'string' ? album : album?.name ?? null,
      addedAt,
      uri,
      durationMs,
      raw: t,
    }
  }

  const ensurePlaylist = (p) => {
    const name = p.name || p.title || 'Untitled playlist'
    const owner = p.owner || p.user || null
    const items = p.items || p.tracks || p.contents || []
    const tracks = (Array.isArray(items) ? items : []).map(ensureTrack)
    return { name, owner, tracks, raw: p }
  }

  if (schema.type === 'objectWithPlaylists') {
    playlists = (data.playlists || []).map(ensurePlaylist)
  } else if (schema.type === 'objectWithItems') {
    playlists = [{ name: 'All Items', owner: null, tracks: (data.items || []).map(ensureTrack), raw: data }]
  } else if (schema.type === 'arrayRoot') {
    // Guess whether array is playlists or tracks
    if (data.length && (data[0].items || data[0].tracks)) {
      playlists = data.map(ensurePlaylist)
    } else {
      playlists = [{ name: 'All Items', owner: null, tracks: data.map(ensureTrack), raw: data }]
    }
  } else {
    // Fallback: single bucket
    playlists = [{ name: 'Data', owner: null, tracks: [], raw: data }]
  }

  const allTracks = playlists.flatMap((p) => p.tracks)
  const artists = new Map()
  for (const t of allTracks) {
    for (const a of t.artists) {
      artists.set(a, (artists.get(a) || 0) + 1)
    }
  }

  return { playlists, allTracks, artistCounts: artists }
}

function StatBadge({ label, value }) {
  return (
    <div className="stat-badge">
      <div className="stat-badge__label">{label}</div>
      <div className="stat-badge__value">{value}</div>
    </div>
  )
}

function FileDrop({ onFile }) {
  const [drag, setDrag] = useState(false)

  return (
    <label
      className={classNames('file-drop', drag && 'is-drag')}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const file = e.dataTransfer.files?.[0]
        if (file) onFile(file)
      }}
    >
      <div className="file-drop__icon">📁</div>
      <div className="file-drop__help">
        Drop your Spotify JSON export here or click to choose
      </div>
      <input
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
        }}
      />
    </label>
  )
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="search-input"
    />
  )
}

function PlaylistList({ playlists, selectedIndex, onSelect, query, currentUserId, currentUserName }) {
  const searchable = useMemo(() => playlists.map((p, originalIndex) => ({ p, originalIndex })), [playlists])

  const filtered = useMemo(() => {
    if (!query) return searchable
    const q = query.toLowerCase()
    return searchable.filter(({ p }) => p.name?.toLowerCase().includes(q))
  }, [searchable, query])

  const sorted = useMemo(() => {
    const liked = []
    const owned = []
    const notOwned = []
    for (const item of filtered) {
      const p = item.p
      const ownerId = p?.raw?.owner?.id || null
      const ownerName = p?.raw?.owner?.display_name || null
      const ownerField = p?.owner || null
      const isVirtual = p?.raw?.type === 'virtual'
      const nameSanitized = (p?.name || '').replace(/⭐/g, '').trim()
      const nameLooksLiked = /^liked\s*songs$/i.test(nameSanitized)
      const isLiked = (isVirtual && p?.raw?.source === 'liked_songs') || nameLooksLiked
      const isOwned = isLiked || isVirtual || !currentUserId || (
        ownerId === currentUserId ||
        ownerField === currentUserId ||
        (currentUserName ? (ownerName === currentUserName || ownerField === currentUserName) : false)
      )
      const withFlags = { ...item, isOwned, isLiked }
      if (isLiked) {
        liked.push(withFlags)
      } else if (isOwned) {
        owned.push(withFlags)
      } else {
        notOwned.push(withFlags)
      }
    }
    const byName = (a, b) => {
      const an = (a.p?.name || '').toLowerCase()
      const bn = (b.p?.name || '').toLowerCase()
      if (an < bn) return -1
      if (an > bn) return 1
      return 0
    }
    owned.sort(byName)
    notOwned.sort(byName)
    return liked.concat(owned, notOwned)
  }, [filtered, currentUserId, currentUserName])

  return (
    <ul className="playlist-list">
      {sorted.map(({ p, originalIndex, isOwned, isLiked }) => {
        const displayName = isLiked ? ((p.name || 'Liked Songs').replace(/⭐/g, '').trim() || 'Liked Songs') : p.name
        return (
          <li key={originalIndex} className="item">
            <button
              className={classNames('playlist-button', originalIndex === selectedIndex && 'is-active')}
              onClick={() => onSelect(originalIndex)}
            >
              <div className={classNames('playlist-name', (!isOwned && !isLiked) && 'is-not-owned')}>
                {isLiked && <span className="playlist-icon" aria-hidden="true">⭐</span>}
                {displayName}
              </div>
              <div className="playlist-meta">{p.tracks.length} tracks</div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function TrackRow({ t }) {
  const getSpotifyTrackUrl = () => {
    const buildFromUri = (uri) => {
      if (typeof uri === 'string' && uri.startsWith('spotify:track:')) {
        const id = uri.split(':').pop()
        return id ? `https://open.spotify.com/track/${id}` : null
      }
      return null
    }

    return (
      buildFromUri(t.uri) ||
      t?.raw?.track?.external_urls?.spotify ||
      t?.raw?.external_urls?.spotify ||
      (t?.raw?.track?.id ? `https://open.spotify.com/track/${t.raw.track.id}` : null) ||
      (t?.raw?.id ? `https://open.spotify.com/track/${t.raw.id}` : null)
    )
  }

  const url = getSpotifyTrackUrl()
  const searchQuery = `${(t.artists && t.artists.length ? t.artists[0] : (t.artists || []).join(', ')) || ''} - ${t.title || ''}`.trim()
  const ytmUrl = `https://music.youtube.com/search?q=${encodeURIComponent(searchQuery)}`

  return (
    <div className="track-row">
      <div className="truncate">
        {url ? <a href={url} target="_blank" rel="noopener noreferrer">{t.title}</a> : t.title}
      </div>
      <div className="col-yt">
        <a
          href={ytmUrl}
          className="ytm-btn"
          title={`Search on YouTube Music: ${searchQuery}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Search on YouTube Music: ${searchQuery}`}
        >
          YTM
        </a>
      </div>
      <div className="truncate col-artist">{t.artists.join(', ')}</div>
      <div className="col-len">{t.durationMs ? Math.round(t.durationMs/1000/60) + 'm' : ''}</div>
    </div>
  )
}

function TracksPane({ tracks, query }) {
  const filtered = useMemo(() => {
    if (!query) return tracks
    const q = query.toLowerCase()
    return tracks.filter((t) =>
      (t.title || '').toLowerCase().includes(q) ||
      t.artists.some((a) => a.toLowerCase().includes(q)) ||
      (t.album || '').toLowerCase().includes(q)
    )
  }, [tracks, query])

  return (
    <div className="tracks-pane">
      <div className="tracks-headers">
        <div>Title</div>
        <div className="col-yt">YTM</div>
        <div>Artist</div>
        <div className="col-len">Len</div>
      </div>
      <div>
        {filtered.map((t, i) => <TrackRow key={i} t={t} />)}
      </div>
    </div>
  )
}

function TopArtists({ artistCounts }) {
  const top = useMemo(() => {
    return Array.from(artistCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
  }, [artistCounts])

  return (
    <div className="section">
      <div className="section-title">Top artists</div>
      <div className="top-artists-list">
        {top.map(([artist, count]) => (
          <div key={artist} className="top-artist">
            <div className="artist-name truncate">{artist}</div>
            <div className="bar-bg">
              <div className="bar-fill" style={{ width: `${(count / top[0][1]) * 100}%` }} />
            </div>
            <div className="artist-count">{count}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function YearHistogram({ tracks }) {
  const buckets = useMemo(() => {
    const map = new Map()
    for (const t of tracks) {
      const date = t.addedAt ? new Date(t.addedAt) : null
      const year = Number.isFinite(date?.getFullYear?.()) ? date.getFullYear() : null
      if (year) map.set(year, (map.get(year) || 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0])
  }, [tracks])

  if (!buckets.length) return null
  const max = Math.max(...buckets.map(([, c]) => c))

  return (
    <div className="year-hist">
      <div className="section-title">Added per year</div>
      <div className="year-bars">
        {buckets.map(([year, count]) => (
          <div key={year} className="year-col">
            <div className="year-bar" title={`${count} tracks`}>
              <div className="fill" style={{ height: `${(count / max) * 100}%` }} />
            </div>
            <div className="year-label">{year}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const [fileName, setFileName] = useState('')
  const [data, setData] = useState(null)
  const [normalized, setNormalized] = useState(null)
  const [error, setError] = useState('')
  const [authReady, setAuthReady] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [dataSource, setDataSource] = useState('') // 'file' | 'cache' | 'api'
  const [cacheCreatedAt, setCacheCreatedAt] = useState(null)
  const [currentUser, setCurrentUser] = useState(null)

  // App state

  const [playlistQuery, setPlaylistQuery] = useState('')
  const [trackQuery, setTrackQuery] = useState('')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const handled = await handleRedirectCallback()
        if (handled && !cancelled) {
          setAuthReady(true)
          // Auto-fetch after successful login
          await fetchFromSpotify()
          return
        }
        // No OAuth callback handled; try to load cached data
        const cached = await loadPlaylistsCache()
        if (cached && !cancelled) {
          const obj = { playlists: cached.playlists }
          setFileName('Spotify (cache)')
          setData(obj)
          const n = normalizeData(obj)
          setNormalized(n)
          setDataSource('cache')
          setCacheCreatedAt(cached.createdAt || null)
          // If user info was saved in cache, restore it to keep owned/not-owned distinction
          if (cached.user && (cached.user.id || cached.user.display_name)) {
            setCurrentUser({ id: cached.user.id || null, display_name: cached.user.display_name || null })
          }
        }
        // Attempt silent refresh if only refresh token exists
        if (!cancelled && !getStoredAccessToken() && hasRefreshToken()) {
          try { await getValidAccessToken() } catch {}
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e))
      } finally {
        if (!cancelled) setAuthReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFile(file) {
    setError('')
    setPlaylistQuery('')
    setTrackQuery('')
    setSelected(0)
    try {
      setFileName(file.name)
      const json = await readJsonFile(file)
      setData(json)
      const n = normalizeData(json)
      setNormalized(n)
      setDataSource('file')
      setCacheCreatedAt(null)
    } catch (e) {
      setError(String(e?.message || e))
    }
  }

  const currentPlaylist = normalized?.playlists?.[selected]

  // Derive owned-only aggregates for sidebar stats and charts
  const ownedAggregates = useMemo(() => {
    if (!normalized) return { playlists: [], allTracks: [], artistCounts: new Map() }
    const userId = currentUser?.id || null
    const userName = currentUser?.display_name || null
    const isOwnedPlaylist = (p) => {
      const ownerId = p?.raw?.owner?.id || null
      const ownerName = p?.raw?.owner?.display_name || null
      const ownerField = p?.owner || null
      const isVirtual = p?.raw?.type === 'virtual'
      const nameSanitized = (p?.name || '').replace(/⭐/g, '').trim()
      const nameLooksLiked = /^liked\s*songs$/i.test(nameSanitized)
      const isLiked = (isVirtual && p?.raw?.source === 'liked_songs') || nameLooksLiked
      return isLiked || isVirtual || !userId || (
        ownerId === userId ||
        ownerField === userId ||
        (userName ? (ownerName === userName || ownerField === userName) : false)
      )
    }
    const playlists = (normalized.playlists || []).filter(isOwnedPlaylist)
    const allTracks = playlists.flatMap((p) => p.tracks)
    const artistCounts = new Map()
    for (const t of allTracks) {
      for (const a of t.artists) {
        artistCounts.set(a, (artistCounts.get(a) || 0) + 1)
      }
    }
    return { playlists, allTracks, artistCounts }
  }, [normalized, currentUser])

  function downloadJsonFile(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function fetchFromSpotify() {
    setError('')
    setIsFetching(true)
    try {
      const [user, playlists] = await Promise.all([
        getCurrentUserProfile(),
        getPlaylistsWithTracks(),
      ])
      setCurrentUser(user || null)
      const obj = { playlists }
      setFileName('Spotify (live)')
      setData(obj)
      const n = normalizeData(obj)
      setNormalized(n)
      setDataSource('api')
      const sanitizedForCache = sanitizePlaylistsForStorage(playlists)
      const saved = await savePlaylistsCache(sanitizedForCache, user || null)
      setCacheCreatedAt(saved?.createdAt || Date.now())
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setIsFetching(false)
    }
  }

  const isAuthed = !!getStoredAccessToken()



  return (
    <div className="app">
      <header className="app-header">
        <div className="container header-row">
          <div className="header-title">PlayListory</div>
          <div className="header-note">UI-only. Data stays in your browser.</div>
        </div>
        {isFetching && (
          <div className="loading-bar" aria-hidden="true">
            <div className="bar" />
          </div>
        )}
      </header>

      <main className="container main">
        {!normalized ? (
          <div className="mx-auto" style={{ maxWidth: '42rem' }}>
            <div className="choice-stack">
              <div className="card padded">
                <div className="section-title" style={{ marginBottom: '0.5rem' }}>Option 1: Connect to Spotify</div>
                <div className="header-note" style={{ marginBottom: '0.75rem' }}>
                  Authorize with Spotify to instantly load your playlists and liked songs.
                </div>
                <div>
                  {!isAuthed ? (
                    <button className="btn" disabled={!authReady} onClick={() => beginLogin()}>Connect Spotify</button>
                  ) : (
                    <>
                      <button className="btn" disabled={isFetching} onClick={fetchFromSpotify}>{isFetching ? 'Fetching…' : 'Fetch my playlists'}</button>
                      <button className="btn" style={{ marginLeft: '0.5rem' }} onClick={() => { clearTokens(); setAuthReady(true) }}>Sign out</button>
                    </>
                  )}
                </div>
              </div>

              <div className="or-divider"><span>OR</span></div>

              <div className="card padded">
                <div className="section-title" style={{ marginBottom: '0.5rem' }}>Option 2: Upload a JSON file</div>
                <div className="header-note" style={{ marginBottom: '0.75rem' }}>
                  Drop a Spotify JSON export, or click to choose a file from your device.
                </div>
                <FileDrop onFile={handleFile} />
              </div>
            </div>

            {error && <div className="header-note" style={{ marginTop: '1rem', color: '#f87171' }}>{error}</div>}
          </div>
        ) : (
          <div className="grid-main">
            <aside className="sidebar">
              <div className="sidebar-header">
                <div className="sidebar-title">Playlists</div>
                <div className="file-name" title={fileName}>{fileName}</div>
              </div>
              <div style={{ marginBottom: '0.75rem' }}>
                <SearchBox value={playlistQuery} onChange={setPlaylistQuery} placeholder="Search playlists" />
              </div>
              <div className="card padded playlist-panel">
                <PlaylistList
                  playlists={normalized.playlists}
                  selectedIndex={selected}
                  onSelect={setSelected}
                  query={playlistQuery}
                  currentUserId={currentUser?.id || null}
                  currentUserName={currentUser?.display_name || null}
                />
              </div>

              <div className="stats-grid">
                <StatBadge label="Playlists" value={ownedAggregates.playlists.length} />
                <StatBadge label="Tracks" value={ownedAggregates.allTracks.length} />
                <StatBadge label="Artists" value={ownedAggregates.artistCounts.size} />
              </div>

              <div className="section-stack">
                <TopArtists artistCounts={ownedAggregates.artistCounts} />
                <YearHistogram tracks={ownedAggregates.allTracks} />
              </div>
            </aside>

            <section className="content">
              <div className="content-header">
                <div className="content-title">{currentPlaylist?.name || 'Playlist'}</div>
                <div className="content-meta">{currentPlaylist?.tracks.length ?? 0} tracks</div>
                {dataSource && (
                  <div className="content-meta" title={cacheCreatedAt ? new Date(cacheCreatedAt).toLocaleString() : ''}>
                    Source: {dataSource === 'file' ? 'File' : dataSource === 'cache' ? `Cache${cacheCreatedAt ? ` (${new Date(cacheCreatedAt).toLocaleDateString()})` : ''}` : 'API'}
                  </div>
                )}
                <div className="spacer" />
                <button
                  className="btn"
                  onClick={() => {
                    setData(null)
                    setNormalized(null)
                    setFileName('')
                    setDataSource('')
                    setCacheCreatedAt(null)
                  }}
                >Load another file</button>
                <button
                  className="btn"
                  onClick={() => {
                    const sanitized = sanitizePlaylistsForStorage(normalized?.playlists || [])
                    downloadJsonFile({ playlists: sanitized }, 'spotify-export.json')
                  }}
                  style={{ marginLeft: '0.5rem' }}
                >Download JSON</button>
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await purgeCacheDb()
                      // If current view is cache, clear it from UI
                      if (dataSource === 'cache') {
                        setData(null)
                        setNormalized(null)
                        setFileName('')
                        setDataSource('')
                        setCacheCreatedAt(null)
                      } else {
                        setCacheCreatedAt(null)
                      }
                    } catch (e) {
                      setError(String(e?.message || e))
                    }
                  }}
                  style={{ marginLeft: '0.5rem' }}
                >Purge cache</button>
              </div>
              <div style={{ marginBottom: '0.75rem' }}>
                <SearchBox value={trackQuery} onChange={setTrackQuery} placeholder="Search tracks, artists, albums" />
              </div>
              <div className="card padded tracks-panel">
                <TracksPane tracks={currentPlaylist?.tracks || []} query={trackQuery} />
              </div>

              <details>
                <summary>Show raw JSON</summary>
                <pre className="json">
{JSON.stringify(
  data?.playlists?.[selected] ?? currentPlaylist?.raw ?? currentPlaylist ?? data,
  null,
  2
)}
                </pre>
              </details>
            </section>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <div className="container footer-row">
          <div className="header-note">Built with React + Vite. All processing is local.</div>
        </div>
      </footer>
    </div>
  )
}
