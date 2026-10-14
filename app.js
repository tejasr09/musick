"use strict";

const DB_NAME = "musick-library";
const DB_VERSION = 1;
const TRACK_STORE = "tracks";
const PLAYLISTS_KEY = "musick-playlists-v1";
const EQ_KEY = "musick-equalizer-v1";
const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];
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
let toastTimer;
let currentObjectUrl = null;
let audioContext;
let mediaSource;
let gainNode;
let filters = [];
let lyricsEntries = [];
let historyStack = [{ view: "home", playlistId: null }];
let historyIndex = 0;

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
  currentView = view;
  activePlaylistId = playlistId;
  if (addHistory) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push({ view, playlistId });
    historyIndex = historyStack.length - 1;
  }
  document.querySelectorAll(".nav-link").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view || (view === "playlist" && button.dataset.view === "library"));
  });
  renderContent();
}

function renderContent() {
  if (currentView === "home") renderHome();
  else if (currentView === "library") renderLibrary();
  else if (currentView === "search") renderSearch();
  else if (currentView === "playlist") renderPlaylist();
  else if (currentView === "connections") renderConnections();
}

function trackMatches(track, query) {
  const normalized = query.toLowerCase();
  return [track.title, track.artist, track.album, ...(track.tags || [])].some(value => String(value || "").toLowerCase().includes(normalized));
}

function renderHome() {
  const recent = tracks.filter(track => track.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 6);
  const recommendations = recommendTracks();
  content.innerHTML = `
    <div class="welcome-row">
      <div><span class="eyebrow">YOUR MUSIC, YOUR WAY</span><h1>Good music. No noise.</h1><p>Your collection, playlists, and sound — all in one place.</p></div>
      <div class="button-row"><button class="secondary-button" data-action="connections">Connect a service</button><button class="primary-button" data-action="add-files">＋ Add music</button></div>
    </div>
    <section class="hero-card">
      <div class="hero-copy"><span class="eyebrow">A HOME FOR YOUR MUSIC</span><h2>Press play on your own library.</h2><p>Add audio from your device. Your music stays yours — saved locally, with no upload and no tracking.</p></div>
      <div class="hero-visual" aria-hidden="true">♫</div>
    </section>
    ${recent.length ? `<section><div class="section-heading"><h2>Pick up where you left off</h2><button class="quiet-button" data-view="library">Your library →</button></div><div class="quick-grid">${recent.map(track => quickCard(track, "recent")).join("")}</div></section>` : ""}
    <section><div class="section-heading"><div><h2>Made for your library</h2><p>${tracks.length ? "A little inspiration from your listening." : "Your personal picks get better as you listen."}</p></div></div>
      ${recommendations.length ? `<div class="quick-grid">${recommendations.map(track => quickCard(track, "recommendation")).join("")}</div><p class="recommendation-note">Personalized from your listening history and library. Recommendations run on this device.</p>` : emptyState("Your next favorite is waiting", "Add some music and play a few tracks. Musick will use your own library and listening history to suggest what to hear next.", "Add music", "add-files")}
    </section>`;
}

function quickCard(track, context) {
  return `<button class="quick-card" data-action="play-track" data-id="${escapeHTML(track.id)}" data-context="${context}" aria-label="Play ${escapeHTML(track.title)}">
    ${coverMarkup(track)}<span class="quick-card-copy"><strong>${escapeHTML(track.title)}</strong><span>${escapeHTML(track.artist)}</span></span><span class="quick-play" aria-hidden="true">▶</span>
  </button>`;
}

function emptyState(title, message, buttonLabel = "Add music", action = "add-files") {
  return `<div class="empty-state"><div><div class="empty-icon">♫</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(message)}</p><button class="primary-button" data-action="${action}">${escapeHTML(buttonLabel)}</button></div></div>`;
}

