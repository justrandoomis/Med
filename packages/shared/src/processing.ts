// Document-processing environment contract (§13, §61): which converters/OCR engines the server really has.
// GET /api/processing/status. The UI uses it to explain disabled processing features honestly.
import type { FeatureStatus } from './features';

export interface ProcessingToolStatus {
  available: boolean;
  /** what it is used for, Arabic */
  purpose_ar: string;
  /** why it is unavailable / what is affected, Arabic */
  reason_ar?: string;
  /** engine/model description when known (e.g. 'tesseract.js 7 (eng+ara, 4.0.0_best_int)') */
  engine?: string;
}

export interface ProcessingToolsStatusResponse {
  tools: {
    pdftoppm: ProcessingToolStatus;
    soffice: ProcessingToolStatus;
    tesseract: ProcessingToolStatus;
  };
  /** live capability states for processing.* features */
  features: FeatureStatus[];
  /** handler version of the process_source_version job */
  pipeline_version: string;
  /** chunking/index scheme version written to document_chunk.index_version */
  index_version: string;
}
