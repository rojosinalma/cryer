-- v0.5.0 user-installable app: notification targets may be a DM (`dm:<user_id>`).
-- Cache of the DM channel Discord opened for a user (POST /users/@me/channels), shared by both replicas.
CREATE TABLE IF NOT EXISTS dm_channels (
  user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
