/**
 * Russian dictionary for the "browser-view" locale namespace.
 * Source package: packages/dsh-browser-view (its zh dictionary is the key source).
 * Maintained centrally by the dsh-i18n language pack; when a zh key is added
 * or changed upstream, mirror it here and run `pnpm i18n:check`.
 *
 * The panel is a right-sidebar tab: the shell names the chip, and a page title
 * published by the body replaces the default text once a page is open.
 */

export const ru: Record<string, string> = {
  'tab.title': 'Вид браузера',
  'guide.description': 'Смотреть страницу, которой управляет агент',
  'panel.tab.untitled': 'Без названия',
  'panel.url.empty': 'Страница ещё не открыта',
  'panel.address.label': 'Адрес страницы',
  'panel.toolbar.refresh': 'Обновить изображение',
  'panel.frame.alt': 'Живое изображение страницы, которой управляет агент',
  'panel.empty.title': 'Изображения пока нет',
  'panel.empty.hint': 'Когда агент откроет страницу, здесь будет видно страницу, которую он смотрит.',
  'panel.error.title': 'Ошибка вида браузера',
  'panel.trace.idle': 'Действий инструментов пока нет',
  'panel.status.connecting': 'Подключение',
  'panel.status.loading': 'Загрузка',
  'panel.status.live': 'В реальном времени',
}
