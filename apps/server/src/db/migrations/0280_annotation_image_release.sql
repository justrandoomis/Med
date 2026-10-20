-- Round 7 — H3 item 10 (§26 pictures on pages, §47 never lose the owner's data).
-- A purge's prune removed a picture as soon as the last annotation the SERVER knew about was purged — although a copy
-- with the same image_key (copy / paste keeps the key) could still be queued in an offline device's outbox; when that
-- copy synced, every device showed «لم تصل هذه الصورة إلى الخادم بعد». `released_at` records when the last annotation
-- referring to a once-referenced picture disappeared; prune keeps the picture for a grace period counted from that
-- moment, and a referring annotation arriving meanwhile clears it again.
ALTER TABLE annotation_image ADD COLUMN released_at INTEGER;
