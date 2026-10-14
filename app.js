"use strict";

const DB_NAME = "musick-library";
const DB_VERSION = 1;
const TRACK_STORE = "tracks";
const PLAYLISTS_KEY = "musick-playlists-v1";
const EQ_KEY = "musick-equalizer-v1";
const SESSION_KEY = "musick-supabase-session-v1";
const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [7, 5, 1, -1, 0],
  "deep-bass": [10, 4, -1, 0, -1],
  vocal: [-2, 1, 4, 3, 1],
  treble: [-1, 0, 1, 4, 6],
  pop: [3, 2, 0, 3, 2],
  rock: [5, 3, 0, 4, 2],
  "classic-rock": [4, 2, 0, 3, 1],
  "alternative-rock": [4, 2, -1, 4, 3],
  metal: [5, 2, -1, 4, 4],
  classical: [-1, 0, 2, 3, 2],
  jazz: [2, 1, -1, 2, 3],
  country: [3, 1, 1, 3, 2],
  "r-and-b": [5, 4, 0, 3, 3],
  trap: [7, 5, 1, 3, 4],
  electronic: [6, 3, -1, 2, 4],
  acoustic: [1, 1, 2, 3, 1],
  podcast: [-3, 0, 4, 3, -1],
  movie: [4, 2, 1, 3, 2],
  gaming: [2, 0, 1, 5, 3]
};
const COVER_PALETTES = [
  ["#805ba9", "#33213f"], ["#397c78", "#183d4c"], ["#aa6957", "#4f293c"],
  ["#5364a0", "#26253f"], ["#9b7950", "#473324"], ["#98658e", "#492b54"]
];

const audio = document.querySelector("#audio");
const content = document.querySelector("#content");
const seekBar = document.querySelector("#seek-bar");
const toastElement = document.querySelector("#toast");
const lyricsView = document.querySelector("#lyrics-view");
const equalizer = document.querySelector("#equalizer");
let database;
let tracks = [];
let playlists = loadPlaylists();
let currentTrackId = null;
let currentView = "home";
let activePlaylistId = null;
let shuffleEnabled = false;
let repeatEnabled = false;
let searchQuery = "";
let searchSource = "local";
let playbackRequest = 0;
let youtubeConfig = { apiKey: "" };
let youtubeConfigLoaded = false;
let youtubeConfigError = "";
let onlineSearch = { status: "idle", results: [], error: "", query: "", selectedVideoId: "", playerError: "" };
let onlineSearchController;
let onlineSearchRequest = 0;
let youtubeLinkTitle = "";
let youtubeLinkError = "";
let youtubePlayer;
let youtubePlayerApiPromise;
let archiveSearch = { status: "idle", results: [], error: "", query: "", selectedId: "" };
let archiveSearchController;
let archiveSearchRequest = 0;
let toastTimer;
let currentObjectUrl = null;
let audioContext;
let mediaSource;
let gainNode;
let filters = [];
let audioGraphWarningShown = false;
let lyricsEntries = [];
let historyStack = [{ view: "home", playlistId: null }];
let historyIndex = 0;
const supabaseConfig = window.MUSICK_SUPABASE;
let authSession = loadAuthSession();
let cloudSyncTask = Promise.resolve();
let cloudSyncTimer;
let pendingAuthMode = "signin";
let authFeedback = "";

function loadAuthSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return value && typeof value.access_token === "string" && typeof value.refresh_token === "string" ? value : null;
  } catch (error) {
    console.error("Could not restore the Supabase session.", error);
    return null;
  }
}

function saveAuthSession(session) {
  authSession = session;
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch (error) {
    authSession = null;
    throw new Error(`Could not store the sign-in session in this browser: ${error.message}`);
  }
  renderProfile();
}

function renderProfile() {
  const label = document.querySelector("#profile-label");
  const avatar = document.querySelector(".profile-avatar");
  if (!label || !avatar) return;
  const email = authSession?.user?.email;
  label.textContent = email || "Connect services";
  avatar.textContent = email ? email.slice(0, 1).toUpperCase() : "M";
  avatar.title = email || "Connect services";
}

function supabaseUrl(path) {
  if (!supabaseConfig?.url || !supabaseConfig?.publishableKey) throw new Error("Supabase is not configured.");
  return `${supabaseConfig.url}${path}`;
}

async function supabaseFetch(path, options = {}, requireSession = true) {
  if (requireSession && !authSession) throw new Error("Sign in to sync your playlists.");
  const headers = new Headers(options.headers || {});
  headers.set("apikey", supabaseConfig.publishableKey);
  headers.set("Content-Type", "application/json");
  if (requireSession) headers.set("Authorization", `Bearer ${authSession.access_token}`);
  else headers.set("Authorization", `Bearer ${supabaseConfig.publishableKey}`);
  const response = await fetch(supabaseUrl(path), { ...options, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.msg || detail.message || detail.error_description || detail.error || `Supabase returned HTTP ${response.status}.`);
  }
  if (response.status === 204) return null;
  const responseBody = await response.text();
  return responseBody ? JSON.parse(responseBody) : null;
}

async function refreshAuthSession() {
  if (!authSession?.refresh_token) return false;
  try {
    const session = await supabaseFetch("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: authSession.refresh_token })
    }, false);
    if (!session.access_token || !session.refresh_token) throw new Error("Supabase did not return a refreshed session.");
    saveAuthSession({ ...session, expires_at: Math.floor(Date.now() / 1000) + (session.expires_in || 3600) });
    return true;
  } catch (error) {
    console.error("Could not refresh the Supabase session.", error);
    saveAuthSession(null);
    return false;
  }
}

async function ensureAuthSession() {
  if (!authSession) return false;
  if (authSession.expires_at && authSession.expires_at > Math.floor(Date.now() / 1000) + 60) return true;
  return refreshAuthSession();
}

async function authenticate(mode, email, password) {
  const path = mode === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
  const result = await supabaseFetch(path, {
    method: "POST",
    body: JSON.stringify({ email, password })
  }, false);
  if (!result.access_token || !result.refresh_token) {
    authFeedback = "Check your email for a confirmation link, then sign in here.";
    renderConnections();
    return false;
  }
  saveAuthSession({ ...result, expires_at: Math.floor(Date.now() / 1000) + (result.expires_in || 3600) });
  try {
    await synchronizeCloudPlaylists();
    authFeedback = "Signed in. Your playlist metadata is synced with Supabase.";
    showToast("Signed in and playlists synced.");
  } catch (error) {
    authFeedback = `Signed in, but playlist sync failed: ${error.message}`;
    showToast("Signed in, but playlist sync failed. Check the message below.");
    console.error("Initial Supabase playlist sync failed.", error);
  }
  renderConnections();
  return true;
}

async function signOut() {
  const session = authSession;
  if (session?.access_token) {
    try {
      await supabaseFetch("/auth/v1/logout", { method: "POST" }, true);
    } catch (error) {
      console.error("The local session was cleared, but the remote sign-out failed.", error);
    }
  }
  saveAuthSession(null);
  authFeedback = "Signed out. This device's local music and playlists are unchanged.";
  renderConnections();
}

function queueCloudSync() {
  if (!authSession) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTask = cloudSyncTask.then(async () => {
      if (!(await ensureAuthSession())) return;
      await synchronizeCloudPlaylists();
    }).catch(error => {
      showToast(`Playlist sync failed: ${error.message}`);
      console.error("Supabase playlist sync failed.", error);
    });
  }, 500);
}

function cloudTrackMetadata(track, userId) {
  return {
    id: track.id,
    user_id: userId,
    title: track.title || "Untitled",
    artist: track.artist || "",
    album: track.album || "",
    source: "local",
    source_track_id: null
  };
}

async function synchronizeCloudPlaylists() {
  if (!(await ensureAuthSession())) return;
  const userId = authSession.user?.id;
  if (!userId) throw new Error("Supabase session has no user ID.");

  const [remotePlaylists, remoteEntries, remoteTracks] = await Promise.all([
    supabaseFetch("/rest/v1/playlists?select=id,user_id,name,color,created_at,updated_at&order=created_at.asc"),
    supabaseFetch("/rest/v1/playlist_tracks?select=playlist_id,track_id,position&order=position.asc"),
    supabaseFetch("/rest/v1/tracks?select=id,title,artist,album,source,source_track_id,created_at")
  ]);
  const knownTrackIds = new Set(tracks.map(track => track.id));
  const trackById = new Map(tracks.map(track => [track.id, track]));

  for (const remote of remoteTracks) {
    if (knownTrackIds.has(remote.id)) continue;
    const cloudTrack = {
      ...remote,
      fileName: "",
      duration: 0,
      playCount: 0,
      favorite: false,
      addedAt: remote.created_at ? Date.parse(remote.created_at) : Date.now(),
      blob: null,
      isCloudOnly: true
    };
    trackById.set(remote.id, cloudTrack);
    tracks.push(cloudTrack);
  }

  const entriesByPlaylist = new Map();
  for (const entry of remoteEntries) {
    if (!entriesByPlaylist.has(entry.playlist_id)) entriesByPlaylist.set(entry.playlist_id, []);
    entriesByPlaylist.get(entry.playlist_id).push(entry);
  }
  const localById = new Map(playlists.map(playlist => [playlist.id, playlist]));
  for (const remote of remotePlaylists) {
    const remoteIds = (entriesByPlaylist.get(remote.id) || []).map(entry => entry.track_id);
    const local = localById.get(remote.id);
    if (local) {
      const ids = new Set([...local.trackIds, ...remoteIds]);
      local.trackIds = [...ids];
    } else {
      const playlist = { ...remote, createdAt: Date.parse(remote.created_at) || Date.now(), trackIds: remoteIds };
      playlists.push(playlist);
      localById.set(playlist.id, playlist);
    }
  }

  const localTrackIds = new Set(playlists.flatMap(playlist => playlist.trackIds));
  const upsertTracks = [...localTrackIds].map(id => trackById.get(id)).filter(Boolean).map(track => cloudTrackMetadata(track, userId));
  if (upsertTracks.length) {
    await supabaseFetch("/rest/v1/tracks?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(upsertTracks)
    });
  }

  if (playlists.length) {
    await supabaseFetch("/rest/v1/playlists?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(playlists.map(playlist => ({
        id: playlist.id,
        user_id: userId,
        name: playlist.name,
        color: /^#[\da-f]{6}$/i.test(playlist.color || "") ? playlist.color : "#a980ff"
      })))
    });
    const playlistIds = playlists.map(playlist => playlist.id);
    await supabaseFetch(`/rest/v1/playlist_tracks?playlist_id=in.(${playlistIds.join(",")})`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    });
    const entries = playlists.flatMap(playlist => [...new Set(playlist.trackIds)].map((trackId, position) => ({
      user_id: userId, playlist_id: playlist.id, track_id: trackId, position
    })));
    if (entries.length) {
      await supabaseFetch("/rest/v1/playlist_tracks", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(entries)
      });
    }
  }

  savePlaylists();
  renderSidebar();
  if (currentView !== "connections") renderContent();
}

