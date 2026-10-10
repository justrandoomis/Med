// Public surface of the E2E harness — specs import from here.
export { test, expect, type ConsoleGuard } from './fixtures';
export { apiAs, ApiCallError, CSRF_HEADERS, TERMINAL_JOB_STATES } from './api';
export type { E2eApi, NotebookAndCourse, ProcessingResult, UploadedFixture, UploadOptions, WaitForProcessingOptions } from './api';
export { setupOwner, openWorkspace, waitForWorkspace, screenshot, expectHealthyScreen, OWNER, type OwnerCredentials } from './ui';
export { GOLDEN_DIR, E2E_ARTIFACTS_DIR, serverFor } from './paths';
