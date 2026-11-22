// Web reference images («صور من الويب») — what other screens may embed: `searchWebImages(query)` and
// `<WebImageStrip query=… />` (results always shown with their attribution and «صورة من الويب — ليست من محاضرتك»).
export { searchWebImages, webImagesApi, queryFromFigure } from './api';
export { WebImageStrip, WebImageGrid, WebImageLightbox, WebImageAttribution, type WebPicture } from './WebImages';
export { WebImagesPanel, type WebImagesPanelProps } from './WebImagesPanel';
