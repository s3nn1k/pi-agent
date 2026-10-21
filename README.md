# pi-coding-agent - конфиг

Личный конфиг харнеса
[`pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent). Каталог живёт по
пути `~/.pi/agent` и хранит настройки, темы, скиллы и кастомных агентов.

Подробности о видении и принципах сетапа - в скилле `harness-authoring`.

## Структура

| Путь            | Назначение                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `AGENTS.md`     | Main-политика: делегирование субагентов, артефакты, гейт репо                                   |
| `settings.json` | Настройки харнеса (модель, тема, пакеты и т.д.)                                                 |
| `models.json`   | Кастомные провайдеры и модели                                                                   |
| `skills/`       | Скиллы пользователя (глобальные; грузятся во всех проектах)                                     |
| `.pi/skills/`   | Проектные скиллы (только в этом репо, после trust): настройка/расширение харнеса (сейчас пусто) |
| `themes/`       | Цветовые темы (JSON)                                                                            |
| `prompts/`      | Промпт-команды (слэш-команды)                                                                   |
| `agents/`       | Кастомные субагенты                                                                             |
| `extensions/`   | TS-расширения харнеса (глобальные; грузятся во всех сессиях - root + subagents)                 |
| `Makefile`      | Dev-gate: `make init` (prettier/tsc), `make lint` (format + typecheck)                          |
| `package.json`  | devDeps: prettier, typescript, @earendil-works/pi-coding-agent (типы extensions)                |
| `npm/`          | Каталог установленных npm-пакетов (gitignored; источник правды - `settings.json:packages`)      |
| `auth.json`     | Учётные данные/ключи (gitignored, **секрет**)                                                   |
| `sessions/`     | Рантайм-данные сессий (gitignored)                                                              |

## Установка на новой машине

```bash
git clone <repo> ~/.pi/agent
cd ~/.pi/agent

# 1. Сгенерировать auth.json под свои ключи/провайдеры
#    (в репо его нет - это секрет)
# 2. Поставить пакеты, объявленные в settings.json ("packages")
#    pi подтянет их автоматически, либо вручную:
npm --prefix npm install

# 3. Dev-tooling (formatter/typecheck; типы extensions - через devDep):
make init
#    после правок кода - `make lint` (форматирует + typecheck)
```

## Чего в репо нет (намеренно)

- `auth.json` - секрет, держится локально и в `.gitignore`.
- `trust.json` - доверенные проекты (gitignored; без trust проектные `.pi/`-каталоги не
  грузятся).
- `sessions/`, `missions/`, `npm/`, `node_modules/` - рантайм и устанавливаемые артефакты.
- `bin/` - вендорные бинарники (`fd` и т.п.), генерятся заново при установке.
