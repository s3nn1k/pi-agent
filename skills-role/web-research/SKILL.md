---
name: web-research
description: |
  Используй для любого веб-поиска и браузинга: поиск и чтение страниц (zai primary,
  локальный stealth-fallback против Cloudflare/Akamai/DataDome) и чтение GitHub-репо
  без клона (zread). НЕ для мутаций в вебе и действий от лица пользователя
  (read-only); соцсети (IG/FB/X/...) - только сниппеты.
---

# web-research

Один CLI - `node scripts/web.ts <cmd>` - поверх движкового слоя: **zai MCP** (primary) и
**локальный стек** SearXNG + Camofox + CloakBrowser (fallback, stealth). Оркестрация
(каскады, эскалация, выбор извлечения, бюджет токенов) - **в коде**, не в голове модели.

> **upstream:** локальный стек и vendored скрипты - `Johell1NS/browser-search` (MIT);
> освежение vendored - `scripts/update-vendor.sh`. Разбор движков, каскадов и
> токен-оптимизации - `references/architecture.md`.

## Запуск

Node >= 23.6 (built-in TS type stripping: `web.ts` запускается напрямую).

Ключ zai - `~/.pi/agent/auth.json` (поле `zai.key`) или env `ZAI_API_KEY`: с ним
search/fetch/research работают без docker-стека.

Локальный стек (один раз на машину):

```bash
node ~/.pi/agent/skills/web-research/scripts/web.ts init
```

Тянет docker-образы SearXNG + Camofox, качает Chromium (~140 МБ) для cloak, генерит
`scripts/.env` (ключи Camofox/SearXNG), поднимает контейнеры. После перезагрузки
контейнеры поднимаются сами (`restart: unless-stopped`), если Docker автостартует. Иначе
нужен повторный `init` - идемпотентный, с fast-path: стек жив - выйдет мгновенно.
Безопасно звать в любой непонятной ситуации.

`web.ts` сам подгружает `scripts/.env`; экспортированные env-переменные сильнее `.env`.

Диагностика: `node scripts/web.ts health` -> `searxng` / `camofox` / `cloak` / `zai` +
квота `mcp`.

## Команды и флаги

| Команда              | Зачем                                          |
| -------------------- | ---------------------------------------------- |
| `search <query>`     | найти ссылки / факты из сниппетов              |
| `fetch <url>`        | прочитать конкретную страницу                  |
| `research <query>`   | ответ из сети одной командой (search -> fetch) |
| `zread <owner/repo>` | GitHub-репозиторий без клона                   |
| `health`             | состояние движков + квота zai                  |
| `init`               | bootstrap локального стека                     |

`zread`-сабкоманды: `doc <query>` (поиск по документации репо), `tree [dir]`,
`file <path>`.

| Флаг                                   | Команды                     | Смысл                                                         |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `--engine zai/local`                   | search, fetch, research     | пин движка (default: auto-каскад)                             |
| `--max N`                              | search                      | лимит результатов (default 10)                                |
| `--lang xx`                            | search, research, zread doc | язык запроса (фильтрует только searxng; zai-поиск игнорирует) |
| `--time day/week/month/year`           | search                      | свежесть выдачи                                               |
| `--engines a,b`                        | search                      | пин SearXNG-движков (выключает zai и ротацию)                 |
| `--raw`                                | search                      | JSON вместо markdown-списка                                   |
| `--max-chars N`                        | fetch, zread                | потолок текста (default 20000)                                |
| `--format`                             | fetch                       | readability (default) / text / html / snapshot                |
| `--selector CSS`                       | fetch                       | текст по селектору (local)                                    |
| `--schema JSON`                        | fetch                       | структурированный extract по refs (local)                     |
| `--browser auto/camofox/cloak`         | fetch                       | пин браузера локального каскада                               |
| `--scroll`, `--wait ms`, `--proxy URL` | fetch (local)               | поведение браузера                                            |
| `--sources M`                          | research                    | сколько источников фетчить (default 3)                        |
| `--budget-chars N`                     | research                    | бюджет дайджеста, поровну на источник (default 12000)         |
| `--no-browse`                          | research                    | только сниппеты, без открытия страниц                         |

Примеры:

```bash
SCRIPTS=~/.pi/agent/skills/web-research/scripts

node "$SCRIPTS/web.ts" search "largest llm benchmark 2026" --max 8 --lang en
node "$SCRIPTS/web.ts" fetch "https://example.com/article" --max-chars 8000
node "$SCRIPTS/web.ts" research "rust vs zig memory safety" --sources 3 --budget-chars 12000
node "$SCRIPTS/web.ts" zread facebook/react doc "concurrent rendering"
```

## Движки и каскады

| Движок | Транспорт                                  | Покрывает                                        |
| ------ | ------------------------------------------ | ------------------------------------------------ |
| zai    | API: web_search_prime / web_reader / zread | search, fetch (markdown), zread - primary        |
| local  | SearXNG (ротация) + camofox -> cloak       | search, fetch всех форматов - fallback + stealth |

Auto-каскады (default):

| Команда  | Каскад                            | Когда эскалация                                   |
| -------- | --------------------------------- | ------------------------------------------------- |
| search   | zai -> SearXNG                    | ошибка транспорта zai; пустой ответ zai - валиден |
| fetch    | zai webReader -> camofox -> cloak | ошибка или пустой контент                         |
| research | каскады search/fetch внутри флоу  | провенанс engine у каждого источника              |

- `--engine zai` / `--engine local`: каскада нет, недоступность движка = ошибка.
- `--engines`, `--selector`, `--schema`, `--format` (не default), `--browser` - контракты
  локального стека: пинят local, zai не зовётся.
- Stealth-страницы (Cloudflare/Akamai/DataDome/...) тянет локальный camofox -> cloak.

## Квота zai

Лимит вызовов zai - 4000/мес на ключ. Текущий расход: `health` ->
`mcp: <потрачено>/<лимит>`. Исчерпание = ошибка вызова: авто-режим уходит на local,
`--engine zai` - падает громко.

## Ограничения

- Read-only, кроме явных скриншотов (`scripts/cloak/scripts/screenshot.mjs`).
- Соцсети (Instagram/FB/TikTok/LinkedIn/X) - только сниппеты: фильтр на выдаче обоих
  движков, страницы не открываем (требуют логин).
- `zread` - только публичные GitHub-репозитории.
- SSRF-фильтр (приватные/loopback/cloud-metadata) на входе локального fetch/research -
  best-effort, не полная защита от DNS-rebinding (SSRF-bypass vendored cloak `--unsafe`
  через `web.ts` недоступен). Детали - `references/architecture.md`.
