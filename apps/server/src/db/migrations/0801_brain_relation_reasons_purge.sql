-- Course Brain (track F2, review fix; migration range 0800–0849): a permanently deleted source version must not live on
-- inside concept_relation.reasons_json. A suggestion's reasons quote the lecture text they were built from (source
-- title, page, region, up to 300 characters of the sentence); the sources purge deletes the versions, pages and regions
-- but did not know about these copies, so the purged lecture's sentences stayed readable in GET /api/brain/relations.
--
-- When a source version is deleted (purge), every reason that points into it is dropped:
--  * an undecided suggestion (origin auto, status suggested) left without any reason is deleted (it had no other basis);
--  * a decided row (accepted / rejected / owner) is KEPT — the owner's decision stays — with a neutral reason that
--    says its basis is gone (no text of the deleted lecture).
-- Re-processing pages does not delete versions, so it never fires this (the next extraction refreshes the reasons).
CREATE TRIGGER brain_version_relation_reasons_bd BEFORE DELETE ON source_version BEGIN
  UPDATE concept_relation
     SET reasons_json = COALESCE(
           (SELECT json_group_array(json(j.value)) FROM json_each(concept_relation.reasons_json) AS j WHERE instr(j.value, OLD.id) = 0),
           '[]')
   WHERE reasons_json IS NOT NULL AND json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND instr(reasons_json, OLD.id) > 0;
  DELETE FROM concept_relation WHERE origin = 'auto' AND status = 'suggested' AND reasons_json = '[]';
  UPDATE concept_relation
     SET reasons_json = json_array(json_object('kind', 'basis_removed', 'text_ar', 'حُذف المصدر الذي بُني عليه هذا الاقتراح نهائيًا؛ بقي قرارك فيه وحده، ولا يُعرض شيء من نصه.'))
   WHERE reasons_json = '[]';
END;
