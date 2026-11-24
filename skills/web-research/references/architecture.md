# Архитектура web-research

> **upstream:** `Johell1NS/browser-search` (MIT). Скрипты cloak/\* и Readability.js
> завендорены; освежение vendored - `scripts/update-vendor.sh` (тянет тег upstream).

## Слой движков (вход - `scripts/web.ts`)

`web.ts` - единый вход: парсинг флагов, выбор движка, каскады, `health`. Движки
изолированы в `scripts/engines/`:

| Модуль             | Движок                           | Транспорт                                  |
| ------------------ | -------------------------------- | ------------------------------------------ |
| `engines/zai.ts`   | z.ai MCP                         | API: web_search_prime / web_reader / zread |
| `engines/local.ts` | SearXNG + Camofox + CloakBrowser | docker-стек + vendored CLI                 |

- `--engine auto` (default): zai primary, local fallback; `zai` / `local` - forced,
  каскада нет, недоступность = ошибка.
- `research` получает движковые флоу инъекцией (`ResearchDeps` в `local.ts`): без инъекции
  `local.ts` чисто локален, каскады подключает `web.ts`.
- Провенанс каскадов: каждый результат/источник несёт `engine` (zai / имя searxng-движка /
  camofox / cloak); `browser` - только у fetch-результатов/источников (у `SearchResult`
  его нет, только `engine`); эскалации пишутся в stderr (`{"escalate": ...}`) - маршрут
  виден модели.
- Специфика zai-движка (MCP-клиент, транспорт z.ai, квота/health) -
  `references/engines.md`.

## Локальный стек (`engines/local.ts`): три слоя

| Слой            | Инструмент                         | Транспорт             | Роль                                                                                                           |
| --------------- | ---------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Поиск           | **SearXNG** (Docker `:9388`)       | `curl` -> JSON        | Метапоиск Google/Bing/DDG/Wiki, отдаёт `{title,url,snippet}`                                                   |
| Браузер fast    | **Camofox** (Docker `:9377`)       | REST, табы            | Firefox+Camoufox, всегда тёплый. Snapshot (accessibility-tree) + `evaluate` (JS) + Readability.js. ~90% сайтов |
| Браузер stealth | **CloakBrowser** (npm, Playwright) | CLI `cloak-fetch.mjs` | Fresh Chromium, 58 C++ патчей, детект Cloudflare/Akamai/DataDome/Imperva/PX/DDoS-Guard. ~10% сайтов            |

## Каскады (auto-режим)

```
search(query)
  `- zai web_search_prime
       |- ok (пустой массив - валидный ответ) -----> отдаём
       `- ошибка транспорта -----------------------> searxng (ротация + cascade)

fetch(url)
  `- zai webReader (default readability, markdown)
       |- chars > 0 -------------------------------> отдаём
       `- ошибка / пустой контент ----------------> local.doFetch
            |- SSRF-гейт (validateUrlWithDns)
            |- camofox: POST /tabs -> wait/scroll -> extract -> DELETE /tabs
            |     looksBlocked? -------------------> cloak (challenge-detect + wait)
            `- cloak упал -------------------------> camofox as-is + warning

research(q): каскады search/fetch инъекцией; snippet short-circuit -> fetch top-N
            -> consolidate -> markdown-дайджест
