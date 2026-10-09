// Practice & exams server calls (/api/exams). Shapes come from @medlevo/shared (questions.ts, exams-api.ts).
// Answers / timer / pause state travel through the sync outbox (local.ts), never only through these calls.
import type {
  AttemptFeedbackView,
  ExamAttemptListResponse,
  ExamCreateRequest,
  ExamCreateResponse,
  ExamPreviewResponse,
  ExamResultDetail,
  ExamSessionView,
  GenerateQuestionsRequest,
  GenerateQuestionsResponse,
  GenerationRunListResponse,
  HintResponse,
  MistakeType,
  MistakeUpdateResponse,
  PracticeAnswerRequest,
  SourcePagesResponse,
  WrittenAttemptInput,
  WrittenAttemptResponse,
  WrittenGradeRequest,
  WrittenQuestionView,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const enc = encodeURIComponent;
const item = (attemptId: string, index: number) => `/exams/attempts/${enc(attemptId)}/items/${index}`;

export const examsApi = {
  preview: (body: ExamCreateRequest) => api.post<ExamPreviewResponse>('/exams/preview', body, { timeoutMs: 30_000 }),
  create: (body: ExamCreateRequest) => api.post<ExamCreateResponse>('/exams', body, { timeoutMs: 30_000 }),
  session: (attemptId: string) => api.get<ExamSessionView>(`/exams/attempts/${enc(attemptId)}`, { timeoutMs: 30_000 }),
  history: (cursor?: string | null, limit = 30) => api.get<ExamAttemptListResponse>('/exams/attempts', { query: { cursor: cursor ?? undefined, limit } }),
  hint: (attemptId: string, index: number, level: 1 | 2) => api.post<HintResponse>(`${item(attemptId, index)}/hint`, { level }),
  answer: (attemptId: string, index: number, body: PracticeAnswerRequest) => api.post<AttemptFeedbackView>(`${item(attemptId, index)}/answer`, body, { timeoutMs: 30_000 }),
  solution: (attemptId: string, index: number) => api.post<AttemptFeedbackView>(`${item(attemptId, index)}/solution`, {}),
  feedback: (attemptId: string, index: number) => api.get<AttemptFeedbackView>(`${item(attemptId, index)}/feedback`, { timeoutMs: 30_000 }),
  result: (attemptId: string) => api.get<ExamResultDetail>(`/exams/attempts/${enc(attemptId)}/result`, { timeoutMs: 30_000 }),
  setMistake: (questionAttemptId: string, mistake_type: MistakeType | null) =>
    api.patch<MistakeUpdateResponse>(`/exams/question-attempts/${enc(questionAttemptId)}/mistake`, { mistake_type }),
  generate: (body: GenerateQuestionsRequest) => api.post<GenerateQuestionsResponse>('/exams/generate', body, { timeoutMs: 30_000 }),
  run: (runId: string) => api.get<GenerateQuestionsResponse>(`/exams/generate/${enc(runId)}`),
  runs: (lectureSourceId?: string | null) => api.get<GenerationRunListResponse>('/exams/generate', { query: { lecture_source_id: lectureSourceId ?? undefined } }),
  written: (questionId: string) => api.get<WrittenQuestionView>(`/exams/written/${enc(questionId)}`),
  saveWritten: (body: WrittenAttemptInput) => api.post<WrittenAttemptResponse>('/exams/written/attempts', body),
  gradeWritten: (attemptId: string, body: WrittenGradeRequest = {}) =>
    api.post<WrittenAttemptResponse>(`/exams/written/attempts/${enc(attemptId)}/grade`, body, { timeoutMs: 200_000 }),
  pages: (sourceId: string, versionId: string) => api.get<SourcePagesResponse>(`/sources/${enc(sourceId)}/versions/${enc(versionId)}/pages`),
};
