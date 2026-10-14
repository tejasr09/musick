# Musick

Musick is a lightweight, open-source music-library web app with a black-and-purple interface. It is built with plain HTML, CSS, and JavaScript: no framework, build step, or analytics. Small bundled ALAC and AAC-LC decoders are loaded only when browser-native `.m4a` playback fails.

## Run it

Serve this directory with any static HTTP server and open its URL in a modern browser. For example, with Node.js installed:

```sh
npx serve .
```

Opening `index.html` directly may also work, but a local web server is recommended for browser storage and audio compatibility.

## Run with Docker

Docker support is optional; the existing Node/static-server workflow above is unchanged. From the project folder, build and start the Nginx container:

```powershell
docker build -t musick:local .
docker run --detach --name musick-local --publish 127.0.0.1:8080:80 musick:local
```

Open <http://localhost:8080> in your browser. Stop and remove the container when finished:

```powershell
docker stop musick-local
docker rm musick-local
```

To enable optional YouTube keyword search, create the ignored `youtube-config.local.json` as described below, then run the container with this read-only bind mount:

```powershell
docker run --detach --name musick-local --publish 127.0.0.1:8080:80 `
  --mount "type=bind,source=$((Resolve-Path .\youtube-config.local.json).Path),target=/usr/share/nginx/html/youtube-config.local.json,readonly" `
  musick:local
```

The image contains an empty YouTube config by default, so it builds and runs without the local file or an API key. A read-only bind mount overrides that empty default when configured. Do not add your local config to the image or commit it. The existing Supabase browser configuration and public publishable key are unchanged; Supabase remains hosted by Supabase, and no server-side Supabase key is included. For Google Cloud's website-referrer restriction, allow `http://localhost:8080/*` when using YouTube search in this container; the browser-visible API key still needs the existing API restriction to YouTube Data API v3.

This container is only available while Docker is running on your computer; it does not publish Musick to the internet or keep it online when your computer or container is stopped. A public HTTPS deployment needs a separate hosting provider and domain, and its HTTPS site URL and callback/redirect URL must be configured in Supabase Auth's URL configuration and redirect allow list.

## What works

- Import and play audio files from your device. Audio blobs and track details stay in the browser's IndexedDB; no audio is uploaded.
- Remove a song from the local library and its playlists, or delete a playlist without deleting the original audio file. The player starts at zero volume on each launch; adjust it manually when ready to listen.
- Edit a local track's title and artist. When a track is played, Musick can search Apple Music's public Search API for a matching cover; only the title and artist are sent for that lookup, and audio remains local. Matching artwork and its sampled colors are cached with the local track, and the lyrics view links to the Apple Music result.
- Create, rename, recolor, reorder, export, and delete playlists. Import `.m3u`/`.m3u8` playlists that match files already in your local library.
- Search your local tracks and get on-device recommendations based on your own favorites and listening history.
- Search YouTube videos through the official API when configured, paste a YouTube video link without an API key, or search Internet Archive audio without an API key. YouTube and Archive playback stay in their respective official embedded players.
- Adjust volume, shuffle and repeat, seek through tracks, favorite songs, and use the five-band Web Audio equalizer with genre and listening presets.
- Display line-synchronized lyrics from a user-supplied `.lrc` file, or paste/edit permitted lyrics and import `.txt` files. Optional word-timing drafts can be adjusted before saving and exported in Musick's JSON companion format; audio and lyrics remain on-device. The lyrics view also works as a full-screen player with a moving background colored from the matching cover art (or local generated cover).
- Optionally find a matching song on Genius and open its song page. Musick uses the official Genius API for song metadata and links only; it never scrapes, retrieves, stores, or displays Genius lyrics.
- Use keyboard `/` to focus search.

Local audio files stay on the device and are never uploaded. Musick tries native browser playback first. A local WebAssembly fallback handles ALAC-in-M4A in 16-bit or 24-bit mono/stereo and retains its PCM bit depth, and AAC-LC-in-M4A in mono/stereo, decoded to 32-bit float WAV at the source sample rate. Float PCM avoids an additional 16-bit conversion; it does not restore information lost in lossy AAC. AAC fallback is limited to Symphonia's AAC-LC profile; other AAC profiles and M4A codecs are not supported by the fallback. Decoder input is capped at 512 MB and decoded WAV output at 256 MB. Unsupported files are reported rather than silently treated as playable. If Web Audio/equalizer setup is unavailable, local playback falls back to the browser's direct audio path. Browser audio processing and the equalizer do not promise bit-perfect output.

The equalizer adds genre and listening presets inspired by the style of FxSound's community preset collection; Musick's curves are its own five-band settings.

