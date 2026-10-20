-- Document processing (H2): the orientation a page was READ in (§07, §13, §14).
--
-- source_page.content_rotation        : the clockwise quarter turn applied to the page AS DISPLAYED (a PDF page after its
--                                       /Rotate, a picture after its EXIF orientation) so that its text reads upright for
--                                       OCR and layout. 0 = checked, already upright; NULL = not determined (no text, or
--                                       the picture could not be decoded). Region boxes always stay in the page's own space.
-- source_page.content_rotation_origin : 'text_direction' (from the PDF text matrices: a page whose /Rotate turns
--                                       upright text sideways) or 'ocr_trials' (a scan / photo read in rotated trials and
--                                       the orientation with the best reading kept).
-- source_page.image_orientation       : the EXIF orientation (1–8) of a JPEG page applied before OCR (NULL when none).
-- For picture pages, source_page.rotation (the display rotation) is set to content_rotation so the reader shows the
-- picture upright; the stored file is never modified. For PDF pages rotation stays the intrinsic /Rotate.
ALTER TABLE source_page ADD COLUMN content_rotation INTEGER CHECK (content_rotation IS NULL OR content_rotation IN (0, 90, 180, 270));
ALTER TABLE source_page ADD COLUMN content_rotation_origin TEXT CHECK (content_rotation_origin IS NULL OR content_rotation_origin IN ('text_direction', 'ocr_trials'));
ALTER TABLE source_page ADD COLUMN image_orientation INTEGER CHECK (image_orientation IS NULL OR image_orientation BETWEEN 1 AND 8);