function renderLibrary() {
  const sorted = [...tracks].sort((a, b) => b.addedAt - a.addedAt);
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">ALL YOUR MUSIC</span><h1>Your library</h1></div><div class="button-row"><button class="secondary-button" data-action="import-playlist">Import .m3u</button><button class="primary-button" data-action="add-files">＋ Add music</button></div></div>
    ${tracks.length ? `<div class="section-heading"><h2>Songs <span class="track-count">${tracks.length}</span></h2><button class="quiet-button" data-action="create-playlist">＋ New playlist</button></div>${trackTable(sorted)}` : emptyState("Your library starts here", "Add music files from your device. Audio is stored in this browser and is never uploaded.", "＋ Add music")}
    <section><div class="section-heading"><h2>Your playlists <span class="track-count">${playlists.length}</span></h2><button class="quiet-button" data-action="create-playlist">＋ Create playlist</button></div>
      ${playlists.length ? `<div class="quick-grid">${playlists.map(playlistCard).join("")}</div>` : `<p class="recommendation-note">Make a playlist, add tracks, and give it your own color.</p>`}
    </section>`;
}

function playlistCard(playlist) {
  const [first, second] = playlistPalette(playlist);
  return `<button class="quick-card" data-action="open-playlist" data-id="${escapeHTML(playlist.id)}">
    <div class="cover-art" style="--cover-a:${first};--cover-b:${second}"><span>♫</span></div>
    <span class="quick-card-copy"><strong>${escapeHTML(playlist.name)}</strong><span>${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "song" : "songs"}</span></span>
  </button>`;
}

function renderSearch() {
  const results = searchQuery.trim() ? tracks.filter(track => trackMatches(track, searchQuery.trim())) : [];
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">FIND A FAVORITE</span><h1>Search</h1></div></div>
    ${searchQuery.trim() ? `<div class="section-heading"><h2>Results <span class="track-count">${results.length}</span></h2></div>${results.length ? trackTable(results) : emptyState("No matches yet", "Try another title, artist, album, or tag.")}` : emptyState("Search your collection", "Find a song, artist, album, or tag in the music you have added.")}`;
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
  return `<table class="track-table"><thead><tr><th>#</th><th>Title</th><th>Album</th><th>Plays</th><th></th></tr></thead><tbody>
    ${items.map((track, index) => `<tr class="track-row ${track.id === currentTrackId ? "current" : ""}" draggable="${removable ? "true" : "false"}" data-track-row="${escapeHTML(track.id)}" data-playlist-id="${removable ? escapeHTML(activePlaylistId) : ""}">
      <td>${String(index + 1).padStart(2, "0")}</td>
      <td><div class="track-title">${coverMarkup(track)}<span class="track-title-copy"><strong>${escapeHTML(track.title)}</strong><span>${escapeHTML(track.artist)}</span></span></div></td>
      <td class="track-album">${escapeHTML(track.album || "—")}</td><td>${track.playCount || 0}</td>
      <td><div class="track-actions"><button class="favorite ${track.favorite ? "active" : ""}" data-action="favorite" data-id="${escapeHTML(track.id)}" aria-label="${track.favorite ? "Remove from" : "Add to"} favorites">${track.favorite ? "♥" : "♡"}</button>${removable ? `<button data-action="remove-from-playlist" data-id="${escapeHTML(track.id)}" aria-label="Remove from playlist" title="Remove from playlist">−</button>` : `<button data-action="track-menu" data-id="${escapeHTML(track.id)}" aria-label="Track options" title="Add to playlist">···</button>`}</div></td>
    </tr>`).join("")}
  </tbody></table>`;
}

