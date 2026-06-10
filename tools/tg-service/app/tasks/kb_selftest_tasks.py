"""Celery task: Knowledge Base self-test (auto QA).

Validates that the knowledge base can actually answer questions about its own
content. The flow is:

1. Load all documents. If empty → DONE with an "empty base" summary.
2. Claude generates ~8-10 control questions (RU) that COVER the base content.
3. Each question is answered with the SAME whole-base context strategy as
   ``/kb/chat`` strict mode — via the shared
   :func:`app.api.v1.knowledge_base.answer_question_against_base` helper, so the
   retrieval logic is never duplicated.
4. Claude judges each Q/A pair: ``answered=true`` when the answer addressed the
   question from the base, ``false`` when it was "no info" / evasive. A short
   verdict is captured per question.

Results (per-question JSON, totals, gaps, a short RU summary) are persisted to
``tg_kb_selftest_runs``. The task is fully tolerant: any fatal error flips the
run to FAILED with the message; per-question failures are recorded but do not
abort the whole run.
"""

from __future__ import annotations

import json
import re
from typing import Any

import structlog

from app.ai.anthropic_client import generate_message
from app.api.v1.knowledge_base import answer_question_against_base
from app.core.database import get_db
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

_MODEL = "claude-haiku-4-5-20251001"
_MIN_QUESTIONS = 8
_MAX_QUESTIONS = 10
_DOC_TRUNCATE = 4000  # chars per doc fed into the question-generation prompt
_MAX_DOCS_FOR_QUESTIONS = 30

_GEN_SYSTEM = (
    "Ты — методист, который проверяет полноту базы знаний. Тебе дают фрагменты "
    "документов. Сгенерируй от 8 до 10 КОНТРОЛЬНЫХ вопросов на русском языке, "
    "которые ПОКРЫВАЮТ ключевую информацию из базы (факты, цифры, условия, "
    "процессы, термины). Вопросы должны быть конкретными и проверяемыми по базе. "
    "Верни СТРОГО валидный JSON — массив строк, без markdown, без пояснений. "
    'Пример: ["Вопрос 1?", "Вопрос 2?"]'
)

_JUDGE_SYSTEM = (
    "Ты — строгий проверяющий. Тебе дают ВОПРОС и ОТВЕТ ассистента базы знаний. "
    "Определи, действительно ли ответ содержательно отвечает на вопрос по "
    "сути (answered=true), либо ответ отсутствует / уклончивый / содержит фразу "
    "про отсутствие информации (answered=false). Верни СТРОГО валидный JSON: "
    '{"answered": true|false, "verdict": "<краткое объяснение на русском, до 200 '
    'символов>"}. Без markdown, без лишнего текста.'
)


def _strip_fences(text: str) -> str:
    """Remove ```json ... ``` fences if present."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    return text


def _parse_questions(raw: str) -> list[str]:
    """Tolerantly parse Claude's JSON array of question strings."""
    text = _strip_fences(raw)
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            return []
        try:
            parsed = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            return []
    if not isinstance(parsed, list):
        return []
    out: list[str] = []
    for q in parsed:
        if isinstance(q, str) and q.strip():
            out.append(q.strip())
    return out[:_MAX_QUESTIONS]


def _parse_judgement(raw: str) -> tuple[bool, str]:
    """Parse the judge's JSON ({answered, verdict}); tolerant defaults."""
    text = _strip_fences(raw)
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return False, "Не удалось разобрать вердикт"
        try:
            parsed = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            return False, "Не удалось разобрать вердикт"
    if not isinstance(parsed, dict):
        return False, "Не удалось разобрать вердикт"
    answered = bool(parsed.get("answered"))
    verdict = str(parsed.get("verdict") or "").strip()[:300]
    return answered, verdict


def _build_questions_prompt(docs: list[dict[str, Any]]) -> str:
    """Assemble the question-generation prompt from (truncated) documents."""
    parts = ["ФРАГМЕНТЫ БАЗЫ ЗНАНИЙ:"]
    for d in docs[:_MAX_DOCS_FOR_QUESTIONS]:
        title = d.get("title") or "Без названия"
        content = (d.get("content") or "").strip()[:_DOC_TRUNCATE]
        parts.append(f"---\n[Документ: {title}]\n{content}")
    return "\n".join(parts)


