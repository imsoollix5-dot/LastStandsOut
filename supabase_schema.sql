-- Run in Supabase Dashboard > SQL Editor > New query.
-- Keep the service-role key private; configure it only in Render environment variables.
create table if not exists public.lsa_leaderboard (
  username text not null, map_key text not null, wins integer not null default 0,
  losses integer not null default 0, kills integer not null default 0, deaths integer not null default 0,
  updated_at timestamptz not null default now(), primary key (username, map_key)
);
create index if not exists lsa_leaderboard_rank_idx on public.lsa_leaderboard (map_key, wins desc, kills desc);
alter table public.lsa_leaderboard enable row level security;

-- Cloud career save linked to the authenticated Supabase Auth user.
create table if not exists public.lsa_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  game_state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create unique index if not exists lsa_profiles_username_lower_idx on public.lsa_profiles (lower(username));
alter table public.lsa_profiles enable row level security;
-- Browser clients do not access these tables directly; the Render server uses its service-role key
-- only after validating the user's Supabase access token. Do not add public policies for these tables.


-- Friend links are stored in both directions so each player's list is easy to load.
create table if not exists public.lsa_friends (
  user_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index if not exists lsa_friends_user_idx on public.lsa_friends (user_id, created_at);
alter table public.lsa_friends enable row level security;
-- Render server uses the service-role key; do not add public policies.
