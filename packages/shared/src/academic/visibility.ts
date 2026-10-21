// Academic OS — shared vocabulary of who sees what (ARCHITECTURE_DELTA §5.1, §5.2, §7.1). Types, Arabic labels and zod
// schemas only; nothing here grants access by itself: the server's `authz` decides (§5.5), and «private» is the default
// for everything a user creates.
import { z } from 'zod';

/** Visibility scopes (§5.2). `private` = only the owner: the data stays in their vault. */
export const VISIBILITIES = ['private', 'specific_users', 'followers', 'course', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** A publication is shared by definition: never `private`. `public` = every signed-in user of the deployment. */
export const PUBLICATION_VISIBILITIES = ['specific_users', 'followers', 'course', 'public'] as const satisfies readonly Exclude<Visibility, 'private'>[];
export type PublicationVisibility = Exclude<Visibility, 'private'>;

export const VISIBILITY_LABELS_AR: Record<Visibility, string> = {
  private: 'خاص بي',
  specific_users: 'أشخاص محددون',
  followers: 'متابعيّ',
  course: 'أعضاء المادة',
  public: 'كل المستخدمين المسجلين',
};

/** A person as other people see them: public profile fields only (no e-mail, no account details). */
export interface UserRef {
  id: string;
  display_name: string;
  avatar_url: string | null;
  /** «طالب سابق»: the account was deleted; attribution stays with a neutral name */
  former?: boolean;
}

/** Nodes of the university tree (§4.1 `channel_node.kind`). */
export const CHANNEL_KINDS = ['university', 'college', 'department', 'stage', 'academic_year', 'course', 'subject'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Roles assigned on a node; they inherit down the tree (§5.1). Students are members, not a role. */
export const CHANNEL_ROLES = ['admin', 'assistant', 'subject_moderator', 'contributor'] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

/** Authorship layers on a document (§4.3 `annotation_layer.kind`, §6.6). */
export const LAYER_KINDS = [
  'personal',
  'explanation',
  'answers',
  'published_snapshot',
  'followed',
  'forked',
  'group_comments',
  'suggestion',
  'collaborative',
] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

export const LAYER_KIND_LABELS_AR: Record<LayerKind, string> = {
  personal: 'ملاحظاتي',
  explanation: 'شرح',
  answers: 'إجابات',
  published_snapshot: 'نسخة منشورة',
  followed: 'شرح أتابعه',
  forked: 'نسخة مستقلة',
  group_comments: 'تعليقات المجموعة',
  suggestion: 'اقتراح تصحيح',
  collaborative: 'نسخة مشتركة',
};

/** Where a piece of content comes from — origins are always kept apart and labelled (spec §14). */
export const CONTENT_ORIGINS = [
  'source',
  'lecturer_said',
  'generated',
  'external_reference',
  'student_contribution',
  'moderator_reviewed',
  'my_notes',
] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

export const CONTENT_ORIGIN_LABELS_AR: Record<ContentOrigin, string> = {
  source: 'من الملف الأصلي',
  lecturer_said: 'قاله المحاضر',
  generated: 'شرح مولَّد',
  external_reference: 'مرجع خارجي',
  student_contribution: 'مساهمة طالب',
  moderator_reviewed: 'راجعه مشرف المادة',
  my_notes: 'ملاحظاتي',
};

// ─── zod (request validation on the server; parsing on the client) ──────────────────────────
export const visibilitySchema = z.enum(VISIBILITIES);
export const publicationVisibilitySchema = z.enum(PUBLICATION_VISIBILITIES);
export const channelKindSchema = z.enum(CHANNEL_KINDS);
export const channelRoleSchema = z.enum(CHANNEL_ROLES);
export const layerKindSchema = z.enum(LAYER_KINDS);
export const contentOriginSchema = z.enum(CONTENT_ORIGINS);
/** Unknown keys (e.g. an e-mail) are stripped: a UserRef never carries private fields. */
export const userRefSchema = z.object({
  id: z.string().min(1).max(64),
  display_name: z.string().min(1).max(120),
  avatar_url: z.string().max(2048).nullable(),
  former: z.boolean().optional(),
});
