# Движок zai: MCP-клиент, квота, health

Единственный движок - `scripts/engines/zai.ts`; CLI-слой - `scripts/web.ts`.

## MCP-клиент

- Ключ: env `ZAI_API_KEY` > `~/.pi/agent/auth.json` (поле `zai.key`). Нет ключа - ошибка
  вызова. Ключ не логируется.
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
- webReader всегда отдаёт markdown: форматов, селекторов и схем извлечения нет.
- Соц-фильтр на выдаче (`socialBlocked` в `lib/common.ts`).

## Квота и health

- Квота кредитная - monitor-API (не MCP-эндпоинт): записи `CREDIT_LIMIT` в `data.limits[]`
  (unit, number, usage, currentValue, remaining, percentage, nextResetTime) плюс
  `data.level`; записей старого типа (окна по вызовам) больше нет - остались только
  кредитные. `health` показывает окна как `mcp: <currentValue>/<usage>[, ...]`.
- Нераспознанная форма ответа - деградация, не ошибка: `zai: ok`, `mcp: n/a`.
- Предпроверки квоты перед вызовом нет: исчерпание кредитов проявляется ошибкой вызова.
