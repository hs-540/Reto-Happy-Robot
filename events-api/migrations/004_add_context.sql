-- Add `context` to events: the hook's input prompt. It is optional, existing
-- rows keep NULL. Nothing is lost.
--
-- Deliberately unindexed: it is long free text and is never filtered on.

ALTER TABLE events ADD COLUMN context TEXT;
