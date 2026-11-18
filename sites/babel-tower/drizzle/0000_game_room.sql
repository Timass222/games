CREATE TABLE game_room (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  codes TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE game_session (
  token_hash TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('host', 'leader', 'envoy')),
  team_id TEXT,
  expires INTEGER NOT NULL
);