@celery_app.task(name="pup_tg.kb_self_test", bind=True, max_retries=0)
def kb_self_test(self, workspace_id: str, run_id: str) -> dict[str, Any]:  # type: ignore[override]
    """Generate control questions, answer them from the base, judge coverage."""
    log.info(
        "kb_self_test_started",
        workspace_id=workspace_id,
        run_id=run_id,
        celery_task_id=self.request.id,
    )

    try:
        db = get_db(workspace_id)
    except Exception as exc:
        log.error("kb_self_test_db_failed", workspace_id=workspace_id, error=str(exc))
        return {"status": "FAILED", "error": str(exc)[:300]}

    def _fail(message: str) -> dict[str, Any]:
        try:
            db.execute(
                """UPDATE tg_kb_selftest_runs
                   SET status = 'FAILED', error = ?, finished_at = datetime('now')
                   WHERE id = ?""",
                [message[:500], run_id],
            )
            db.commit()
        except Exception:
            log.warning("kb_self_test_fail_persist_failed", run_id=run_id, exc_info=True)
        return {"status": "FAILED", "error": message[:300]}

    # Mark RUNNING.
    try:
        db.execute(
            """UPDATE tg_kb_selftest_runs
               SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?""",
            [run_id],
        )
        db.commit()
    except Exception as exc:
        return _fail(f"Не удалось пометить запуск: {exc}")

    # Load all documents.
    try:
        rows = db.execute(
            "SELECT id, title, content FROM tg_kb_documents ORDER BY created_at ASC"
        ).fetchall()
        docs = [dict(r) for r in rows]
    except Exception as exc:
        return _fail(f"Ошибка загрузки документов: {exc}")

    if not docs:
        try:
            db.execute(
                """UPDATE tg_kb_selftest_runs
                   SET status = 'DONE', total = 0, answered = 0, gaps = 0,
                       results = '[]', summary = ?, finished_at = datetime('now')
                   WHERE id = ?""",
                ["База пуста", run_id],
            )
            db.commit()
        except Exception as exc:
            return _fail(f"Ошибка записи (пустая база): {exc}")
        log.info("kb_self_test_empty_base", workspace_id=workspace_id, run_id=run_id)
        return {"status": "DONE", "total": 0, "summary": "База пуста"}

    # Step 1: generate control questions.
    try:
        gen = generate_message(
            system_prompt=_GEN_SYSTEM,
            user_message=_build_questions_prompt(docs),
            model=_MODEL,
            max_tokens=1024,
            temperature=0.4,
        )
        questions = _parse_questions(gen.get("text", ""))
    except Exception as exc:
        return _fail(f"Ошибка генерации вопросов: {exc}")

    if not questions:
        return _fail("Claude не вернул контрольных вопросов")

    if len(questions) < _MIN_QUESTIONS:
        log.warning(
            "kb_self_test_few_questions",
            run_id=run_id,
            count=len(questions),
        )

    # Steps 2 + 3: answer each question against the whole base, then judge it.
    results: list[dict[str, Any]] = []
    answered_count = 0
    for question in questions:
        try:
            answer, _sources = answer_question_against_base(db, question, mode="strict")
        except Exception as exc:
            log.warning("kb_self_test_answer_failed", run_id=run_id, error=str(exc)[:200])
            results.append(
                {
                    "question": question,
                    "answer": "",
                    "answered": False,
                    "verdict": f"Ошибка при ответе: {str(exc)[:150]}",
                }
            )
            continue

        try:
            judge = generate_message(
                system_prompt=_JUDGE_SYSTEM,
                user_message=f"ВОПРОС:\n{question}\n\nОТВЕТ:\n{answer}",
                model=_MODEL,
                max_tokens=512,
                temperature=0.0,
            )
            is_answered, verdict = _parse_judgement(judge.get("text", ""))
        except Exception as exc:
            log.warning("kb_self_test_judge_failed", run_id=run_id, error=str(exc)[:200])
            is_answered, verdict = False, f"Ошибка оценки: {str(exc)[:150]}"

        if is_answered:
            answered_count += 1
        results.append(
            {
                "question": question,
                "answer": answer,
                "answered": is_answered,
                "verdict": verdict,
            }
        )

    total = len(results)
    gaps = total - answered_count

    gap_questions = [r["question"] for r in results if not r["answered"]]
    if gaps:
        gap_preview = "; ".join(q[:80] for q in gap_questions[:3])
        summary = f"База отвечает на {answered_count} из {total}; пробелы: {gap_preview}"
    else:
        summary = f"База отвечает на {answered_count} из {total}; пробелов нет"

    try:
        db.execute(
            """UPDATE tg_kb_selftest_runs
               SET status = 'DONE', total = ?, answered = ?, gaps = ?,
                   results = ?, summary = ?, finished_at = datetime('now')
               WHERE id = ?""",
            [
                total,
                answered_count,
                gaps,
                json.dumps(results, ensure_ascii=False),
                summary[:1000],
                run_id,
            ],
        )
        db.commit()
    except Exception as exc:
        return _fail(f"Ошибка записи результатов: {exc}")

    log.info(
        "kb_self_test_done",
        workspace_id=workspace_id,
        run_id=run_id,
        total=total,
        answered=answered_count,
        gaps=gaps,
    )
    return {"status": "DONE", "total": total, "answered": answered_count, "gaps": gaps}
