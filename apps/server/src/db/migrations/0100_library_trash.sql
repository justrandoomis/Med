-- Library module (range 0100–0149): trash subtree bookkeeping + indexes.
--
-- Trash semantics (§05, §18): trashing a node marks the node itself (deleted_at, trash_root_id NULL)
-- AND every not-yet-trashed descendant node/source (deleted_at = same time, trash_root_id = the node
-- that was trashed). So every module can keep filtering on `deleted_at IS NULL` and never sees
-- content hidden inside a trashed folder. Restoring the node clears deleted_at on everything whose
-- trash_root_id points at it; items that were trashed on their own before keep their own state.
ALTER TABLE library_node ADD COLUMN trash_root_id TEXT;

CREATE INDEX idx_library_node_deleted ON library_node(deleted_at);
CREATE INDEX idx_library_node_trash_root ON library_node(trash_root_id);
CREATE INDEX idx_topic_link_entity ON topic_link(entity_type, entity_id);