The optional ALAC decoder in [`vendor/`](./vendor/) is `@mgz-dev/alac` 0.1.1 (MIT), pinned to upstream commit [`7ad4e9b`](https://github.com/marcogomez/alac/tree/7ad4e9b107a2175ffaaef1a4827988c1a9da906a); its license and third-party notices are included. It is loaded locally only when native playback fails.

The optional AAC-LC fallback is built from the pure-Rust Symphonia 0.6.1 decoder, which is MPL-2.0-licensed and remains separate from Musick's MIT-licensed wrapper and application. Its notice, license, and transitive dependency license texts are in [`vendor/`](./vendor/). The prebuilt decoder is included; rebuilding it requires Rust and the `wasm32-unknown-unknown` target:

```powershell
rustup target add wasm32-unknown-unknown
cargo build --manifest-path .\codec\Cargo.toml --release --target wasm32-unknown-unknown
Copy-Item .\codec\target\wasm32-unknown-unknown\release\musick_aac_decoder.wasm .\vendor\m4a-aac.wasm
```

## Third-party music services

Musick currently plays local files; it does **not** log in to or stream from Spotify, Apple Music, or YouTube Music. Those capabilities cannot be provided by scraping or bypassing platform protections. Each integration needs an official API/SDK, developer registration and credentials, user authorization, and any required service approval or license.

- **Spotify:** Its Web API can provide some account and playlist metadata to an authorized app. It does not grant an independent app unrestricted, lossless playback of subscription tracks or a general-purpose subscription verification endpoint.
- **Apple Music:** MusicKit offers an official integration path, subject to Apple developer-token setup, user permission, regional availability, and MusicKit's playback and subscription rules.
- **YouTube Music:** Google does not offer a general public YouTube Music API for third-party account access and subscription playback. Optional online video search uses the separate YouTube Data API and YouTube's official embedded player. It does not access YouTube Music accounts or subscriptions, pass YouTube audio through Musick's audio player, or guarantee any particular audio quality.
- **Musixmatch:** Lyrics lookup or verification must be implemented through an approved Musixmatch API agreement and credentials. Musick does not claim lyrics are verified; its lyrics feature displays user-provided text, `.lrc`, or locally timed lyrics.

The connection screen describes these dependencies. Do not ask users to enter their third-party passwords into Musick.

## Free online search and playback

Musick provides two options that do not require Google Cloud billing:

- **Paste a YouTube video URL:** In **Search → YouTube**, paste a `youtube.com` or `youtu.be` video link and choose **Play link**. This does not need an API key, but you must find the video on YouTube yourself. Playback uses YouTube's official [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference); it does not extract, proxy, or download audio. It is not YouTube Music search, does not access subscriptions, and cannot play videos whose owners or YouTube disallow embedding.
- **Internet Archive audio search:** In **Search → Internet Archive**, search public Archive.org audio records. Search uses the public [Internet Archive Advanced Search API](https://archive.org/developers/search.html) without an API key. Musick only offers embedded playback when the item metadata declares Public Domain, CC0, CC BY, or CC BY-SA. Other results link to their Archive.org item page instead. Metadata and license declarations can be incomplete or inaccurate; check the source item and license before using or sharing content. Playback stays in Internet Archive's official embedded player.

To enable optional YouTube search by keywords using Google's official **YouTube Data API v3** (not required for pasted video links):

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable **YouTube Data API v3**.
2. Under **APIs & Services → Credentials**, create an API key. Under **API restrictions**, restrict it to **YouTube Data API v3**. Under **Application restrictions**, choose **Websites** and allow only the exact referrers you use, such as `http://localhost:3000/*` and `http://127.0.0.1:3000/*`.
3. From the project folder in PowerShell, copy the empty example to an ignored, local-only configuration file:

   ```powershell
   Copy-Item .\youtube-config.example.json .\youtube-config.local.json
   ```

   Edit `youtube-config.local.json` and set its `apiKey` value to your restricted key. This file is in `.gitignore`; do not force-add or commit it. The checked-in example remains empty. A website-restricted YouTube API key is visible to users of a browser app, so it is **not a secret**: the referrer and API restrictions are essential.

4. Serve Musick over HTTP rather than opening `index.html` as a `file://` URL:

   ```powershell
   npx serve . -l 3000
   ```

   Open `http://localhost:3000`, go to **Search → YouTube**, enter a query in the top search box, and choose **Search YouTube**. Keyword search is only sent when requested, not on every keystroke. Each search consumes YouTube Data API quota. If Google Cloud asks you to attach a paid billing account, do not proceed; use pasted links or Internet Archive search instead.

For deployment, add only your intended production HTTPS referrer to the API key's website restrictions, such as `https://your-domain.example/*`. GitHub Pages also needs its actual hostname and project path allowed. Keep localhost entries only for development.

This public-video search does **not** need OAuth or a redirect URI. If a future feature requires private, account-authorized YouTube data, configure OAuth consent and a separate **Web application OAuth client** in Google Cloud: add the deployed site origin (scheme and host) to **Authorized JavaScript origins**, and the exact callback URL to **Authorized redirect URIs**. A browser OAuth client ID is public; any OAuth client secret belongs only on a trusted server/Edge Function. Never put an OAuth client secret, Google service-account private key, Supabase service-role key, or other server credential in the browser or in GitHub.

## Supabase setup

This project is configured for Supabase project `bqkneymsteutfvcevwfu` at <https://supabase.com/dashboard/project/bqkneymsteutfvcevwfu>. The database migration at [`supabase/migrations/20261014000000_initial_schema.sql`](./supabase/migrations/20261014000000_initial_schema.sql) creates user-owned playlists, track metadata, ordered playlist entries, and Row Level Security policies. It intentionally does not store audio files or lyrics.

To apply the migration, install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from this folder run:

```sh
supabase login
supabase link --project-ref bqkneymsteutfvcevwfu
supabase db push
```

The CLI will ask for your Supabase database password when needed. You can instead paste [`supabase/schema.sql`](./supabase/schema.sql) into the project's SQL Editor in the Supabase Dashboard.

Musick is configured to use this Supabase project with its public publishable key in [`supabase-config.js`](./supabase-config.js). The app supports email/password sign-up and sign-in; Supabase Auth sessions are kept in browser local storage and refreshed as needed. After signing in, playlist metadata (name, color, track metadata, and ordered track IDs) is synchronized. Audio blobs, local lyrics, and listening history remain on the device. Tracks present in a synced playlist but not on this device appear as cloud-only playlist entries and cannot be played until their audio is added locally.

The publishable key is intended for use in client apps. Never put a `service_role` or secret key in browser code or GitHub. User-owned data is protected by the included row-level security policies.

Playlist exports and imports operate on track filenames already present in the local library; they do not transfer audio between services. Local audio and listening history are not synced or uploaded.

### Optional Genius song links

The Genius feature is an authenticated, metadata-only song match. It sends the selected track's title and artist to a Supabase Edge Function, which calls the official Genius API and returns only the matched song title, artist, and Genius page URL. Lyrics are never requested or imported. Users must be signed in to Musick to invoke the function.

To enable it, create a Genius API client and obtain its API access token in Genius developer settings. Never put this token in `app.js`, `supabase-config.js`, a checked-in config file, or the Docker image. Store it as a Supabase Edge Function secret and deploy the function:

```powershell
supabase login
supabase secrets set GENIUS_ACCESS_TOKEN=YOUR_GENIUS_ACCESS_TOKEN --project-ref bqkneymsteutfvcevwfu
supabase functions deploy genius-song-lookup --project-ref bqkneymsteutfvcevwfu
```

Alternatively, set `GENIUS_ACCESS_TOKEN` under **Supabase Dashboard → Edge Functions → Secrets**, then deploy `supabase/functions/genius-song-lookup`. The function requires a valid Supabase user session (`verify_jwt = true`). Without the secret or a deployed function, the UI reports that Genius lookup is unavailable; local playback and lyrics continue to work. Do not assume a Genius match or page grants permission to reuse lyrics.

### Editing and word-synchronized lyrics

In the lyrics view, choose **Edit / add lyrics** to paste or edit text, or load a local `.txt`/`.lrc` file. Existing `.lrc` line timestamps continue to import and export as ordinary LRC. **Estimate word timings** creates an on-device editable draft spread across the selected track's duration, with longer words allocated slightly more time. It is a rough duration-based estimate, not speech recognition or audio analysis; review and adjust each timestamp before saving. If the browser cannot read the selected track's duration (for example, for an unsupported format), word timing is unavailable but ordinary lyrics and `.lrc` remain usable. No audio or lyrics are uploaded for alignment.

Saved word timing is stored with that local track in IndexedDB. **Export word timings** creates a `.musick-lyrics.json` companion file with `format: "musick-word-lyrics"` and `version: 1`; it can be re-imported using **Import word timings**. It contains the lyric text and timestamps, so share it only if you have permission. Exporting `.lrc` from word-timed lyrics keeps line-level timing using each line's first word timestamp; word-level timing is available only in the companion JSON. Plain text lyrics have no synchronization until timing is added.

## GitHub

The remote for <https://github.com/tejasr09/musick> is configured. The repository includes an MIT license and ignores common local secrets and generated files.