function renderConnections() {
  content.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">YOUR OTHER MUSIC APPS</span><h1>Connect a service</h1></div></div>
    <p class="recommendation-note">Musick is open source, but connecting, importing, and streaming depend on each service's official APIs, account permissions, and licensing. No account credentials are collected by this app.</p>
    <div class="connections-grid">
      ${connectionCard("S", "Spotify", "Import playlist and library metadata with an approved Spotify developer app. Spotify does not provide unrestricted lossless streaming to independent players.", "Developer app and OAuth setup required")}
      ${connectionCard("A", "Apple Music", "Apple MusicKit can provide catalog access and subscriber playback when configured with an Apple developer token and a user's authorization.", "Apple developer token required")}
      ${connectionCard("▶", "YouTube Music", "YouTube Music does not offer a general public API for third-party account login, playlist import, or music streaming.", "No official public music API")}
    </div>
    <div class="info-callout"><strong>Streaming & subscriptions:</strong> Musick cannot read subscription status or bypass DRM. A service must explicitly support playback and account checks through its official SDK. Your local audio works now; provider connections can be added when you choose a service and supply its developer credentials.</div>
    <section><div class="section-heading"><h2>Backend</h2></div><p class="recommendation-note">Supabase is not connected yet. Add your project URL and anon key when you are ready to configure sync; never put a service-role key in a client app.</p></section>`;
}

function connectionCard(mark, name, description, state) {
  return `<article class="connection-card"><div class="connection-top"><div class="service-logo">${escapeHTML(mark)}</div><h3>${escapeHTML(name)}</h3></div><p>${escapeHTML(description)}</p><span class="connection-state unavailable">${escapeHTML(state)}</span><button class="secondary-button" data-action="connection-info" data-service="${escapeHTML(name)}">Setup details</button></article>`;
}

function recommendTracks() {
  const eligible = tracks.filter(track => track.id !== currentTrackId);
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
  if (audioContext) return audioContext.resume();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    showToast("Your browser does not support audio equalization.");
    return Promise.resolve();
  }
  audioContext = new AudioContextClass();
  mediaSource = audioContext.createMediaElementSource(audio);
  gainNode = audioContext.createGain();
  filters = EQ_FREQUENCIES.map((frequency, index) => {
    const filter = audioContext.createBiquadFilter();
    filter.type = index === 0 ? "lowshelf" : index === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
    filter.frequency.value = frequency;
    filter.Q.value = 1;
    return filter;
  });
  mediaSource.connect(filters[0]);
  for (let index = 0; index < filters.length - 1; index++) filters[index].connect(filters[index + 1]);
  filters[filters.length - 1].connect(gainNode);
  gainNode.connect(audioContext.destination);
  applyEqualizerFromControls();
  return audioContext.resume();
}

function applyEqualizerFromControls() {
  filters.forEach((filter, index) => {
    filter.gain.value = Number(document.querySelector(`[data-band="${index}"]`).value);
  });
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
  const track = tracks.find(item => item.id === id);
  if (!track) return;
  if (currentTrackId === id && audio.src) {
    try { await ensureAudioGraph(); await audio.play(); }
    catch (error) { showToast(`Playback failed: ${error.message}`); }
    syncNowPlaying();
    return;
  }
  try {
    await ensureAudioGraph();
    const oldUrl = currentObjectUrl;
    currentObjectUrl = URL.createObjectURL(track.blob);
    audio.src = currentObjectUrl;
    currentTrackId = id;
    await audio.play();
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    track.playCount = (track.playCount || 0) + 1;
    track.lastPlayed = Date.now();
    await persistTrack(track);
    syncNowPlaying();
    renderContent();
    if (lyricsView.classList.contains("open")) updateLyricsDisplay();
  } catch (error) {
    showToast(`Could not play this track: ${error.message}`);
    console.error("Track playback failed.", error);
  }
}

function getQueue() {
  if (currentView === "playlist") {
    const playlist = playlists.find(item => item.id === activePlaylistId);
    if (playlist) return playlist.trackIds.filter(id => tracks.some(track => track.id === id));
  }
  if (currentView === "search" && searchQuery.trim()) return tracks.filter(track => trackMatches(track, searchQuery.trim())).map(track => track.id);
  return tracks.map(track => track.id);
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
  renderSidebar();
  changeView("playlist", playlist.id);
  if (!matched.length) showToast("Playlist imported, but no entries matched tracks in your local library.");
  else showToast(`Imported ${matched.length} ${matched.length === 1 ? "track" : "tracks"} from the playlist.`);
}

function handleAction(button) {
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
    renderSidebar();
    renderContent();
  }
  else if (action === "play-playlist") {
    const playlist = playlists.find(item => item.id === id);
    const first = playlist && playlist.trackIds.find(trackId => tracks.some(track => track.id === trackId));
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
    savePlaylists(); renderSidebar(); renderContent();
  }
  else if (action === "delete-playlist") {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist || !window.confirm(`Delete "${playlist.name}"? Your music files will not be deleted.`)) return;
    playlists = playlists.filter(item => item.id !== id);
    savePlaylists(); renderSidebar(); changeView("library");
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
    saveEqualizer();
    document.querySelector("#eq-preset").value = "flat";
  }
  else if (action === "show-queue") changeView("library");
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
  else renderContent();
});

document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.querySelector("#search-input").focus();
  } else if (event.key === "Escape" && lyricsView.classList.contains("open") && !document.fullscreenElement) {
    lyricsView.classList.remove("open");
    lyricsView.setAttribute("aria-hidden", "true");
  }
});

document.querySelector("#volume-control").addEventListener("input", event => {
  audio.volume = Number(event.target.value);
  if (gainNode) gainNode.gain.value = 1;
});

document.querySelector("#lyrics-seek-bar").addEventListener("input", event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
});

document.querySelectorAll("[data-band]").forEach(slider => slider.addEventListener("input", event => {
  ensureAudioGraph().catch(error => showToast(`Equalizer unavailable: ${error.message}`));
  const index = Number(event.target.dataset.band);
  if (filters[index]) filters[index].gain.value = Number(event.target.value);
  document.querySelector("#eq-preset").value = "custom";
  saveEqualizer();
}));

document.querySelector("#eq-preset").addEventListener("change", event => {
  const presets = {
    flat: [0, 0, 0, 0, 0], bass: [7, 5, 1, -1, 0],
    vocal: [-2, 1, 4, 3, 1], treble: [-1, 0, 1, 4, 6]
  };
  const values = presets[event.target.value];
  if (!values) return;
  values.forEach((value, index) => {
    document.querySelector(`[data-band="${index}"]`).value = String(value);
    if (filters[index]) filters[index].gain.value = value;
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
  applySavedEqualizer();
  renderSidebar();
  syncNowPlaying();
  try {
    if (!("indexedDB" in window)) throw new Error("This browser does not support local music storage.");
    database = await openDatabase();
    tracks = await readTracks();
    for (const playlist of playlists) {
      playlist.trackIds = playlist.trackIds.filter(id => tracks.some(track => track.id === id));
    }
    savePlaylists();
    renderSidebar();
    renderContent();
  } catch (error) {
    showToast(`Could not open your local library: ${error.message}`);
    console.error("Musick library initialization failed.", error);
    renderContent();
  }
}

initialize();
