-- v0.3.0 gateway listener: reaction / reply answers.
-- Lookup of the prompt a Discord message belongs to (messageReactionAdd, messageCreate reply).
CREATE INDEX IF NOT EXISTS prompts_discord_message_id ON prompts (discord_message_id);

-- How the answer arrived: button | modal | reaction | reply. Rows written before v0.3.0 were buttons/modals.
ALTER TABLE answers ADD COLUMN via TEXT NOT NULL DEFAULT 'button';
