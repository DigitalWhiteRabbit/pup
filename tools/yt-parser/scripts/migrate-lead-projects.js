"use strict";
/**
 * Одноразовая миграция: привязать все лиды без project_id к проекту id=3 (CopyBanner).
 * Запуск: node scripts/migrate-lead-projects.js
 */
require("dotenv").config();
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "data", "parser.db"));

const PROJECT_ID = 3;

// Проверяем что проект существует
const project = db
  .prepare(`SELECT id, name FROM projects WHERE id = ?`)
  .get(PROJECT_ID);
if (!project) {
  console.error(`Проект id=${PROJECT_ID} не найден в БД. Прерываем.`);
  process.exit(1);
}
console.log(`Проект найден: id=${project.id} "${project.name}"`);

// Считаем сколько лидов без project_id
const { total } = db
  .prepare(`SELECT COUNT(*) AS total FROM leads WHERE project_id IS NULL`)
  .get();
console.log(`Лидов без project_id: ${total}`);

if (total === 0) {
  console.log("Нечего обновлять. Выход.");
  process.exit(0);
}

// Обновляем в транзакции
const now = new Date().toISOString();
const updateStmt = db.prepare(
  `UPDATE leads SET project_id = ?, updated_at = ? WHERE project_id IS NULL`,
);

let result;
try {
  const transaction = db.transaction(() => {
    result = updateStmt.run(PROJECT_ID, now);
  });
  transaction();
} catch (e) {
  console.error(`Ошибка при обновлении: ${e.message}`);
  process.exit(1);
}

console.log(`Обновлено: ${result.changes} лидов → project_id=${PROJECT_ID}`);

// Контрольная проверка
const { remaining } = db
  .prepare(`SELECT COUNT(*) AS remaining FROM leads WHERE project_id IS NULL`)
  .get();
console.log(`Осталось без project_id: ${remaining}`);

process.exit(0);