function deleteCloudPlaylist(id) {
  if (!authSession) return;
  cloudSyncTask = cloudSyncTask.then(async () => {
    if (!(await ensureAuthSession())) return;
    await supabaseFetch(`/rest/v1/playlists?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  }).catch(error => {
    showToast(`Playlist removed locally, but cloud deletion failed: ${error.message}`);
    console.error("Could not delete the cloud playlist.", error);
  });
}

function loadPlaylists() {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || "[]");
    return Array.isArray(value) ? value.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.trackIds)) : [];
  } catch (error) {
    console.error("Could not load saved playlists.", error);
    return [];
  }
}

function savePlaylists() {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
  } catch (error) {
    showToast("Could not save playlists in this browser.");
    console.error("Could not save playlists.", error);
  }
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove("visible"), 3200);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function paletteFor(track) {
  let hash = 0;
  for (const character of track.id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return COVER_PALETTES[Math.abs(hash) % COVER_PALETTES.length];
}

function playlistPalette(playlist) {
  const color = /^#[\da-f]{6}$/i.test(playlist.color || "") ? playlist.color : "#a980ff";
  return [color, "#241d30"];
}

function coverMarkup(track, className = "cover-art") {
  const [first, second] = paletteFor(track);
  const initial = (track.title || "♪").trim().charAt(0).toUpperCase();
  return `<div class="${className}" style="--cover-a:${first};--cover-b:${second}" aria-hidden="true"><span>${escapeHTML(initial)}</span></div>`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACK_STORE)) db.createObjectStore(TRACK_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened."));
  });
}

function storeTrack(track) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRACK_STORE, "readwrite");
    transaction.objectStore(TRACK_STORE).put(track);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Track could not be saved."));
    transaction.onabort = () => reject(transaction.error || new Error("Track save was cancelled."));
  });
}

function readTracks() {
  return new Promise((resolve, reject) => {
    const request = database.transaction(TRACK_STORE, "readonly").objectStore(TRACK_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Local tracks could not be loaded."));
  });
}

function deleteStoredTrack(id) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRACK_STORE, "readwrite");
    transaction.objectStore(TRACK_STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Track could not be deleted."));
  });
}

function persistTrack(track) {
  const index = tracks.findIndex(item => item.id === track.id);
  if (index === -1) tracks.push(track);
  else tracks[index] = track;
  return storeTrack(track);
}

function renderSidebar() {
  const target = document.querySelector("#sidebar-playlists");
  if (!playlists.length) {
    target.innerHTML = `<div class="playlist-nav-empty">Your playlists will show up here.</div>`;
    return;
  }
  target.innerHTML = playlists.map(playlist => `
    <button class="playlist-link" data-action="open-playlist" data-id="${escapeHTML(playlist.id)}" title="${escapeHTML(playlist.name)}">
      <span class="playlist-dot" style="background:${escapeHTML(playlist.color || "#a980ff")}"></span>
      <span>${escapeHTML(playlist.name)}</span>
    </button>`).join("");
}

function changeView(view, playlistId = null, addHistory = true) {
  if (currentView === "search" && view !== "search") {
    onlineSearchController?.abort();
    archiveSearchController?.abort();
    onlineSearchRequest++;
    archiveSearchRequest++;
    if (onlineSearch.status === "loading") {
      onlineSearch = { status: "idle", results: [], error: "", query: "", selectedVideoId: "", playerError: "" };
    }
    if (archiveSearch.status === "loading") {
      archiveSearch = { status: "idle", results: [], error: "", query: "", selectedId: "" };
    }
    onlineSearch.selectedVideoId = "";
    onlineSearch.playerError = "";
    archiveSearch.selectedId = "";
    youtubeLinkTitle = "";
    destroyYouTubePlayer();
  }
  currentView = view;
  activePlaylistId = playlistId;
  if (addHistory) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push({ view, playlistId });
    historyIndex = historyStack.length - 1;
  }
  document.querySelectorAll(".nav-link").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view || (view === "playlist" && button.dataset.view === "playlists"));
  });
  renderContent();
}

function renderContent() {
  if (currentView !== "search") destroyYouTubePlayer();
  if (currentView === "home") renderHome();
  else if (currentView === "library") renderLibrary();
  else if (currentView === "playlists") renderPlaylists();
  else if (currentView === "favorites") renderFavorites();
  else if (currentView === "search") renderSearch();
  else if (currentView === "playlist") renderPlaylist();
  else if (currentView === "connections") renderConnections();
}

function trackMatches(track, query) {
  const normalized = query.toLowerCase();
  return [track.title, track.artist, track.album, ...(track.tags || [])].some(value => String(value || "").toLowerCase().includes(normalized));
}

function renderHome() {
  const localTracks = tracks.filter(track => track.blob);
  const recent = localTracks.filter(track => track.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 6);
  const recommendations = recommendTracks();
  const libraryPreview = [...localTracks].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 8);
  content.innerHTML = `
    <section>
      <div class="section-heading dashboard-heading"><div><span class="eyebrow">YOUR LISTENING</span><h1>Recently Played</h1></div></div>
      ${recent.length ? `<div class="recent-grid">${recent.map(track => quickCard(track, "recent")).join("")}</div>` : `<div class="quiet-empty"><span class="quiet-empty-icon">♫</span><span>Tracks you play will appear here.</span></div>`}
    </section>
    ${recommendations.length ? `<section><div class="section-heading"><div><h2>For you</h2><p>Picked from your local listening history</p></div></div><div class="quick-grid">${recommendations.map(track => quickCard(track, "recommendation")).join("")}</div></section>` : ""}
    <section>
      <div class="section-heading"><div><h2>Your Local Library</h2><p>${localTracks.length} ${localTracks.length === 1 ? "track" : "tracks"}</p></div><button class="quiet-button" data-view="library">View library →</button></div>
      ${libraryPreview.length ? trackTable(libraryPreview) : `<div class="library-empty"><span>Your music, ready when you are.</span><button class="secondary-button" data-action="add-files">＋ Add music</button></div>`}
    </section>`;
}

function quickCard(track, context) {
  return `<button class="quick-card ${context === "recent" ? "recent-card" : ""}" data-action="play-track" data-id="${escapeHTML(track.id)}" data-context="${context}" aria-label="Play ${escapeHTML(track.title)}">
    ${coverMarkup(track)}<span class="quick-card-copy"><strong>${escapeHTML(track.title)}</strong><span>${escapeHTML(track.artist)}</span></span><span class="quick-play" aria-hidden="true">▶</span>
  </button>`;
}

function emptyState(title, message, buttonLabel = "Add music", action = "add-files") {
  return `<div class="empty-state"><div><div class="empty-icon">♫</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(message)}</p><button class="primary-button" data-action="${action}">${escapeHTML(buttonLabel)}</button></div></div>`;
}

function renderLibrary() {
  const localTracks = tracks.filter(track => track.blob);
  const sorted = [...localTracks].sort((a, b) => b.addedAt - a.addedAt);
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">ALL YOUR MUSIC</span><h1>Your library</h1></div><div class="button-row"><button class="secondary-button" data-action="import-playlist">Import .m3u</button><button class="primary-button" data-action="add-files">＋ Add music</button></div></div>
    ${localTracks.length ? `<div class="section-heading"><h2>Songs <span class="track-count">${localTracks.length}</span></h2><button class="quiet-button" data-action="create-playlist">＋ New playlist</button></div>${trackTable(sorted)}` : emptyState("Your library starts here", "Add music files from your device. Audio is stored in this browser and is never uploaded.", "＋ Add music")}
    <section><div class="section-heading"><h2>Your playlists <span class="track-count">${playlists.length}</span></h2><button class="quiet-button" data-action="create-playlist">＋ Create playlist</button></div>
      ${playlists.length ? `<div class="quick-grid">${playlists.map(playlistCard).join("")}</div>` : `<p class="recommendation-note">Make a playlist, add tracks, and give it your own color.</p>`}
    </section>`;
}

function renderPlaylists() {
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">YOUR COLLECTION</span><h1>Playlists</h1></div><button class="primary-button" data-action="create-playlist">＋ New playlist</button></div>
    ${playlists.length ? `<div class="playlist-grid">${playlists.map(playlistCard).join("")}</div>` : `<div class="library-empty"><span>Create a playlist to collect your favorite tracks.</span><button class="secondary-button" data-action="create-playlist">＋ Create playlist</button></div>`}`;
}

function renderFavorites() {
  const favorites = tracks.filter(track => track.blob && track.favorite).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">SAVED TRACKS</span><h1>Favorites</h1></div></div>
    ${favorites.length ? trackTable(favorites) : `<div class="library-empty"><span>Tracks you favorite will be collected here.</span><button class="quiet-button" data-view="library">Browse your library →</button></div>`}`;
}

function playlistCard(playlist) {
  const [first, second] = playlistPalette(playlist);
  return `<button class="quick-card" data-action="open-playlist" data-id="${escapeHTML(playlist.id)}">
    <div class="cover-art" style="--cover-a:${first};--cover-b:${second}"><span>♫</span></div>
    <span class="quick-card-copy"><strong>${escapeHTML(playlist.name)}</strong><span>${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "song" : "songs"}</span></span>
  </button>`;
}

function renderSearch() {
  const results = searchQuery.trim() ? tracks.filter(track => track.blob && trackMatches(track, searchQuery.trim())) : [];
  const headerSearch = document.querySelector("#search-input");
  const onlineConfigured = Boolean(youtubeConfig.apiKey);
  const localResults = `<section><div class="section-heading"><h2>Your library <span class="track-count">${results.length}</span></h2></div>${searchQuery.trim() ? results.length ? trackTable(results) : emptyState("No local matches", "Try another title or artist, or search public videos or Archive audio.") : emptyState("Search your collection", "Find a song, artist, album, or tag in the music you have added.")}</section>`;
  const onlineResults = searchSource === "youtube" ? renderOnlineSearchResults() : renderArchiveSearchResults();
  const searchLabels = {
    local: ["What do you want to play?", "Search your local music"],
    youtube: ["Search YouTube videos or paste a link…", "Search YouTube videos or paste a video link"],
    archive: ["Search Internet Archive audio…", "Search Internet Archive audio"]
  };
  headerSearch.placeholder = searchLabels[searchSource][0];
  headerSearch.setAttribute("aria-label", searchLabels[searchSource][1]);
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">FIND A FAVORITE</span><h1>Search</h1></div></div>
    <div class="search-source-tabs" role="tablist" aria-label="Search source">
      <button class="search-source-tab ${searchSource === "local" ? "active" : ""}" role="tab" aria-selected="${searchSource === "local"}" data-action="search-source" data-source="local">Your library</button>
      <button class="search-source-tab ${searchSource === "youtube" ? "active" : ""}" role="tab" aria-selected="${searchSource === "youtube"}" data-action="search-source" data-source="youtube">YouTube <span class="youtube-label">VIDEOS</span></button>
      <button class="search-source-tab ${searchSource === "archive" ? "active" : ""}" role="tab" aria-selected="${searchSource === "archive"}" data-action="search-source" data-source="archive">Internet Archive <span class="archive-license-label">AUDIO</span></button>
    </div>
    ${searchSource === "local" ? localResults : `<form id="online-search-form" class="online-search-form">
      <span class="youtube-source-mark" aria-hidden="true">${searchSource === "youtube" ? "▶" : "♫"}</span><span>${searchSource === "youtube" ? `Search public <strong>YouTube videos</strong>. Playback stays in YouTube's embedded player.` : `Search <strong>Internet Archive audio</strong>. No API key or payment is needed.`}</span>
      <button class="primary-button" type="submit" ${searchSource === "youtube" && (!youtubeConfigLoaded || !onlineConfigured) ? "disabled" : ""}>${searchSource === "youtube" ? "Search YouTube" : "Search Archive"}</button>
    </form>${searchSource === "youtube" ? `
      <form id="youtube-link-form" class="youtube-link-form">
        <label for="youtube-link-input">Or paste a YouTube video link</label>
        <div><input id="youtube-link-input" name="url" type="url" placeholder="https://www.youtube.com/watch?v=…" required><button class="secondary-button" type="submit">Play link</button></div>
        <p class="form-feedback" role="status">${escapeHTML(youtubeLinkError)}</p>
      </form>` : ""}
    ${onlineResults}
    ${searchSource === "youtube" ? `${onlineConfigured ? "" : `<p class="online-setup-hint">Keyword search needs an API key. <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery.trim())}" target="_blank" rel="noopener noreferrer">Search YouTube in a new tab</a>, then paste a video link above.</p>`}
    <p class="recommendation-note">This searches YouTube videos, not YouTube Music catalogs, accounts, or subscriptions. Results play only in YouTube's official player and are not added to your local library or playlists.</p>` : `
    <p class="recommendation-note">Internet Archive results are hosted by Archive.org. Musick only enables embedded playback when the item metadata declares a supported open license (Public Domain, CC0, CC BY, or CC BY-SA); other items can still be opened at the source. Verify the item and license details before use.</p>`}`}`;
}

function renderOnlineSearchResults() {
  const selectedVideo = onlineSearch.results.find(item => item.id.videoId === onlineSearch.selectedVideoId);
  const player = onlineSearch.selectedVideoId ? `
    <section class="youtube-player-card">
      <div class="youtube-player-heading"><div><span class="youtube-label">YOUTUBE VIDEO</span><h2>${escapeHTML(selectedVideo?.snippet.title || youtubeLinkTitle || "YouTube video")}</h2></div><button class="secondary-button" data-action="close-youtube-player">Close player</button></div>
      <div class="youtube-player-frame"><div id="youtube-player"></div></div>
      <p id="youtube-player-error" class="youtube-player-error" role="status">${escapeHTML(onlineSearch.playerError || (youtubePlayer ? "" : "Loading YouTube's embedded player…"))}</p>
      <p class="recommendation-note">Playing via YouTube's official embedded player. Musick does not extract or handle YouTube audio.</p>
    </section>` : "";

  if (youtubeConfigError) return `${player}${onlineSearchState("error", "YouTube settings could not be loaded.", youtubeConfigError)}`;
  if (!youtubeConfigLoaded) return `${player}${onlineSearchState("loading", "Checking online search configuration…")}`;
  if (!youtubeConfig.apiKey) return `${player}${onlineSearchState("empty", "YouTube search needs an API key.", "You can still play a video without a key: paste its YouTube link above.")}`;
  if (!searchQuery.trim()) return `${player}${onlineSearchState("empty", "Search YouTube for a video.", "Type a song, artist, or video in the search box above, then choose Search YouTube. Search uses the official YouTube Data API.")}`;

  if (onlineSearch.status === "loading") return `${player}${onlineSearchState("loading", "Searching YouTube…")}`;
  if (onlineSearch.status === "error") return `${player}${onlineSearchState("error", "YouTube search failed.", onlineSearch.error)}`;
  if (onlineSearch.status === "no-results") return `${player}${onlineSearchState("empty", "No YouTube videos found.", `No results for “${searchQuery.trim()}”. Try another search.`)}`;
  if (!onlineSearch.results.length) return `${player}${onlineSearchState("empty", "Ready to search YouTube.", "Search only runs when you press the button. It does not run on every keystroke.")}`;

  return `${player}<section><div class="section-heading"><h2>YouTube results <span class="track-count">${onlineSearch.results.length}</span></h2></div><div class="youtube-results-grid">${onlineSearch.results.map(youtubeResultCard).join("")}</div></section>`;
}

function renderArchiveSearchResults() {
  const player = archiveSearch.selectedId ? `
    <section class="youtube-player-card">
      <div class="youtube-player-heading"><div><span class="archive-license-label">INTERNET ARCHIVE AUDIO</span><h2>${escapeHTML(archiveSearch.results.find(item => item.identifier === archiveSearch.selectedId)?.title || "Archive audio")}</h2></div><button class="secondary-button" data-action="close-archive-player">Close player</button></div>
      <div class="youtube-player-frame archive-player-frame"><iframe title="Internet Archive audio player" src="https://archive.org/embed/${encodeURIComponent(archiveSearch.selectedId)}" allow="autoplay; fullscreen" loading="lazy"></iframe></div>
      <p class="recommendation-note">Playback is provided by Internet Archive's embedded player. Musick does not download or re-host this audio.</p>
    </section>` : "";
  if (archiveSearch.status === "loading") return `${player}${onlineSearchState("loading", "Searching Internet Archive…")}`;
  if (archiveSearch.status === "error") return `${player}${onlineSearchState("error", "Internet Archive search failed.", archiveSearch.error)}`;
  if (archiveSearch.status === "no-results") return `${player}${onlineSearchState("empty", "No Archive audio found.", `No audio results for “${searchQuery.trim()}”. Try another search.`)}`;
  if (!archiveSearch.results.length) return `${player}${onlineSearchState("empty", "Search Internet Archive audio.", "Search public archive records by title or creator. No API key or payment is required.")}`;

  return `${player}<section><div class="section-heading"><h2>Internet Archive audio <span class="track-count">${archiveSearch.results.length}</span></h2></div><div class="youtube-results-grid">${archiveSearch.results.map(archiveResultCard).join("")}</div></section>`;
}

function onlineSearchState(kind, title, message = "") {
  const icon = kind === "loading" ? `<span class="online-spinner" aria-hidden="true"></span>` : `<span class="empty-icon">${kind === "error" ? "!" : "▶"}</span>`;
  return `<div class="empty-state online-search-state ${kind}" role="${kind === "error" ? "alert" : "status"}"><div>${icon}<h3>${escapeHTML(title)}</h3>${message ? `<p>${escapeHTML(message)}</p>` : ""}</div></div>`;
}

function youtubeResultCard(video) {
  const id = video.id.videoId;
  const snippet = video.snippet;
  const thumbnail = snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "";
  const published = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString() : "";
  return `<article class="youtube-result">
    <button class="youtube-result-play" data-action="play-youtube" data-id="${escapeHTML(id)}" aria-label="Play ${escapeHTML(snippet.title)} in the YouTube player">
      <img src="${escapeHTML(thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="youtube-play-overlay" aria-hidden="true">▶</span>
    </button>
    <div class="youtube-result-copy"><div class="youtube-result-label"><span class="youtube-label">YOUTUBE</span>${published ? `<span>${escapeHTML(published)}</span>` : ""}</div>
      <h3>${escapeHTML(snippet.title)}</h3><p>${escapeHTML(snippet.channelTitle)}</p>
      <button class="secondary-button" data-action="play-youtube" data-id="${escapeHTML(id)}">Play in YouTube</button>
    </div>
  </article>`;
}

function archiveLicenseStatus(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const license = new URL(value);
    if (!["http:", "https:"].includes(license.protocol) || license.hostname.toLowerCase() !== "creativecommons.org") return "";
    const path = license.pathname.toLowerCase();
    if (/^\/publicdomain\/(zero|mark)\/(?:1\.0\/?)?$/.test(path)) return "Public Domain / CC0";
    const match = path.match(/^\/licenses\/(by|by-sa|by-nc|by-nd|by-nc-sa|by-nc-nd)\/(\d+\.\d+)\/?$/);
    if (!match || !["by", "by-sa"].includes(match[1])) return "";
    return match[1] === "by" ? `CC BY ${match[2]}` : `CC BY-SA ${match[2]}`;
  } catch {
    return "";
  }
}

function archiveResultCard(item) {
  const creator = Array.isArray(item.creator) ? item.creator.join(", ") : item.creator || "Creator not listed";
  const license = archiveLicenseStatus(item.licenseurl);
  const identifier = encodeURIComponent(item.identifier);
  return `<article class="youtube-result archive-result">
    <div class="archive-result-mark" aria-hidden="true">♫</div>
    <div class="youtube-result-copy"><div class="youtube-result-label"><span class="archive-license-label">INTERNET ARCHIVE</span><span>${escapeHTML(license || "License not verified")}</span></div>
      <h3>${escapeHTML(item.title || item.identifier)}</h3><p>${escapeHTML(creator)}</p>
      <div class="archive-result-actions">${license ? `<button class="secondary-button" data-action="play-archive" data-id="${escapeHTML(item.identifier)}">Play in Archive</button>` : `<span class="recommendation-note">Musick won't embed playback without a supported open license.</span>`}
      <a class="secondary-button" href="https://archive.org/details/${identifier}" target="_blank" rel="noopener noreferrer">View source</a></div>
    </div>
  </article>`;
}

function searchSourceChanged(source) {
  if (!["local", "youtube", "archive"].includes(source) || source === searchSource) return;
  onlineSearchController?.abort();
  archiveSearchController?.abort();
  searchSource = source;
  onlineSearch = { status: "idle", results: [], error: "", query: "", selectedVideoId: "", playerError: "" };
  archiveSearch = { status: "idle", results: [], error: "", query: "", selectedId: "" };
  youtubeLinkTitle = "";
  youtubeLinkError = "";
  destroyYouTubePlayer();
  renderSearch();
}

async function loadYouTubeConfig() {
  try {
    const response = await fetch("./youtube-config.local.json", { cache: "no-store" });
    if (!response.ok && response.status !== 404) throw new Error(`Local YouTube settings returned HTTP ${response.status}.`);
    if (response.ok) {
      const config = await response.json();
      if (typeof config.apiKey !== "string") throw new Error("youtube-config.local.json must define an apiKey string.");
      youtubeConfig = { apiKey: config.apiKey.trim() };
    }
  } catch (error) {
    youtubeConfigError = error.message;
    console.error("Could not load local YouTube search settings.", error);
  } finally {
    youtubeConfigLoaded = true;
    if (currentView === "search" && searchSource === "youtube") renderSearch();
  }
}

async function searchYouTubeVideos() {
  const query = searchQuery.trim();
  if (!query) {
    onlineSearch = { status: "empty", results: [], error: "", query: "", selectedVideoId: "", playerError: "" };
    renderSearch();
    return;
  }
  if (!youtubeConfigLoaded || !youtubeConfig.apiKey) {
    onlineSearch = { status: "error", results: [], error: youtubeConfigError || "Configure a restricted YouTube Data API key to enable online search.", query, selectedVideoId: "", playerError: "" };
    renderSearch();
    return;
  }
  if (!["https:", "http:"].includes(location.protocol)) {
    onlineSearch = { status: "error", results: [], error: "Online search requires a local or hosted HTTP server. Open Musick at a localhost or HTTPS address instead of file://.", query, selectedVideoId: "", playerError: "" };
    renderSearch();
    return;
  }

  onlineSearchController?.abort();
  onlineSearchController = new AbortController();
  const requestId = ++onlineSearchRequest;
  onlineSearch = { status: "loading", results: [], error: "", query, selectedVideoId: "", playerError: "" };
  destroyYouTubePlayer();
  renderSearch();
  try {
    const parameters = new URLSearchParams({
      part: "snippet", type: "video", videoEmbeddable: "true", safeSearch: "moderate",
      maxResults: "12", q: query, fields: "items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt,snippet/thumbnails/default/url,snippet/thumbnails/medium/url)",
      key: youtubeConfig.apiKey
    });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${parameters}`, { signal: onlineSearchController.signal });
    const body = await response.json();
    if (!response.ok || body.error) {
      const reason = body.error?.errors?.[0]?.reason;
      const message = body.error?.message || `YouTube returned HTTP ${response.status}.`;
      throw new Error(reason ? `${message} (${reason})` : message);
    }
    if (requestId !== onlineSearchRequest) return;
    const results = Array.isArray(body.items) ? body.items.filter(item => item?.id?.videoId && item?.snippet?.title) : [];
    onlineSearch = { status: results.length ? "results" : "no-results", results, error: "", query, selectedVideoId: "", playerError: "" };
    renderSearch();
  } catch (error) {
    if (error.name === "AbortError" || requestId !== onlineSearchRequest) return;
    onlineSearch = { status: "error", results: [], error: error.message, query, selectedVideoId: "", playerError: "" };
    renderSearch();
  }
}

