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
- Adjust volume, shuffle and repeat, seek through tracks, favorite songs, and use the five-band Web Audio equalizer, with presets.
- Display synchronized lyrics from a user-supplied `.lrc` file and use the lyrics view as a full-screen player.
- Use keyboard `/` to focus search.

Playback uses the original local audio file without uploading or transcoding it; available formats and quality depend on browser codec and device support. Browser audio processing and the equalizer do not promise bit-perfect output.

## Third-party music services

Musick currently plays local files; it does **not** log in to or stream from Spotify, Apple Music, or YouTube Music. Those capabilities cannot be provided by scraping or bypassing platform protections. Each integration needs an official API/SDK, developer registration and credentials, user authorization, and any required service approval or license.

- **Spotify:** Its Web API can provide some account and playlist metadata to an authorized app. It does not grant an independent app unrestricted, lossless playback of subscription tracks or a general-purpose subscription verification endpoint.
- **Apple Music:** MusicKit offers an official integration path, subject to Apple developer-token setup, user permission, regional availability, and MusicKit's playback and subscription rules.
- **YouTube Music:** Google does not offer a general public YouTube Music API for third-party account access and music playback.
- **Musixmatch:** Lyrics lookup or verification must be implemented through an approved Musixmatch API agreement and credentials. Musick does not claim lyrics are verified; its lyrics feature plays user-provided `.lrc` files.

The connection screen describes these dependencies. Do not ask users to enter their third-party passwords into Musick.

## Supabase setup

This project is configured for Supabase project `bqkneymsteutfvcevwfu` at <https://supabase.com/dashboard/project/bqkneymsteutfvcevwfu>. The database migration at [`supabase/migrations/20261014000000_initial_schema.sql`](./supabase/migrations/20261014000000_initial_schema.sql) creates user-owned playlists, track metadata, ordered playlist entries, and Row Level Security policies. It intentionally does not store audio files or lyrics.

To apply the migration, install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from this folder run:

```sh
supabase login
supabase link --project-ref bqkneymsteutfvcevwfu
supabase db push
```

The CLI will ask for your Supabase database password when needed. You can instead paste [`supabase/schema.sql`](./supabase/schema.sql) into the project's SQL Editor in the Supabase Dashboard.

The static web app does not yet connect to Supabase for sign-in or syncing. The project URL and ID are public project identifiers; the Supabase **publishable key** (formerly called the `anon` key) is still needed to make client API requests. Find it under your project's **Connect** dialog or **Settings → API Keys**. Do not put a `service_role` or secret key in browser code or GitHub. User-owned data must remain protected by the included row-level security policies.

Playlist exports and imports operate on track filenames already present in the local library; they do not transfer audio between services. Local audio and listening history are not synced or uploaded.

## GitHub

The remote for <https://github.com/tejasr09/musick> is configured. The repository includes an MIT license and ignores common local secrets and generated files.
