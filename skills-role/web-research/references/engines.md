# Движок zai: MCP-клиент, квота, health

> Каркас движкового слоя (модули `engines/`, авто-каскады, forced-режимы) - в
> `references/architecture.md`; здесь - специфика zai-движка (`scripts/engines/zai.ts`).

## MCP-клиент

- Ключ: env `ZAI_API_KEY` > `~/.pi/agent/auth.json` (поле `zai.key`). Нет ключа - движок
  недоступен: auto молча уходит в local, forced zai - ошибка. Ключ не логируется.
- Handshake/сессия: `initialize` -> заголовок `mcp-session-id` ->
  `notifications/initialized`. Сессия кэшируется на процесс (handshake = 2 запроса);
  сбойный handshake не кэшируется, поэтому транзиентный сбой не травит процесс навсегда.
- Транспорт-специфика z.ai (почему код выглядит странно):
  - POST-ответы идут как SSE (`data:`-строки) или plain JSON - парсим оба;
  - auth-отказы - HTTP 200 с `code:401/403` в теле: HTTP-статусу верить нельзя;
  - tool-сбои - HTTP 200, текст ошибки в `content[0].text`, `isError` бывает `false` даже
    на реальном сбое (второй слой детекта - в decodeText для zread);
  - search/reader: `content[0].text` - JSON-строка внутри JSON-строки (double decode);
    zread - одинарное кодирование;
  - search: жёсткий лимит запроса 70 символов - режем с заметкой в stderr; не-массив в
    payload = тело ошибки (напр. 429 при исчерпании квоты) - падаем громко: тихий `[]`
    маскировал бы квоту под "ничего не нашлось".
- webReader всегда отдаёт markdown, без выбора браузера: targeted-извлечения (`--selector`
  / `--schema` / `--format` не-default) и явный `--browser` - контракты локального
  каскада, zai их не покрывает.
- Соц-фильтр на выдаче - общий с local (`socialBlocked` в `lib/common.ts`).

## Квота и health

- Квота zai - monitor-API (не MCP-эндпоинт): запись `TIME_LIMIT`, месячный лимит
  вызовов 4000. `health` показывает её как `mcp: <потрачено>/<лимит>`.
- `health` мерджит `local.doHealth()` (`searxng` / `camofox` / `camofox_auth` / `cloak`,
  включая наличие Chromium-бинарника) и `zaiHealth()` (`zai` / `mcp`).
- Предпроверки квоты перед вызовом нет: исчерпание проявляется ошибкой вызова и уводит
  авто-каскад в local.
