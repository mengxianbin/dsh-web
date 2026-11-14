/** Message-edit dictionaries; zh owns the key set and en mirrors it. */

export const zh = {
  'edit.button': '编辑并重发',
  'edit.textarea': '编辑消息内容',
  'edit.cancel': '取消',
  'edit.save': '重新发送',
  'edit.saving': '正在创建分支…',
  'edit.hint': '重新发送将开启新分支，不会撤销已执行的操作。',
  'edit.shortcut': 'Ctrl/Cmd + Enter 重新发送，Esc 取消。',
  'edit.failed': '编辑重发失败：{reason}',
  'edit.running': '当前会话仍在运行，结束后可编辑重发。',
  'edit.noAccess': '当前环境不允许创建会话分支。',
}

export type MessageEditKey = keyof typeof zh

export const en: Record<MessageEditKey, string> = {
  'edit.button': 'Edit and resend',
  'edit.textarea': 'Edit message text',
  'edit.cancel': 'Cancel',
  'edit.save': 'Resend',
  'edit.saving': 'Creating branch…',
  'edit.hint': 'Resending opens a new branch and does not undo actions already performed.',
  'edit.shortcut': 'Ctrl/Cmd + Enter to resend, Esc to cancel.',
  'edit.failed': 'Edit and resend failed: {reason}',
  'edit.running': 'Wait for the current session to finish before editing and resending.',
  'edit.noAccess': 'This environment does not allow session branching.',
}