```

`--engines` пинит SearXNG - zai не зовётся вовсе; `--selector` / `--schema` / `--format`
(не default) / `--browser` пинят local.

## Эскалация camofox -> cloak (решение в `looksBlocked`)

Решение принимается по трёхуровневой схеме (от самого точного к fallback):

1. **`detectChallenge()` из завендоренного `cloak/challenges.mjs`** - primary. После
   загрузки страницы один `/evaluate` собирает сигналы (scripts/iframes/links,
   id/class/data-\* атрибуты, cookies) и скармливает их той же функции, что сам cloak
   использует для детекта **Cloudflare/Akamai/DataDome/Imperva/PerimeterX/DDoS-Guard**.
   Ловит soft-challenge без видимого текста: по кукам `_abck`/`__ddg`, ресурсам
   `/cdn-cgi/challenge-platform/` и т.п. `responseHeaders` через REST Camofox недоступны,
   но cookie/resource/DOM-маркеров хватает на все 6 вендоров. ->
   `escalateReason = <strategy>` (напр. `akamai-bot-manager-challenge`).
2. **Текстовые маркеры** (regex): `just a moment`, `checking your browser`,
   `cf-challenge`, `attention required`, `access denied` -> `challenge-text`. Быстрая
   подстраховка.
3. **Длина** - по **оригинальному** `res.chars` (не обрезанному `res.text`!), иначе малый
   `--max-chars` даёт ложную эскалацию. `<200` -> `empty-content` (JS не отрендерился).

Probe гоняется только для full-page форматов (readability/text/html) - targeted
(selector/schema/snapshot) не эскалируют.

## Токен-оптимизация (4 рычага)

1. **Авто-выбор извлечения** (код решает, не модель):
   - статья/доки -> **Readability.js** (режет nav/ads/footer, ~70% экономии)
   - список/SPA/поиск -> **snapshot** (accessibility-tree, ~90% меньше HTML)
   - таблицы/`<pre>`/`<code>` -> `--selector CSS` (evaluate по селектору)
   - структурированный выхват -> `--schema JSON` (нативный Camofox `/extract` по refs
     e1,e2...)

2. **Snippet short-circuit** в `research`: если сниппеты выдачи (zai или SearXNG) уже
   перекрывают значимые термины запроса - браузер не открывается. Самый дешёвый путь.

3. **Руль модели**: `--selector` / `--schema` - когда авто-эвристика промахнулась.

4. **Сквозной бюджет**: `--max-chars` (fetch), `--budget-chars/N` (research - поровну
   между источниками), truncate на каждом этапе.

## Стабильность поиска (ротация движков + cascade-fallback)

SearXNG по умолчанию опрашивает **все** ~63 `general`-движка на каждый запрос (parallel
fan-out), включая translate/wikimedia/регионалку. Под нагрузкой это выжигает upstream:
каждый движок получает каждый запрос, CAPTCHA наступает быстро, агрегат обнуляется.

`engines/local.ts` (вход - `web.ts`) срезает это двумя механизмами:

1. **Ротация (по умолчанию).** Без явного `--engines` берётся случайный `subset`
   (дефолт 3) из кураторского пула реальных веб-движков:
   - **Tier A** - `bing duckduckgo brave mojeek qwant startpage yahoo yandex`
   - **Tier B** - `dogpile infospace privacywall presearch yep crowdview mwmbl ayo`
     `resulthunter searchtoday tusksearch vuhuv gabanza reloado fynd`

   Fisher-Yates, без state между вызовами - нагрузка размазывается статистически
   равномерно. Покрытие не страдает: SearXNG мёрджит и ранжирует, топ формируют Tier-A, а
   примесь Tier-B лишь добавляет кандидатов - иногда это единственные живые движки, когда
   гиганты капчат.

   |                            | запросов/1 search | на 40 search | каждый движок получает |
   | -------------------------- | ----------------- | ------------ | ---------------------- |
   | агрегат SearXNG (все 63)   | ~63               | ~2520        | ~40                    |
   | ротация (пул 23, subset 3) | 3 (+1 fallback)   | ~120         | ~5-20                  |

2. **Cascade-fallback.** Выбранный subset вернул 0 (выпали троттлящиеся движки) -> повтор
   со стабильным ядром `bing,qwant,mojeek`. Только для авто-ротации; явный `--engines X`
   уважается как есть - без ротации и без fallback.

**Рычаги (env, с дефолтами - трогать не обязательно):** `SEARXNG_POOL` (список),
`SEARXNG_SUBSET` (3), `SEARXNG_ENGINES` (ядро fallback'а).

**Не чинит фундамент scraping'а.** CAPTCHA - это барьер доверия (cookie/аккаунт), который
stateless-метапоиск структурно не может пройти: Chrome после прохождения капчи получает
clearance-cookie, SearXNG - нет. Ротация отодвигает порог, но не снимает потолок. Для
тяжёлого/ программного использования нужен API-движок (`braveapi`, не CAPTCHA-механизм)
или прокси. SearXNG-таймеры suspension: CAPTCHA=24ч, Cloudflare-challenge=15 дней,
reCAPTCHA=7 дней.

## Что НЕ делает

- Не обходит paywall.
- CloakBrowser ставит проприетарный Chromium-бинарник (SHA-256 verified, но closed).

## Безопасность / SSRF

`validateUrlWithDns()` (`cloak/lib/url-validation.mjs`) вызывается **один раз на входе
`doFetch` в `engines/local.ts`** - покрывает все браузерные пути: camofox по умолчанию,
cloak, `--selector`, `--schema`. zai webReader фетчит URL на стороне z.ai - локальный гейт
к нему не относится. Блокирует приватные/loopback/link-local диапазоны,
cloud-metadata-эндпоинты, `*.localhost`, IPv4-mapped IPv6 (`::ffff:a.b.c.d`). Обходной
флаг vendored cloak (`--unsafe`) через `web.ts` не пробрасывается - гейт обязателен.

**Не является полной защитой от DNS-rebinding:** проверка резолвит хост один раз, а
браузер резолвит независимо - public->private flip на низком TTL теоретически возможен.
Полная защита требует IP-pinning или блокирующего резолвера. Также: "sandbox" в
`cloak/lib/sandbox.mjs` фильтрует только Playwright-API, **не** изолирует Node.js
(untrusted `--script` = полный RCE). Реальная граница изоляции - только OS-level
(контейнер/VM).

## Двухслойная модель pi

Канон выбора слоя - скилл `harness-authoring`.

- **Layer 1, вариант B** - внешний CLI через `bash`. Ноль schema-стоимости, рендер как у
  команды. Это `scripts/web.ts`.
- **Layer 2 - capability skill.** `SKILL.md`: только name+desc в системном промпте (~30
  токенов), тело грузится по `read`. "Когда/зачем звать".

Нативный `pi.registerTool` (вариант A) тут намеренно **не** нужен: параметры простые,
TUI-рендер не требуется, а schema в каждом запросе - то, от чего скилл-подход спасает.
