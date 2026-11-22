-- Smart chat skills (wp/smart-rail): a skill result shown as an interactive card in the study chat thread.
-- message.attachment_json  the card payload of an assistant message — it only REFERENCES objects of other modules by
--                          id ({type:'mcq', run_id, question_ids}, {type:'case', case_id}, {type:'cards', card_ids},
--                          {type:'compare'|'figure'} with the checked artifact in artifact_id, {type:'questions', ids},
--                          {type:'sources'}); the card loads them from their own module, nothing is copied.
-- message.skill            which skill produced the turn (owner + assistant rows), e.g. 'mcq', 'case', 'sources'.
-- Card turns are never sent to the model as conversation history (they are not answers).
ALTER TABLE message ADD COLUMN attachment_json TEXT;
ALTER TABLE message ADD COLUMN skill TEXT;
