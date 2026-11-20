-- Events written by the platform itself (chat notifier failures) have no member, agent or connection.
ALTER TABLE events DROP CONSTRAINT events_actor_kind_check;
ALTER TABLE events ADD CONSTRAINT events_actor_kind_check
  CHECK (actor_kind IN ('member', 'agent', 'connection', 'system'));