async function searchArchiveAudio() {
  const query = searchQuery.trim();
  if (!query) {
    archiveSearch = { status: "idle", results: [], error: "", query: "", selectedId: "" };
    renderSearch();
    return;
  }
  archiveSearchController?.abort();
  archiveSearchController = new AbortController();
  const requestId = ++archiveSearchRequest;
  archiveSearch = { status: "loading", results: [], error: "", query, selectedId: "" };
  renderSearch();
  try {
    const phrase = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const parameters = new URLSearchParams();
    parameters.set("q", `mediatype:audio AND (title:"${phrase}" OR creator:"${phrase}")`);
    ["identifier", "title", "creator", "licenseurl"].forEach(field => parameters.append("fl[]", field));
    parameters.set("rows", "12");
    parameters.set("page", "1");
    parameters.set("output", "json");
    const response = await fetch(`https://archive.org/advancedsearch.php?${parameters}`, { signal: archiveSearchController.signal });
    if (!response.ok) throw new Error(`Internet Archive returned HTTP ${response.status}.`);
    const body = await response.json();
    if (body.responseHeader?.status !== 0 || !Array.isArray(body.response?.docs)) throw new Error("Internet Archive returned an unexpected search response.");
    if (requestId !== archiveSearchRequest) return;
    const results = body.response.docs.filter(item => typeof item.identifier === "string");
    archiveSearch = { status: results.length ? "results" : "no-results", results, error: "", query, selectedId: "" };
    renderSearch();
  } catch (error) {
    if (error.name === "AbortError" || requestId !== archiveSearchRequest) return;
    archiveSearch = { status: "error", results: [], error: error.message, query, selectedId: "" };
    renderSearch();
  }
}

