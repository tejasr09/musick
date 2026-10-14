# Musick

Musick is a lightweight, open-source music-library web app with a black-and-purple interface. It is built with plain HTML, CSS, and JavaScript: no framework, build step, analytics, or third-party runtime dependencies.

## Run it

Serve this directory with any static HTTP server and open its URL in a modern browser. For example, with Node.js installed:

```sh
npx serve .
```

Opening `index.html` directly may also work, but a local web server is recommended for browser storage and audio compatibility.

## What works

- Import and play audio files from your device. Audio blobs and track details stay in the browser's IndexedDB; no audio is uploaded.
- Create, rename, recolor, reorder, export, and delete playlists. Import `.m3u`/`.m3u8` playlists that match files already in your local library.
- Search your local tracks and get on-device recommendations based on your own favorites and listening history.
- Optionally search public YouTube videos through the official YouTube Data API and play them only in YouTube's official embedded player. Online search is disabled by default until you provide a local API-key configuration.
- Adjust volume, shuffle and repeat, seek through tracks, favorite songs, and use the five-band Web Audio equalizer, with presets.
- Display synchronized lyrics from a user-supplied `.lrc` file and use the lyrics view as a full-screen player.
- Use keyboard `/` to focus search.

Playback uses the original local audio file without uploading or transcoding it; available formats and quality depend on browser codec and device support. Browser audio processing and the equalizer do not promise bit-perfect output.

## Third-party music services

Musick currently plays local files; it does **not** log in to or stream from Spotify, Apple Music, or YouTube Music. Those capabilities cannot be provided by scraping or bypassing platform protections. Each integration needs an official API/SDK, developer registration and credentials, user authorization, and any required service approval or license.

- **Spotify:** Its Web API can provide some account and playlist metadata to an authorized app. It does not grant an independent app unrestricted, lossless playback of subscription tracks or a general-purpose subscription verification endpoint.
- **Apple Music:** MusicKit offers an official integration path, subject to Apple developer-token setup, user permission, regional availability, and MusicKit's playback and subscription rules.
- **YouTube Music:** Google does not offer a general public YouTube Music API for third-party account access and subscription playback. Optional online video search uses the separate YouTube Data API and YouTube's official embedded player. It does not access YouTube Music accounts or subscriptions, pass YouTube audio through Musick's audio player, or guarantee any particular audio quality.
- **Musixmatch:** Lyrics lookup or verification must be implemented through an approved Musixmatch API agreement and credentials. Musick does not claim lyrics are verified; its lyrics feature plays user-provided `.lrc` files.

The connection screen describes these dependencies. Do not ask users to enter their third-party passwords into Musick.

## Optional online YouTube video search

This optional search uses Google's official **YouTube Data API v3** to search public videos and YouTube's official [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) for playback. It is not YouTube Music search. Videos that cannot be embedded may fail to play; the player reports unavailable or embedding-disabled videos. The videos remain in YouTube's player and never enter Musick's audio element, local library, or playlists.

To enable online search during local development:

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

   Open `http://localhost:3000`, go to **Search → YouTube**, enter a query in the top search box, and choose **Search YouTube**. Search is only sent when requested, not on every keystroke. Each search consumes YouTube Data API quota.

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

## GitHub

The remote for <https://github.com/tejasr09/musick> is configured. The repository includes an MIT license and ignores common local secrets and generated files.
