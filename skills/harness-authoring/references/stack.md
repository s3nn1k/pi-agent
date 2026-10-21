# Стек харнеса

Состав стека и откуда что грузится - справочник для авторинга конфигурации.

- **pi-coding-agent** - базовый агент: cli + read/bash/edit/write, контекст-файлы
  (AGENTS.md/CLAUDE.md), скиллы, расширения, промпт-команды, агенты. Системный промпт -
  SYSTEM.md; APPEND_SYSTEM.md - механизм платформы, в этом харнесе не используется.
- **pi-subagents** (npm-пакет `~/.pi/agent/npm/`) - субагенты per-role, контексты
  fresh/fork, chains/workflows, modelScope; скиллы пакета: `pi-subagents`, `council-mode`.
- **Скиллы** - глобально `~/.pi/agent/skills/` (этот репо); проектно `.pi/skills/` (после
  trust); harness-agnostic `~/.agents/skills/`.
- **Расширения** - `~/.pi/agent/extensions/` (ambient): скоупинг контекста
  (`scope-agents-md.ts`), учёт квоты.
