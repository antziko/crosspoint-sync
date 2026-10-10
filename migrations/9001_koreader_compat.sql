-- Fork-only: verbatim /syncs/bookmarks and /syncs/stats blobs from the
-- self-hosted koreader-sync-server extension. Numbered far past upstream so new
-- upstream migrations never collide with it.
CREATE TABLE compat_bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  document   TEXT NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document)
);

CREATE TABLE compat_stats (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  document   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, device_id)
);

-- One row per quote highlight projected into clippings: when it was first seen
-- (the clipping's created_at) and the full text a device sent for it, since the
-- bookmark blob only carries a short snippet.
CREATE TABLE compat_quotes (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  document   TEXT NOT NULL,
  clip_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  full_text  TEXT,
  PRIMARY KEY (user_id, document, clip_id)
);