function playYouTubeLink(value) {
  youtubeLinkError = "";
  try {
    if (typeof value !== "string") throw new Error("Paste a YouTube video link.");
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) throw new Error("Paste a link from youtube.com or youtu.be.");
    let videoId = "";
    if (host === "youtu.be") videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    else if (url.pathname === "/watch") videoId = url.searchParams.get("v") || "";
    else if (/^\/(embed|shorts)\/[^/]+/.test(url.pathname)) videoId = url.pathname.split("/")[2] || "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("That link does not contain a valid YouTube video ID.");
    onlineSearchController?.abort();
    onlineSearchRequest++;
    onlineSearch = { status: "idle", results: [], error: "", query: "", selectedVideoId: videoId, playerError: "" };
    youtubeLinkTitle = "YouTube video";
    destroyYouTubePlayer();
    renderSearch();
    playYouTubeVideo(videoId);
  } catch (error) {
    youtubeLinkError = error.message;
    renderSearch();
  }
}

function playArchiveItem(identifier) {
  const item = archiveSearch.results.find(result => result.identifier === identifier);
  if (!item || !archiveLicenseStatus(item.licenseurl)) return;
  audio.pause();
  archiveSearch.selectedId = identifier;
  renderSearch();
}

function loadYouTubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubePlayerApiPromise) return youtubePlayerApiPromise;
  youtubePlayerApiPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === "function") previousCallback();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      youtubePlayerApiPromise = null;
      reject(new Error("YouTube's official embedded player API could not be loaded. Check your connection and content-security settings."));
    };
    document.head.append(script);
  });
  return youtubePlayerApiPromise;
}

async function playYouTubeVideo(videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
  audio.pause();
  onlineSearch.selectedVideoId = videoId;
  onlineSearch.playerError = "";
  destroyYouTubePlayer();
  renderSearch();
  try {
    await loadYouTubeIframeApi();
    if (onlineSearch.selectedVideoId !== videoId || !document.querySelector("#youtube-player")) return;
    const origin = location.origin;
    youtubePlayer = new window.YT.Player("youtube-player", {
      host: "https://www.youtube-nocookie.com",
      width: "100%",
      height: "100%",
      videoId,
      playerVars: { autoplay: 1, controls: 1, playsinline: 1, rel: 0, origin },
      events: {
        onReady: event => event.target.playVideo(),
        onError: event => {
          const messages = {
            2: "YouTube rejected this video's ID or player parameters.",
            5: "This video could not play in YouTube's HTML5 embedded player.",
            100: "This video is unavailable, private, or has been removed.",
            101: "The video owner does not allow playback in embedded players.",
            150: "The video owner does not allow playback in embedded players.",
            153: "YouTube needs a valid HTTP referrer. Serve Musick from localhost or HTTPS."
          };
          onlineSearch.playerError = messages[event.data] || `YouTube's embedded player reported error ${event.data}.`;
          const errorElement = document.querySelector("#youtube-player-error");
          if (errorElement) errorElement.textContent = onlineSearch.playerError;
        }
      }
    });
  } catch (error) {
    onlineSearch.playerError = error.message;
    const errorElement = document.querySelector("#youtube-player-error");
    if (errorElement) errorElement.textContent = error.message;
  }
}

function destroyYouTubePlayer() {
  if (youtubePlayer && typeof youtubePlayer.destroy === "function") youtubePlayer.destroy();
  youtubePlayer = null;
}

