/**
 * Russian dictionary for the "sysmon" locale namespace.
 * Source package: packages/dsh-sysmon (its zh dictionary is the key source).
 * Maintained centrally by the dsh-i18n language pack; when a zh key is added
 * or changed upstream, mirror it here and run `pnpm i18n:check`.
 */

export const ru: Record<string, string> = {
  'chip.aria': 'Нагрузка на систему',
  'chip.cpu': 'ЦП',
  'chip.mem': 'Память',
  'chip.disk': 'Диск',
  'chip.title': 'Нагрузка на систему (сэмпл 1 с, на стороне хоста)',
  'chip.diskDetail': 'Диск: чтение {read} · запись {write} МБ/с',
  'chip.memDetail': 'Память {used} / {total} ГБ · доступно {avail} ГБ',
  'chip.stamp': 'Обновлено в {t}',
}
