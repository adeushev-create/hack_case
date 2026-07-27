// ============================================================
// Сервер записи команд на кейсы хакатона.
// Node.js + Express, хранение — JSON-файл (атомарная запись).
// Однопоточная модель Node гарантирует отсутствие гонок:
// проверка лимита и запись происходят синхронно.
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { event, tracks, cases } = require("./cases");
const { teams } = require("./teams");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me-please";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "signups.json");

// ---------- Хранилище ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let signups = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    signups = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch (e) {
  console.error("Не удалось прочитать данные, стартуем с пустого списка:", e.message);
}

function persist() {
  // атомарно: пишем во временный файл, потом переименовываем
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(signups, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Помощники ----------
const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));
const teamByTable = Object.fromEntries(teams.map((t) => [t.table, t.team]));

function counts() {
  const m = {};
  for (const c of cases) m[c.id] = 0;
  for (const s of signups) if (m[s.caseId] !== undefined) m[s.caseId]++;
  return m;
}

function publicState() {
  const m = counts();
  return {
    event,
    tracks,
    cases: cases.map((c) => ({
      id: c.id,
      track: c.track,
      title: c.title,
      situation: c.situation,
      task: c.task,
      gets: c.gets,
      deliver: c.deliver,
      limit: c.limit,
      taken: m[c.id],
      left: Math.max(0, c.limit - m[c.id]),
      full: m[c.id] >= c.limit,
    })),
    totalTeams: signups.length,
    updatedAt: new Date().toISOString(),
  };
}

const clean = (v, max = 200) =>
  String(v || "").replace(/\s+/g, " ").trim().slice(0, max);

// ---------- Rate limit (без внешних зависимостей) ----------
// Railway кладёт приложение за прокси — без этого все запросы выглядят
// так, будто пришли с одного и того же внутреннего IP, и лимит сломает всех разом.
function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: "Слишком много попыток. Подождите немного и повторите." });
    }
    next();
  };
}
// Пишем в записи не чаще ~20 раз в минуту с одного IP — не мешает толпе за
// одним NAT (Wi-Fi офиса), но режет скрипт, который долбит регистрацию.
const signupLimiter = rateLimiter({ windowMs: 60_000, max: 20 });
// Админку защищаем от перебора токена — 60 запросов в минуту с лихвой хватает на реальную работу.
const adminLimiter = rateLimiter({ windowMs: 60_000, max: 60 });

// ---------- Приложение ----------
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1m" }));

// Живой статус мест (поллинг с фронта)
app.get("/api/state", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(publicState());
});

// Реестр столов -> команд (для автоподстановки в форме)
app.get("/api/teams", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ teams });
});

// Запись команды
app.post("/api/signup", signupLimiter, (req, res) => {
  const tableRaw = req.body.table;
  const table = Number.parseInt(tableRaw, 10);
  const captain = clean(req.body.captain, 100);
  const contact = clean(req.body.contact, 150);
  const caseId = clean(req.body.caseId, 10);
  let team = clean(req.body.team, 100);

  if (!Number.isInteger(table) || table < 1 || table > 150 || !captain || !contact || !caseId) {
    return res.status(400).json({ error: "Заполните все поля (номер стола от 1 до 150)." });
  }
  const c = caseById[caseId];
  if (!c) return res.status(400).json({ error: "Такого кейса нет." });

  // Если стол есть в реестре — берём каноничное имя из базы, не доверяя вводу с клиента
  if (teamByTable[table]) {
    team = teamByTable[table];
  } else if (!team) {
    return res.status(400).json({ error: "Стол не найден в реестре — укажите название команды вручную." });
  }

  if (signups.some((s) => s.table === table)) {
    return res.status(409).json({
      error: "Этот стол уже записан на кейс. Одна команда — один кейс.",
    });
  }

  // Проверка лимита и запись — синхронно, гонки невозможны
  const taken = signups.filter((s) => s.caseId === caseId).length;
  if (taken >= c.limit) {
    return res.status(409).json({ error: "Мест на этот кейс больше нет. Выберите другой." });
  }

  const rec = {
    id: crypto.randomUUID(),
    caseId,
    table,
    team,
    captain,
    contact,
    createdAt: new Date().toISOString(),
  };
  signups.push(rec);
  try {
    persist();
  } catch (e) {
    signups.pop();
    console.error("Ошибка записи на диск:", e);
    return res.status(500).json({ error: "Ошибка сервера, попробуйте ещё раз." });
  }
  res.json({ ok: true, caseTitle: c.title, team, left: c.limit - taken - 1 });
});

// ---------- Админка ----------
function checkToken(req, res) {
  const t = req.query.token || req.headers["x-admin-token"];
  if (t !== ADMIN_TOKEN) {
    res.status(403).json({ error: "Неверный токен." });
    return false;
  }
  return true;
}

app.use(["/api/admin", "/api/export.csv"], adminLimiter);

app.get("/api/admin/data", (req, res) => {
  if (!checkToken(req, res)) return;
  res.set("Cache-Control", "no-store");
  res.json({ state: publicState(), signups });
});

app.delete("/api/admin/signup/:id", (req, res) => {
  if (!checkToken(req, res)) return;
  const before = signups.length;
  signups = signups.filter((s) => s.id !== req.params.id);
  if (signups.length === before) return res.status(404).json({ error: "Запись не найдена." });
  persist();
  res.json({ ok: true });
});

app.get("/api/export.csv", (req, res) => {
  if (!checkToken(req, res)) return;
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [
    ["Кейс", "Название кейса", "№ стола", "Команда", "Капитан", "Контакт", "Время записи"],
    ...signups
      .slice()
      .sort((a, b) => Number(a.caseId) - Number(b.caseId) || a.createdAt.localeCompare(b.createdAt))
      .map((s) => [
        s.caseId,
        caseById[s.caseId] ? caseById[s.caseId].title : "?",
        s.table ?? "",
        s.team,
        s.captain,
        s.contact,
        s.createdAt,
      ]),
  ];
  const csv = "\uFEFF" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="hackathon-signups.csv"');
  res.send(csv);
});

app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

app.get("/board", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "board.html"))
);

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Админка: http://localhost:${PORT}/admin?token=${ADMIN_TOKEN}`);
});