function renderPlaylist() {
  const playlist = playlists.find(item => item.id === activePlaylistId);
  if (!playlist) {
    changeView("library", null, false);
    return;
  }
  const playlistTracks = playlist.trackIds.map(id => tracks.find(track => track.id === id)).filter(Boolean);
  const [first, second] = playlistPalette(playlist);
  content.innerHTML = `
    <div class="playlist-hero">
      <div class="cover-art" style="--cover-a:${first};--cover-b:${second}" aria-hidden="true"><span>♫</span></div>
      <div class="playlist-hero-copy"><span class="eyebrow">PLAYLIST</span><h1>${escapeHTML(playlist.name)}</h1><p>${playlistTracks.length} ${playlistTracks.length === 1 ? "song" : "songs"} · on this device</p></div>
    </div>
    <div class="playlist-tools">
      <button class="primary-button" data-action="play-playlist" data-id="${escapeHTML(playlist.id)}" aria-label="Play playlist" title="Play playlist">▶</button>
      <button class="secondary-button" data-action="add-files">＋ Add music</button>
      <button class="secondary-button" data-action="rename-playlist" data-id="${escapeHTML(playlist.id)}">Rename</button>
      <button class="secondary-button" data-action="export-playlist" data-id="${escapeHTML(playlist.id)}">Export .m3u</button>
      <label class="visually-hidden" for="playlist-color">Playlist color</label><input id="playlist-color" type="color" value="${escapeHTML(playlist.color || "#a980ff")}" data-action="playlist-color" data-id="${escapeHTML(playlist.id)}" title="Customize playlist color">
      <button class="icon-button small" data-action="delete-playlist" data-id="${escapeHTML(playlist.id)}" aria-label="Delete playlist" title="Delete playlist">⋯</button>
    </div>
    ${playlistTracks.length ? trackTable(playlistTracks, true) : emptyState("This playlist is yours to fill", "Add local music files to get your playlist started.", "＋ Add music")}`;
}

function trackTable(items, removable = false) {
  if (!items.length) return emptyState("No songs yet", "Add audio from your device to get your library started.");
  return `<div class="track-table-wrap"><table class="track-table"><thead><tr><th>#</th><th>Title</th><th>Artist</th><th>Album</th><th>Date added</th><th>Duration</th><th></th></tr></thead><tbody>
    ${items.map((track, index) => `<tr class="track-row ${track.id === currentTrackId ? "current" : ""}" draggable="${removable ? "true" : "false"}" data-track-row="${escapeHTML(track.id)}" data-playlist-id="${removable ? escapeHTML(activePlaylistId) : ""}">
      <td class="track-position">${track.id === currentTrackId && !audio.paused ? `<span class="playing-indicator" aria-label="Now playing"><i></i><i></i><i></i></span>` : String(index + 1).padStart(2, "0")}</td>
      <td><div class="track-title">${coverMarkup(track)}<span class="track-title-copy"><strong>${escapeHTML(track.title)}</strong></span></div></td>
      <td class="track-artist">${escapeHTML(track.artist || "Unknown artist")}</td>
      <td class="track-album">${escapeHTML(track.album || "—")}</td><td class="track-date">${track.addedAt ? new Date(track.addedAt).toLocaleDateString() : "—"}</td><td class="track-duration">${formatTime(track.duration)}</td>
      <td><div class="track-actions"><button class="favorite ${track.favorite ? "active" : ""}" data-action="favorite" data-id="${escapeHTML(track.id)}" aria-label="${track.favorite ? "Remove from" : "Add to"} favorites">${track.favorite ? "♥" : "♡"}</button>${removable ? `<button data-action="remove-from-playlist" data-id="${escapeHTML(track.id)}" aria-label="Remove from playlist" title="Remove from playlist">−</button>` : `<button data-action="track-menu" data-id="${escapeHTML(track.id)}" aria-label="Track options" title="Add to playlist">···</button>`}</div></td>
    </tr>`).join("")}
  </tbody></table></div>`;
}

