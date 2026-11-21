/**
 * Permission vocabulary shared by the member card and the member form.
 *
 * The wire carries three sandbox modes; their labels and their order live
 * here so the card and the form cannot drift, and an absent mode keeps its own
 * "inherit" copy instead of reading as one of the three.
 */
import { t } from './locales.ts'
import type { AgentsKey } from './locales.ts'
import type { AgentsPermission } from '../protocol.ts'

/** The three modes, in wire order. */
export const PERMISSION_MODES: readonly AgentsPermission[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Dictionary key per mode. */
const PERMISSION_KEYS: Record<AgentsPermission, AgentsKey> = {
  'read-only': 'permission.read-only',
  'workspace-write': 'permission.workspace-write',
  'danger-full-access': 'permission.danger-full-access',
}

/**
 * The label of one mode, or the inherit label when the member pins none.
 * @param permission - the pinned mode, if any.
 */
export function permissionLabel(permission: AgentsPermission | undefined): string {
  return permission === undefined ? t('member.inherit') : t(PERMISSION_KEYS[permission])
}
