---
name: web-research
description: |
  Используй для любого веб-поиска и браузинга: поиск, чтение страниц, research и чтение
  GitHub-репо без клона (zread) - через z.ai MCP; локального стека и stealth нет. НЕ для
  мутаций в вебе и действий от лица пользователя (read-only); соцсети (IG/FB/X/...) -
  только сниппеты.
---

# web-research

Один CLI - `node scripts/web.ts <cmd>` - поверх **z.ai MCP** (web_search_prime /
web_reader / zread). Оркестрация research (отбор источников, бюджет, дайджест) - **в
коде**, не в голове модели. Специфика движка, квота, health - `references/engines.md`.

## Запуск

Node >= 23.6 (built-in TS type stripping: `web.ts` запускается напрямую). Ноль
зависимостей и bootstrap.

Ключ zai - `~/.pi/agent/auth.json` (поле `zai.key`) или env `ZAI_API_KEY`.

Диагностика: `node scripts/web.ts health` -> доступность `zai` + кредитные окна `mcp`.

## Команды и флаги

| Команда              | Зачем                                          |
| -------------------- | ---------------------------------------------- |
| `search <query>`     | найти ссылки / факты из сниппетов              |
| `fetch <url>`        | прочитать конкретную страницу (markdown)       |
| `research <query>`   | ответ из сети одной командой (search -> fetch) |
| `zread <owner/repo>` | GitHub-репозиторий без клона                   |
| `health`             | доступность z.ai + квота                       |

`zread`-сабкоманды: `doc <query>` (поиск по документации репо), `tree [dir]`,
`file <path>`.

| Флаг                         | Команды           | Смысл                                                 |
| ---------------------------- | ----------------- | ----------------------------------------------------- |
| `--max N`                    | search            | лимит результатов (default 10)                        |
| `--lang xx`                  | search, zread doc | язык запроса (search его игнорирует)                  |
| `--time day/week/month/year` | search            | свежесть выдачи                                       |
| `--raw`                      | search            | JSON вместо markdown-списка                           |
| `--max-chars N`              | fetch, zread      | потолок текста (default 20000)                        |
| `--sources M`                | research          | сколько источников фетчить (default 3)                |
| `--budget-chars N`           | research          | бюджет дайджеста, поровну на источник (default 12000) |
| `--no-browse`                | research          | только сниппеты, без открытия страниц                 |

Примеры:

```bash
SCRIPTS=~/.pi/agent/skills/web-research/scripts

node "$SCRIPTS/web.ts" search "largest llm benchmark 2026" --max 8 --lang en
node "$SCRIPTS/web.ts" fetch "https://example.com/article" --max-chars 8000
node "$SCRIPTS/web.ts" research "rust vs zig memory safety" --sources 3 --budget-chars 12000
node "$SCRIPTS/web.ts" zread facebook/react doc "concurrent rendering"
```

## Квота zai

Квота кредитная: вызовы расходуют кредиты, окна - с лимитом и датой обнуления. Текущий
расход показывает `health` - окна в `mcp` (`<потрачено>/<лимит>` на окно). Исчерпание
кредитов = ошибка вызова, отдельной предпроверки нет.

## Ограничения

- Read-only.
- Соцсети (Instagram/FB/TikTok/LinkedIn/X) - только сниппеты: фильтр на выдаче, страницы
  не открываем (требуют логин).
- `zread` - только публичные GitHub-репозитории.
- Жёсткий лимит запроса поиска - 70 символов (длиннее режется с заметкой в stderr).