function renderConnections() {
  const email = authSession?.user?.email;
  const authCard = email ? `
    <article class="auth-card signed-in">
      <div><span class="eyebrow">SUPABASE ACCOUNT</span><h2>Signed in</h2><p>Playlist sync requires the database migration. Audio files and lyrics stay on this device.</p><span class="connection-state">Signed in as ${escapeHTML(email)}</span></div>
      <button class="secondary-button" data-action="sign-out">Sign out</button>
    </article>` : `
    <form id="auth-form" class="auth-card">
      <div><span class="eyebrow">SUPABASE ACCOUNT</span><h2>${pendingAuthMode === "signup" ? "Create your account" : "Sign in to Musick"}</h2><p>Sync playlist names, colors, and track lists between devices after the database migration is applied. Audio stays local.</p></div>
      <label for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com">
      <label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${pendingAuthMode === "signup" ? "new-password" : "current-password"}" required minlength="8" maxlength="128" placeholder="At least 8 characters">
      <div class="auth-actions"><button class="primary-button" type="submit">${pendingAuthMode === "signup" ? "Create account" : "Sign in"}</button><button class="quiet-button" type="button" data-action="toggle-auth-mode">${pendingAuthMode === "signup" ? "Already have an account? Sign in" : "New to Musick? Create account"}</button></div>
      <p id="auth-feedback" class="auth-feedback" role="status">${escapeHTML(authFeedback)}</p>
    </form>`;
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">YOUR OTHER MUSIC APPS</span><h1>Connect a service</h1></div></div>
    ${authCard}
    <p class="recommendation-note">Musick is open source, but connecting, importing, and streaming depend on each service's official APIs, account permissions, and licensing. Music-service passwords are never collected by this app.</p>
    <div class="connections-grid">
      ${connectionCard("S", "Spotify", "Import playlist and library metadata with an approved Spotify developer app. Spotify does not provide unrestricted lossless streaming to independent players.", "Developer app and OAuth setup required")}
      ${connectionCard("A", "Apple Music", "Apple MusicKit can provide catalog access and subscriber playback when configured with an Apple developer token and a user's authorization.", "Apple developer token required")}
      ${connectionCard("▶", "YouTube Music", "YouTube Music does not offer a general public API for third-party account login, playlist import, or music streaming.", "No official public music API")}
    </div>
    <div class="info-callout"><strong>Streaming & subscriptions:</strong> Musick cannot read subscription status or bypass DRM. A service must explicitly support playback and account checks through its official SDK. Your local audio works now; provider connections can be added when you choose a service and supply its developer credentials.</div>
    <section><div class="section-heading"><h2>Backend</h2></div><p class="recommendation-note">${email ? "Supabase sign-in is active. Playlist metadata syncs after the database migration has been applied; the audio library stays on this device." : "Sign in above to sync playlist metadata after the database migration has been applied. Never put a service-role key in a client app."}</p></section>`;
}

function connectionCard(mark, name, description, state) {
  return `<article class="connection-card"><div class="connection-top"><div class="service-logo">${escapeHTML(mark)}</div><h3>${escapeHTML(name)}</h3></div><p>${escapeHTML(description)}</p><span class="connection-state unavailable">${escapeHTML(state)}</span><button class="secondary-button" data-action="connection-info" data-service="${escapeHTML(name)}">Setup details</button></article>`;
}

function recommendTracks() {
  const eligible = tracks.filter(track => track.blob && track.id !== currentTrackId);
  if (!eligible.length) return [];
  const recentlyPlayed = new Set([...tracks].filter(track => track.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 4).map(track => track.id));
  const favoriteArtists = new Set(tracks.filter(track => track.favorite || (track.playCount || 0) > 1).map(track => track.artist.toLowerCase()));
  return eligible.map(track => ({
    track,
    score: (track.favorite ? 5 : 0) + Math.min(track.playCount || 0, 8) * .6
      + (favoriteArtists.has(track.artist.toLowerCase()) ? 2 : 0)
      + (track.lastPlayed ? Math.max(0, 2 - (Date.now() - track.lastPlayed) / 86400000 * .1) : 0)
      + (recentlyPlayed.has(track.id) ? -4 : 1)
  })).sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title)).slice(0, 6).map(entry => entry.track);
}

function syncNowPlaying() {
  const track = tracks.find(item => item.id === currentTrackId);
  const target = document.querySelector("#now-playing");
  if (!track) {
    target.innerHTML = `<div class="cover-art" style="--cover-a:#332c40;--cover-b:#17141c"><span>♫</span></div><span class="now-playing-copy"><strong>Nothing playing</strong><span>Add your own music</span></span>`;
    document.querySelector(".play-button").textContent = "▶";
    document.querySelector(".play-button").setAttribute("aria-label", "Play");
    document.querySelector("#lyrics-play-button").textContent = "▶";
    document.querySelector("#lyrics-play-button").setAttribute("aria-label", "Play");
    document.querySelector("#duration-time").textContent = "0:00";
    document.querySelector("#lyrics-duration-time").textContent = "0:00";
    document.querySelector("#current-time").textContent = "0:00";
    document.querySelector("#lyrics-current-time").textContent = "0:00";
    seekBar.value = "0";
    document.querySelector("#lyrics-seek-bar").value = "0";
    document.querySelector("#lyrics-track-heading").textContent = "Nothing playing";
    document.querySelector("#lyrics-song-title").textContent = "Your music, your words.";
    document.querySelector("#lyrics-artist").textContent = "";
    updateLyricsDisplay();
    return;
  }
  target.innerHTML = `${coverMarkup(track)}<span class="now-playing-copy"><strong>${escapeHTML(track.title)}</strong><span>${escapeHTML(track.artist)}</span></span><button class="favorite-now ${track.favorite ? "active" : ""}" data-action="favorite" data-id="${escapeHTML(track.id)}" aria-label="Toggle favorite">${track.favorite ? "♥" : "♡"}</button>`;
  document.querySelector(".play-button").textContent = audio.paused ? "▶" : "Ⅱ";
  document.querySelector(".play-button").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  document.querySelector("#lyrics-play-button").textContent = audio.paused ? "▶" : "Ⅱ";
  document.querySelector("#lyrics-play-button").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  document.querySelector("#lyrics-track-heading").textContent = `${track.title} · ${track.artist}`;
  document.querySelector("#lyrics-song-title").textContent = track.title;
  document.querySelector("#lyrics-artist").textContent = track.artist;
  document.querySelector("#lyrics-art").style.background = `linear-gradient(145deg,${paletteFor(track).join(",")})`;
  document.querySelector("#duration-time").textContent = formatTime(audio.duration || track.duration);
  document.querySelector("#lyrics-duration-time").textContent = formatTime(audio.duration || track.duration);
  updateLyricsDisplay();
}

function ensureAudioGraph() {
  if (audioContext) {
    if (audioContext.state === "running") return Promise.resolve(true);
    return resumeAudioGraph(audioContext);
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    warnAudioGraphUnavailable(new Error("This browser does not support Web Audio."));
    return Promise.resolve(false);
  }
  let context;
  let source;
  try {
    context = new AudioContextClass();
    source = context.createMediaElementSource(audio);
    const output = context.createGain();
    const equalizerFilters = EQ_FREQUENCIES.map((frequency, index) => {
      const filter = context.createBiquadFilter();
      filter.type = index === 0 ? "lowshelf" : index === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      filter.gain.value = Number(document.querySelector(`[data-band="${index}"]`).value);
      return filter;
    });
    source.connect(equalizerFilters[0]);
    for (let index = 0; index < equalizerFilters.length - 1; index++) equalizerFilters[index].connect(equalizerFilters[index + 1]);
    equalizerFilters[equalizerFilters.length - 1].connect(output);
    output.connect(context.destination);
    audioContext = context;
    mediaSource = source;
    gainNode = output;
    filters = equalizerFilters;
    return resumeAudioGraph(context);
  } catch (error) {
    if (source && context) {
      try {
        source.disconnect();
        source.connect(context.destination);
        audioContext = context;
        mediaSource = source;
      } catch (fallbackError) {
        console.error("Could not connect audio through the equalizer or the direct Web Audio output.", fallbackError);
      }
    }
    warnAudioGraphUnavailable(error);
    return context ? resumeAudioGraph(context).then(() => false) : Promise.resolve(false);
  }
}

function resumeAudioGraph(context) {
  try {
    return context.resume().then(() => true).catch(error => {
      warnAudioGraphUnavailable(error);
      return false;
    });
  } catch (error) {
    warnAudioGraphUnavailable(error);
    return Promise.resolve(false);
  }
}

function warnAudioGraphUnavailable(error) {
  console.warn("Equalizer unavailable; local track playback will continue without equalization.", error);
  if (audioGraphWarningShown) return;
  audioGraphWarningShown = true;
  showToast("Equalizer unavailable. Local playback will continue without equalization.");
}

function applyEqualizerFromControls() {
  filters.forEach((filter, index) => {
    const value = Number(document.querySelector(`[data-band="${index}"]`).value);
    filter.gain.value = value;
    updateEqualizerValue(index, value);
  });
}

function updateEqualizerValue(index, value) {
  const output = document.querySelector(`[data-eq-value="${index}"]`);
  if (output) output.textContent = `${value > 0 ? "+" : ""}${value}`;
}

function applySavedEqualizer() {
  let values;
  try {
    const saved = JSON.parse(localStorage.getItem(EQ_KEY) || "[]");
    values = Array.isArray(saved) && saved.length === EQ_FREQUENCIES.length ? saved : EQ_FREQUENCIES.map(() => 0);
  } catch (error) {
    console.error("Could not load equalizer settings.", error);
    values = EQ_FREQUENCIES.map(() => 0);
  }
  values.forEach((value, index) => {
    const numericValue = Number(value);
    const decibels = Number.isFinite(numericValue) ? Math.max(-12, Math.min(12, numericValue)) : 0;
    const slider = document.querySelector(`[data-band="${index}"]`);
    slider.value = String(decibels);
    if (filters[index]) filters[index].gain.value = decibels;
  });
}

function saveEqualizer() {
  const values = EQ_FREQUENCIES.map((_, index) => Number(document.querySelector(`[data-band="${index}"]`).value));
  try { localStorage.setItem(EQ_KEY, JSON.stringify(values)); }
  catch (error) { console.error("Could not save equalizer settings.", error); }
}

async function playTrack(id, collection = tracks) {
  const requestId = ++playbackRequest;
  const track = tracks.find(item => item.id === id);
  if (!track) return;
  if (onlineSearch.selectedVideoId) {
    onlineSearch.selectedVideoId = "";
    onlineSearch.playerError = "";
    destroyYouTubePlayer();
  }
  if (!track.blob) {
    showToast("This playlist entry is synced, but its audio file is only available on another device.");
    return;
  }
  if (currentTrackId === id && audio.src) {
    const graphReady = ensureAudioGraph();
    const playRequest = audio.play();
    try {
      await playRequest;
      if (requestId !== playbackRequest) return;
      await graphReady;
    } catch (error) {
      if (requestId !== playbackRequest) return;
      if (isM4aTrack(track) && isUnsupportedAudioError(error)) {
        try {
          await playM4aFallback(track, requestId);
          return;
        } catch (fallbackError) {
          if (requestId !== playbackRequest) return;
          error = fallbackError;
        }
      }
      showToast(playbackErrorMessage(error));
      console.error("Track playback failed.", error);
      clearFailedTrackPlayback();
    }
    syncNowPlaying();
    return;
  }
  const oldUrl = currentObjectUrl;
  let nextUrl;
  try {
    ensureAudioGraph();
    nextUrl = URL.createObjectURL(playbackBlobForTrack(track));
    audio.src = nextUrl;
    currentTrackId = id;
    const playRequest = audio.play();
    currentObjectUrl = nextUrl;
    if (oldUrl && oldUrl !== nextUrl) URL.revokeObjectURL(oldUrl);
    await playRequest;
    if (requestId !== playbackRequest) return;
    await recordTrackPlayback(track);
  } catch (error) {
    if (requestId !== playbackRequest) return;
    if (isM4aTrack(track) && isUnsupportedAudioError(error)) {
      try {
        await playM4aFallback(track, requestId);
        return;
      } catch (fallbackError) {
        if (requestId !== playbackRequest) return;
        error = fallbackError;
      }
    }
    showToast(playbackErrorMessage(error));
    console.error("Track playback failed.", error);
    if (currentTrackId === id) {
      clearFailedTrackPlayback();
    } else if (nextUrl && nextUrl !== oldUrl) {
      URL.revokeObjectURL(nextUrl);
    }
  }
}

function isM4aTrack(track) {
  return /\.m4a$/i.test(track.fileName || "");
}

function isUnsupportedAudioError(error) {
  return error.name === "NotSupportedError" || audio.error?.code === 4;
}

async function playM4aFallback(track, requestId) {
  showToast("Preparing M4A playback…");
  const { decodeM4aToWavBlob } = await import("./m4a-playback.js");
  const decodedWav = await decodeM4aToWavBlob(track.blob);
  if (requestId !== playbackRequest) return;
  const previousUrl = currentObjectUrl;
  const decodedUrl = URL.createObjectURL(decodedWav);
  audio.src = decodedUrl;
  currentObjectUrl = decodedUrl;
  if (previousUrl && previousUrl !== decodedUrl) URL.revokeObjectURL(previousUrl);
  await audio.play();
  if (requestId === playbackRequest) await recordTrackPlayback(track);
}

async function recordTrackPlayback(track) {
  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayed = Date.now();
  syncNowPlaying();
  renderContent();
  if (lyricsView.classList.contains("open")) updateLyricsDisplay();
  try {
    await persistTrack(track);
  } catch (error) {
    showToast(`Playback started, but listening history could not be saved: ${error.message}`);
    console.error("Could not persist playback history.", error);
  }
}

function clearFailedTrackPlayback() {
  const failedUrl = currentObjectUrl;
  currentTrackId = null;
  currentObjectUrl = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (failedUrl) URL.revokeObjectURL(failedUrl);
  syncNowPlaying();
}

function playbackErrorMessage(error) {
  if (isUnsupportedAudioError(error)) {
    const track = tracks.find(item => item.id === currentTrackId);
    if (isM4aTrack(track)) return "This .m4a could not be decoded. Musick's fallback supports mono/stereo ALAC and AAC-LC; other AAC profiles, codecs, or channel layouts may require browser-native support. The original file is unchanged.";
    return "This browser cannot play this audio format. Try a browser-supported MP3, WAV, AAC, or Ogg file.";
  }
  if (error.name === "NotAllowedError") {
    return "The browser blocked playback. Press Play again to allow audio.";
  }
  return `Could not play this track: ${error.message}`;
}

function playbackBlobForTrack(track) {
  if (!/\.m4a$/i.test(track.fileName || "") || track.blob.type.toLowerCase() === "audio/mp4") return track.blob;
  return new Blob([track.blob], { type: "audio/mp4" });
}

function getQueue() {
  if (currentView === "playlist") {
    const playlist = playlists.find(item => item.id === activePlaylistId);
    if (playlist) return playlist.trackIds.filter(id => tracks.some(track => track.id === id && track.blob));
  }
  if (currentView === "search" && searchQuery.trim()) return tracks.filter(track => track.blob && trackMatches(track, searchQuery.trim())).map(track => track.id);
  return tracks.filter(track => track.blob).map(track => track.id);
}

function playNext(direction = 1) {
  const queue = getQueue();
  if (!queue.length) return;
  let nextIndex;
  const currentIndex = queue.indexOf(currentTrackId);
  if (shuffleEnabled && queue.length > 1 && direction === 1) {
    const options = queue.filter(id => id !== currentTrackId);
    playTrack(options[Math.floor(Math.random() * options.length)], queue);
    return;
  }
  nextIndex = currentIndex === -1 ? (direction > 0 ? 0 : queue.length - 1) : currentIndex + direction;
  if (nextIndex < 0) nextIndex = queue.length - 1;
  if (nextIndex >= queue.length) nextIndex = 0;
  if (queue.length > 1 || queue[0] !== currentTrackId) playTrack(queue[nextIndex], queue);
  else if (repeatEnabled) { audio.currentTime = 0; audio.play(); }
  else { audio.pause(); syncNowPlaying(); }
}

async function importAudioFiles(fileList) {
  const files = [...fileList].filter(file => file.type.startsWith("audio/") || /\.(mp3|flac|wav|m4a|ogg|opus|aac)$/i.test(file.name));
  if (!files.length) {
    showToast("Choose a supported audio file to add.");
    return;
  }
  let imported = 0;
  for (const file of files) {
    const name = file.name.replace(/\.[^.]+$/, "");
    const separator = name.indexOf(" - ");
    const track = {
      id: crypto.randomUUID(),
      title: separator > 0 ? name.slice(separator + 3) : name,
      artist: separator > 0 ? name.slice(0, separator) : "Unknown artist",
      album: "",
      duration: 0,
      blob: file,
      fileName: file.name,
      size: file.size,
      favorite: false,
      playCount: 0,
      lastPlayed: null,
      addedAt: Date.now(),
      lyrics: ""
    };
    try {
      if (/\.m4a$/i.test(file.name) && file.type.toLowerCase() !== "audio/mp4") {
        track.blob = new Blob([file], { type: "audio/mp4" });
      }
      await persistTrack(track);
      imported++;
    } catch (error) {
      showToast(`Could not save ${file.name}. Check available browser storage.`);
      console.error("Audio import failed.", error);
    }
  }
  if (imported) {
    showToast(`Added ${imported} ${imported === 1 ? "track" : "tracks"} to your local library.`);
    renderSidebar();
    renderContent();
  }
}

function createPlaylist() {
  const name = window.prompt("Name your playlist");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { showToast("Give your playlist a name first."); return; }
  const playlist = { id: crypto.randomUUID(), name: trimmed, color: "#a980ff", trackIds: [], createdAt: Date.now() };
  playlists.push(playlist);
  savePlaylists();
  queueCloudSync();
  renderSidebar();
  changeView("playlist", playlist.id);
}

function addToPlaylist(track) {
  if (!playlists.length) {
    if (window.confirm("You do not have a playlist yet. Create one?")) createPlaylist();
    return;
  }
  const choices = playlists.map((playlist, index) => `${index + 1}. ${playlist.name}`).join("\n");
  const answer = window.prompt(`Add "${track.title}" to which playlist? Enter a number:\n${choices}`);
  if (answer === null) return;
  const index = Number(answer) - 1;
  const playlist = playlists[index];
  if (!playlist) { showToast("Choose a playlist number from the list."); return; }
  if (playlist.trackIds.includes(track.id)) { showToast("That song is already in this playlist."); return; }
  playlist.trackIds.push(track.id);
  savePlaylists();
  queueCloudSync();
  renderSidebar();
  renderContent();
  showToast(`Added to ${playlist.name}.`);
}

function parseLrc(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const lyric = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!timestamps.length || !lyric) continue;
    for (const match of timestamps) {
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      entries.push({ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text: lyric });
    }
  }
  return entries.sort((a, b) => a.time - b.time);
}

function updateLyricsDisplay() {
  const track = tracks.find(item => item.id === currentTrackId);
  const container = document.querySelector("#lyrics-lines");
  const heading = document.querySelector("#lyrics-song-title");
  if (!track) {
    heading.textContent = "Your music, your words.";
    container.innerHTML = `<p class="recommendation-note">Start playing a song from your library. Add a timed .lrc lyrics file if you have one.</p>`;
    return;
  }
  if (!track.lyrics) {
    container.innerHTML = `<p class="recommendation-note">No local lyrics for this song yet. Add your own timed .lrc file below.</p>`;
    return;
  }
  if (!lyricsEntries.length || lyricsEntries.trackId !== track.id) {
    lyricsEntries = parseLrc(track.lyrics);
    lyricsEntries.trackId = track.id;
  }
  if (!lyricsEntries.length) {
    container.innerHTML = `<p class="recommendation-note">This .lrc file has no timed lyrics. Check the file and try again.</p>`;
    return;
  }
  let activeIndex = -1;
  for (let index = 0; index < lyricsEntries.length; index++) {
    if (lyricsEntries[index].time <= audio.currentTime) activeIndex = index;
    else break;
  }
  container.innerHTML = lyricsEntries.map((entry, index) => `<button class="lyric-line ${index === activeIndex ? "active" : ""}" data-lyric-time="${entry.time}">${escapeHTML(entry.text)}</button>`).join("");
  const activeLine = container.querySelector(".lyric-line.active");
  if (activeLine) activeLine.scrollIntoView({ block: "center", behavior: "smooth" });
}

function openLyrics() {
  lyricsView.classList.add("open");
  lyricsView.setAttribute("aria-hidden", "false");
  updateLyricsDisplay();
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      document.body.classList.add("fullscreen-lyrics");
    } else {
      await document.exitFullscreen();
      document.body.classList.remove("fullscreen-lyrics");
    }
  } catch (error) {
    showToast(`Could not change full screen mode: ${error.message}`);
  }
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importM3u(file) {
  const text = await file.text();
  const entries = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const available = new Map(tracks.map(track => [track.fileName.toLowerCase(), track]));
  const matched = entries.map(entry => available.get(entry.split(/[\\/]/).pop().toLowerCase())).filter(Boolean);
  const name = file.name.replace(/\.m3u8?$/i, "").trim() || "Imported playlist";
  const playlist = { id: crypto.randomUUID(), name, color: "#a980ff", trackIds: matched.map(track => track.id), createdAt: Date.now() };
  playlists.push(playlist);
  savePlaylists();
  queueCloudSync();
  renderSidebar();
  changeView("playlist", playlist.id);
  if (!matched.length) showToast("Playlist imported, but no entries matched tracks in your local library.");
  else showToast(`Imported ${matched.length} ${matched.length === 1 ? "track" : "tracks"} from the playlist.`);
}

async function handleAction(button) {
  const { action, id } = button.dataset;
  if (!action) return;
  if (action === "add-files") document.querySelector("#audio-files").click();
  else if (action === "create-playlist") createPlaylist();
  else if (action === "open-playlist") changeView("playlist", id);
  else if (action === "play-track") playTrack(id);
  else if (action === "favorite") {
    const track = tracks.find(item => item.id === id);
    if (!track) return;
    track.favorite = !track.favorite;
    persistTrack(track).then(() => { syncNowPlaying(); renderContent(); }).catch(error => showToast(`Could not save favorite: ${error.message}`));
  }
  else if (action === "track-menu") {
    const track = tracks.find(item => item.id === id);
    if (track) addToPlaylist(track);
  }
  else if (action === "remove-from-playlist") {
    const playlist = playlists.find(item => item.id === activePlaylistId);
    if (!playlist) return;
    playlist.trackIds = playlist.trackIds.filter(trackId => trackId !== id);
    savePlaylists();
    queueCloudSync();
    renderSidebar();
    renderContent();
  }
  else if (action === "play-playlist") {
    const playlist = playlists.find(item => item.id === id);
    const first = playlist && playlist.trackIds.find(trackId => tracks.some(track => track.id === trackId && track.blob));
    if (first) playTrack(first);
    else showToast("Add music to this playlist before playing it.");
  }
  else if (action === "rename-playlist") {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist) return;
    const name = window.prompt("Rename playlist", playlist.name);
    if (name === null) return;
    if (!name.trim()) { showToast("Playlist name cannot be empty."); return; }
    playlist.name = name.trim();
    savePlaylists(); queueCloudSync(); renderSidebar(); renderContent();
  }
  else if (action === "delete-playlist") {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist || !window.confirm(`Delete "${playlist.name}"? Your music files will not be deleted.`)) return;
    playlists = playlists.filter(item => item.id !== id);
    savePlaylists(); deleteCloudPlaylist(id); renderSidebar(); changeView("library");
    showToast("Playlist deleted. Your music is still in your library.");
  }
  else if (action === "export-playlist") {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist) return;
    const lines = ["#EXTM3U", ...playlist.trackIds.map(trackId => tracks.find(track => track.id === trackId)).filter(Boolean).map(track => `#EXTINF:${Math.floor(track.duration || 0)},${track.artist} - ${track.title}\n${track.fileName}`)];
    downloadText(`${playlist.name.replace(/[<>:"/\\|?*]/g, "_")}.m3u`, lines.join("\n"));
  }
  else if (action === "import-playlist") document.querySelector("#playlist-file").click();
  else if (action === "connections") changeView("connections");
  else if (action === "search-source") searchSourceChanged(button.dataset.source);
  else if (action === "play-youtube") playYouTubeVideo(id);
  else if (action === "play-archive") playArchiveItem(id);
  else if (action === "close-archive-player") {
    archiveSearch.selectedId = "";
    renderSearch();
  }
  else if (action === "close-youtube-player") {
    onlineSearch.selectedVideoId = "";
    onlineSearch.playerError = "";
    youtubeLinkTitle = "";
    destroyYouTubePlayer();
    renderSearch();
  }
  else if (action === "sign-out") signOut();
  else if (action === "toggle-auth-mode") {
    pendingAuthMode = pendingAuthMode === "signin" ? "signup" : "signin";
    authFeedback = "";
    renderConnections();
  }
  else if (action === "connection-info") showToast(`${button.dataset.service} setup needs official API access and developer credentials.`);
  else if (action === "play-pause") {
    if (!currentTrackId) { showToast("Add a song to your library to start listening."); return; }
    if (audio.paused) playTrack(currentTrackId);
    else { audio.pause(); syncNowPlaying(); }
  }
  else if (action === "previous") {
    if (audio.currentTime > 3) audio.currentTime = 0;
    else playNext(-1);
  }
  else if (action === "next") playNext(1);
  else if (action === "shuffle") {
    shuffleEnabled = !shuffleEnabled;
    button.classList.toggle("active", shuffleEnabled);
    showToast(shuffleEnabled ? "Shuffle is on." : "Shuffle is off.");
  }
  else if (action === "repeat") {
    repeatEnabled = !repeatEnabled;
    button.classList.toggle("active", repeatEnabled);
    button.title = repeatEnabled ? "Repeat on" : "Repeat off";
    button.setAttribute("aria-label", button.title);
  }
  else if (action === "open-lyrics") openLyrics();
  else if (action === "close-lyrics") {
    lyricsView.classList.remove("open");
    lyricsView.setAttribute("aria-hidden", "true");
    if (document.fullscreenElement) document.exitFullscreen().catch(error => console.error("Could not exit full screen.", error));
    document.body.classList.remove("fullscreen-lyrics");
  }
  else if (action === "fullscreen") toggleFullscreen();
  else if (action === "add-lyrics") {
    if (!currentTrackId) { showToast("Play a track before adding lyrics."); return; }
    document.querySelector("#lyrics-file").click();
  }
  else if (action === "verify-lyrics") showToast("Musixmatch verification is not active; approved API credentials and licensing are required.");
  else if (action === "toggle-equalizer") {
    const panel = document.querySelector("#equalizer-panel");
    panel.hidden = !panel.hidden;
    equalizer.classList.toggle("expanded", !panel.hidden);
    button.setAttribute("aria-expanded", String(!panel.hidden));
  }
  else if (action === "reset-eq") {
    document.querySelectorAll("[data-band]").forEach(slider => { slider.value = "0"; });
    filters.forEach(filter => { filter.gain.value = 0; });
    EQ_FREQUENCIES.forEach((_, index) => updateEqualizerValue(index, 0));
    saveEqualizer();
    document.querySelector("#eq-preset").value = "flat";
  }
  else if (action === "show-queue") changeView("library");
  else if (action === "toggle-mute") {
    audio.muted = !audio.muted;
    button.classList.toggle("is-muted", audio.muted);
    button.textContent = audio.muted ? "◖̸" : "◖";
    button.setAttribute("aria-label", audio.muted ? "Unmute" : "Mute");
    button.title = audio.muted ? "Unmute" : "Mute";
  }
  else if (action === "open-fullscreen-lyrics") {
    openLyrics();
    toggleFullscreen();
  }
  else if (action === "choose-output-device") {
    const devices = navigator.mediaDevices;
    if (typeof devices?.selectAudioOutput !== "function") {
      showToast("Audio output selection is not supported in this browser.");
      return;
    }
    try {
      const device = await devices.selectAudioOutput();
      await ensureAudioGraph();
      if (typeof audioContext?.setSinkId !== "function") {
        showToast("This browser cannot route equalized audio to a selected output device.");
        return;
      }
      await audioContext.setSinkId(device.deviceId);
      button.title = `Audio output: ${device.label || "selected device"}`;
      showToast(`Audio output changed to ${device.label || "selected device"}.`);
    } catch (error) {
      showToast(`Could not change audio output: ${error.message}`);
    }
  }
  else if (action === "back" && historyIndex > 0) {
    historyIndex--;
    const state = historyStack[historyIndex];
    changeView(state.view, state.playlistId, false);
  }
  else if (action === "forward" && historyIndex < historyStack.length - 1) {
    historyIndex++;
    const state = historyStack[historyIndex];
    changeView(state.view, state.playlistId, false);
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) {
    changeView(button.dataset.view);
    return;
  }
  handleAction(button);
});

