<p align="center">
  <img src="public/images/ice-rink-banner.webp" alt="Пустая хоккейная арена ночью" width="100%">
</p>

<h1 align="center">Ледовый штаб</h1>

<p align="center">
  Расчёт состава и оптимальных замен в фэнтези КХЛ по правилам Sports.ru
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="PostgreSQL и Drizzle ORM" src="https://img.shields.io/badge/PostgreSQL-Drizzle_ORM-4169E1?logo=postgresql&logoColor=white">
  <img alt="Тесты Playwright" src="https://img.shields.io/badge/tests-Playwright-2EAD33?logo=playwright&logoColor=white">
</p>

**Ледовый штаб** сам загружает вашу команду из фэнтези КХЛ на Sports.ru, прогнозирует очки игроков и подбирает замены, которые дадут больше всего очков. Бюджет, позиции, лимит игроков одного клуба и пять трансферов в неделю учитываются автоматически.

## Возможности

- **Автосинхронизация с Sports.ru.** Профиль, состав из 17 игроков, цены, статистика и календарь обновляются каждые 5 минут. Используются только публичные данные — логин от Sports.ru не нужен.
- **Прогноз очков.** Форма с экспоненциальным затуханием (полураспад — 6 матчей), сжатие к оценке по цене игрока, поправка на силу соперника и вероятность сыграть после пропусков.
- **Замены на неделю.** Точная целочисленная оптимизация по слотам с учётом позиций, бюджета, лимита клуба, 5 трансферов и заблокированных игроков. Для каждой замены показано, когда её сделать и до какого времени успеть, а порядок шагов не уводит баланс в минус.
- **План на месяц.** Четыре недели вперёд методом скользящего горизонта (около 1,3 с), включая подготовительные замены.
- **Проверка расчёта.** План проходит 9 проверок: прирост, бюджет на каждом шаге, позиции 2/6/9, лимит клуба после каждой замены, блокировки и другие.
- **Кого взять.** Пул кандидатов из составов всех соперников по лиге и сравнение каждого из них с игроком вашего состава.
- **Импорт и экспорт.** Дополнительных кандидатов можно добавить из CSV или JSON (есть CSV-шаблон), а список игроков — выгрузить в JSON.
- **Интерфейс в стиле X (Lights out).** Тёмная тема, адаптив от 390 до 1440 px.

## Разделы

| Раздел | Что внутри |
| --- | --- |
| Обзор и расчёт | Профиль команды, замены на неделю, план на месяц, условия расчёта и его проверка |
| Состав и пул | Состав по позициям, кандидаты, поиск и фильтры |
| Рейтинг игроков | Лучшие игроки сезона по данным Sports.ru |
| Правила и тактика | Правила Fantasy КХЛ, начисление очков, устройство калькулятора и советы |

В правой колонке — поиск, ваша лига и блок «Кого взять».

## Качество прогноза

Бэктест на данных Sports.ru: прежняя модель против текущей.

| Метрика | Было | Стало |
| --- | ---: | ---: |
| RMSE, очки | 13,90 | 12,90 |
| MAE, очки | 11,03 | 10,18 |
| Завышение прогноза, очки | +2,52 | +1,45 |
| RMSE для игроков после пропусков | 15,05 | 12,38 |
| Brier, прогноз доступности | 0,089 | 0,056 |

## Быстрый старт

Нужны Node.js 20.9+ и PostgreSQL.

```bash
git clone https://github.com/CMetan-lgtm/khl-fantasy-team-optimizer-x.git
cd khl-fantasy-team-optimizer-x
npm install
DATABASE_URL=postgresql://user:pass@localhost:5432/db npm run dev
```

Откройте http://localhost:3000.

Переменная `DATABASE_URL` обязательна. База хранит резервные снимки команды в таблице `sports_team_snapshots` (схема — в `src/db/schema.ts`). Создать таблицу можно командой `npx drizzle-kit push`, адрес базы для неё указан в `drizzle.config.json`. Если база недоступна, приложение продолжит работать на последнем снимке в памяти сервера.

Команда по умолчанию задаётся константой `CONNECTED_TEAM_ID` в `src/lib/sports-types.ts`.

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run dev` | Запускает dev-сервер |
| `npm run build`, `npm start` | Собирает и запускает production-версию |
| `npm run lint` | Проверяет код ESLint |
| `npm run typecheck` | Проверяет типы TypeScript |
| `npx playwright test` | Запускает 33 теста: 24 на логику и 9 UI-тестов с живым подключением к Sports.ru |

Для UI-тестов нужны запущенный сервер (по умолчанию http://127.0.0.1:3000, другой адрес задаётся через `TEST_BASE_URL`) и браузер Playwright: `npx playwright install chromium`.

## API

| Запрос | Ответ |
| --- | --- |
| `GET /api/sports?teamId=<id>` | Снимок команды: профиль, состав, кандидаты и рейтинг игроков. Без `teamId` — команда по умолчанию |
| `GET /api/sports?teamId=<id>&refresh=1` | То же с принудительным обновлением (не чаще раза в 15 секунд) |
| `GET /api/health` | Проверка подключения к базе данных |

Снимок кэшируется на 5 минут. Если Sports.ru недоступен, API вернёт последний удачный снимок с пометкой `stale: true`.

## Структура проекта

```text
src/
├── app/
│   ├── api/sports/route.ts      # синхронизация с Sports.ru и кэш снимков
│   ├── api/health/route.ts      # проверка базы данных
│   ├── fantasy-dashboard.tsx    # интерфейс приложения
│   └── globals.css              # стили в духе X
├── db/                          # Drizzle ORM: подключение и схема
├── hooks/use-sports-sync.ts     # автообновление данных в браузере
└── lib/
    ├── sports-source.ts         # разбор публичных страниц Sports.ru
    ├── fantasy.ts               # модель прогноза и план на месяц
    ├── weekly-optimizer.ts      # оптимизация замен на неделю
    ├── candidate-comparison.ts  # сравнение кандидатов с составом
    └── sports-types.ts          # общие типы и настройки синхронизации
public/images/                   # баннер профиля
tests/sports-sync.spec.ts        # тесты Playwright
```

## Стек

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · PostgreSQL и Drizzle ORM · cheerio · javascript-lp-solver · Playwright

Что изменилось в последней версии, описано в [CHANGES.md](CHANGES.md).

## Дисклеймер

Неофициальный проект, не связан с КХЛ и Sports.ru. Приложение читает только публичные данные Sports.ru и не запрашивает учётные данные. Баннер профиля сгенерирован ИИ.
