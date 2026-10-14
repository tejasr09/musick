create table public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  color text not null default '#a980ff' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 300),
  artist text not null default '' check (char_length(artist) <= 300),
  album text not null default '' check (char_length(album) <= 300),
  source text not null default 'local'
    check (source in ('local', 'spotify', 'apple_music')),
  source_track_id text,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.playlist_tracks (
  user_id uuid not null references auth.users (id) on delete cascade,
  playlist_id uuid not null,
  track_id uuid not null,
  position integer not null default 0 check (position >= 0),
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id),
  foreign key (playlist_id, user_id)
    references public.playlists (id, user_id) on delete cascade,
  foreign key (track_id, user_id)
    references public.tracks (id, user_id) on delete cascade
);

create index playlist_tracks_order_idx
  on public.playlist_tracks (playlist_id, position);

create or replace function public.set_playlist_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger playlists_updated_at
before update on public.playlists
for each row execute function public.set_playlist_updated_at();

alter table public.playlists enable row level security;
alter table public.tracks enable row level security;
alter table public.playlist_tracks enable row level security;

create policy "Users manage their own playlists"
  on public.playlists for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users manage their own tracks"
  on public.tracks for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users manage their own playlist tracks"
  on public.playlist_tracks for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete
  on public.playlists, public.tracks, public.playlist_tracks
  to authenticated;