content.addEventListener("submit", async event => {
  if (event.target.id === "online-search-form") {
    event.preventDefault();
    if (searchSource === "youtube") searchYouTubeVideos();
    else if (searchSource === "archive") searchArchiveAudio();
    return;
  }
  if (event.target.id === "youtube-link-form") {
    event.preventDefault();
    playYouTubeLink(new FormData(event.target).get("url"));
    return;
  }
  if (event.target.id !== "auth-form") return;
  event.preventDefault();
  const form = event.target;
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const feedback = form.querySelector("#auth-feedback");
  feedback.textContent = "";
  try {
    const email = new FormData(form).get("email");
    const password = new FormData(form).get("password");
    await authenticate(pendingAuthMode, String(email || "").trim(), String(password || ""));
  } catch (error) {
    feedback.textContent = error.message;
    console.error("Supabase authentication failed.", error);
  } finally {
    const newSubmitButton = content.querySelector('#auth-form [type="submit"]');
    if (newSubmitButton) newSubmitButton.disabled = false;
  }
});

document.querySelector("#audio-files").addEventListener("change", async event => {
  await importAudioFiles(event.target.files);
  event.target.value = "";
});

document.querySelector("#playlist-file").addEventListener("change", async event => {
  const [file] = event.target.files;
  if (file) {
    try { await importM3u(file); }
    catch (error) { showToast(`Playlist import failed: ${error.message}`); }
  }
  event.target.value = "";
});

document.querySelector("#lyrics-file").addEventListener("change", async event => {
  const [file] = event.target.files;
  const track = tracks.find(item => item.id === currentTrackId);
  if (file && track) {
    try {
      track.lyrics = await file.text();
      await persistTrack(track);
      lyricsEntries = [];
      updateLyricsDisplay();
      showToast("Local lyrics added for this track.");
    } catch (error) { showToast(`Could not save lyrics: ${error.message}`); }
  }
  event.target.value = "";
});

document.querySelector("#search-input").addEventListener("input", event => {
  searchQuery = event.target.value;
  if (currentView !== "search") changeView("search");
  else {
    if (searchSource === "youtube") {
      onlineSearchController?.abort();
      onlineSearchRequest++;
      onlineSearch = { status: "idle", results: [], error: "", query: "", selectedVideoId: "", playerError: "" };
      youtubeLinkTitle = "";
      destroyYouTubePlayer();
    } else if (searchSource === "archive") {
      archiveSearchController?.abort();
      archiveSearchRequest++;
      archiveSearch = { status: "idle", results: [], error: "", query: "", selectedId: "" };
    }
    renderContent();
  }
});

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#search-input").focus();
  } else if (event.key === "Enter" && event.target.id === "search-input" && currentView === "search" && searchSource === "youtube") {
    event.preventDefault();
    searchYouTubeVideos();
  } else if (event.key === "Enter" && event.target.id === "search-input" && currentView === "search" && searchSource === "archive") {
    event.preventDefault();
    searchArchiveAudio();
  } else if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.querySelector("#search-input").focus();
  } else if (event.key === "Escape" && lyricsView.classList.contains("open") && !document.fullscreenElement) {
    lyricsView.classList.remove("open");
    lyricsView.setAttribute("aria-hidden", "true");
  }
});

document.querySelector("#volume-control").addEventListener("input", event => {
  audio.volume = Number(event.target.value);
  audio.muted = false;
  const muteButton = document.querySelector(".volume-icon");
  muteButton.classList.remove("is-muted");
  muteButton.textContent = "◖";
  muteButton.setAttribute("aria-label", "Mute");
  muteButton.title = "Mute";
  if (gainNode) gainNode.gain.value = 1;
});

document.querySelector("#lyrics-seek-bar").addEventListener("input", event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
});

document.querySelectorAll("[data-band]").forEach(slider => slider.addEventListener("input", event => {
  ensureAudioGraph().catch(error => showToast(`Equalizer unavailable: ${error.message}`));
  const index = Number(event.target.dataset.band);
  const value = Number(event.target.value);
  if (filters[index]) filters[index].gain.value = value;
  updateEqualizerValue(index, value);
  document.querySelector("#eq-preset").value = "custom";
  saveEqualizer();
}));

document.querySelector("#eq-preset").addEventListener("change", event => {
  const values = EQ_PRESETS[event.target.value];
  if (!values) return;
  values.forEach((value, index) => {
    document.querySelector(`[data-band="${index}"]`).value = String(value);
    if (filters[index]) filters[index].gain.value = value;
    updateEqualizerValue(index, value);
  });
  ensureAudioGraph().catch(error => showToast(`Equalizer unavailable: ${error.message}`));
  saveEqualizer();
});

content.addEventListener("input", event => {
  if (event.target.id !== "playlist-color") return;
  const playlist = playlists.find(item => item.id === event.target.dataset.id);
  if (playlist) {
    playlist.color = event.target.value;
    savePlaylists();
    queueCloudSync();
    renderSidebar();
  }
});

document.querySelector("#seek-bar").addEventListener("input", event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
});

audio.addEventListener("timeupdate", () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const progress = String(Math.round(audio.currentTime / audio.duration * 1000));
    seekBar.value = progress;
    document.querySelector("#lyrics-seek-bar").value = progress;
    document.querySelector("#current-time").textContent = formatTime(audio.currentTime);
    document.querySelector("#lyrics-current-time").textContent = formatTime(audio.currentTime);
  }
  if (lyricsView.classList.contains("open")) updateLyricsDisplay();
});
audio.addEventListener("loadedmetadata", () => {
  document.querySelector("#duration-time").textContent = formatTime(audio.duration);
  document.querySelector("#lyrics-duration-time").textContent = formatTime(audio.duration);
  const track = tracks.find(item => item.id === currentTrackId);
  if (track && Number.isFinite(audio.duration) && audio.duration > 0 && track.duration !== audio.duration) {
    track.duration = audio.duration;
    persistTrack(track).catch(error => console.error("Could not save track duration.", error));
  }
});
audio.addEventListener("play", syncNowPlaying);
audio.addEventListener("pause", syncNowPlaying);
audio.addEventListener("ended", () => {
  if (repeatEnabled) {
    audio.currentTime = 0;
    audio.play().catch(error => showToast(`Could not repeat this track: ${error.message}`));
  } else playNext(1);
});

document.querySelector("#lyrics-lines").addEventListener("click", event => {
  const line = event.target.closest("[data-lyric-time]");
  if (line) {
    audio.currentTime = Number(line.dataset.lyricTime);
    audio.play().catch(error => showToast(`Could not play this lyric position: ${error.message}`));
  }
});

let draggedTrackId = null;
content.addEventListener("dragstart", event => {
  const row = event.target.closest("[data-track-row]");
  if (!row || row.dataset.playlistId !== activePlaylistId) return;
  draggedTrackId = row.dataset.trackRow;
  event.dataTransfer.effectAllowed = "move";
});
content.addEventListener("dragover", event => {
  if (draggedTrackId && event.target.closest("[data-track-row]")) event.preventDefault();
});
content.addEventListener("drop", event => {
  const row = event.target.closest("[data-track-row]");
  if (!draggedTrackId || !row || row.dataset.playlistId !== activePlaylistId) return;
  event.preventDefault();
  const playlist = playlists.find(item => item.id === activePlaylistId);
  if (!playlist) return;
  const from = playlist.trackIds.indexOf(draggedTrackId);
  const to = playlist.trackIds.indexOf(row.dataset.trackRow);
  if (from !== -1 && to !== -1) {
    playlist.trackIds.splice(from, 1);
    playlist.trackIds.splice(to, 0, draggedTrackId);
    savePlaylists();
    queueCloudSync();
    renderContent();
  }
  draggedTrackId = null;
});

content.addEventListener("dblclick", event => {
  const row = event.target.closest("[data-track-row]");
  if (row) playTrack(row.dataset.trackRow);
});

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) document.body.classList.remove("fullscreen-lyrics");
});

async function initialize() {
  audio.volume = 0.8;
  loadYouTubeConfig();
  applySavedEqualizer();
  renderProfile();
  renderSidebar();
  syncNowPlaying();
  try {
    if (!("indexedDB" in window)) throw new Error("This browser does not support local music storage.");
    database = await openDatabase();
    tracks = await readTracks();
    savePlaylists();
    renderSidebar();
    renderContent();
    if (authSession) {
      try {
        if (await ensureAuthSession()) await synchronizeCloudPlaylists();
      } catch (error) {
        showToast(`Could not sync playlists: ${error.message}`);
        console.error("Initial Supabase playlist sync failed.", error);
      }
    }
    renderSidebar();
    renderContent();
  } catch (error) {
    showToast(`Could not open your local library: ${error.message}`);
    console.error("Musick library initialization failed.", error);
    renderContent();
  }
}

initialize();
