/**
 * routes/account-profile.js
 * Редактирование профиля TG-аккаунта — порт account_profile.py (tg-service) на Node/GramJS.
 * Монтируется под /api/telegram → пути: /accounts/:id/profile/...
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { Api } = require("telegram");
const { CustomFile } = require("telegram/client/uploads");
const { stmts, db } = require("../db/database");
const { adminAuth } = require("../utils/auth");
const { withAccountClient } = require("../services/telegram-outreach");

const router = express.Router();

// ─── Constants ───────────────────────────────────────────────────────────────

const AVATAR_DIR = path.join(__dirname, "..", "data", "tg-avatars");
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const BIO_MAX = 70;
const USERNAME_RE = /^[a-z0-9_]{5,32}$/;
const PRIVACY_KEYS = ["phone", "photo", "last_seen"];
const PRIVACY_VALUES = ["everybody", "contacts", "nobody"];
const DEFAULT_PRIVACY = {
  phone: "contacts",
  photo: "contacts",
  last_seen: "contacts",
};
const APPLY_PARTS = ["name", "username", "photo", "privacy"];
const AVATAR_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── AI client (lazy) ────────────────────────────────────────────────────────

let _ai = null;
function aiClient() {
  if (_ai) return _ai;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY не задан");
  _ai = new Anthropic({ apiKey, maxRetries: 3 });
  return _ai;
}

// ─── multer ──────────────────────────────────────────────────────────────────

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─── Auth gate: mutable routes require adminAuth ─────────────────────────────

router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadRow(id) {
  const row = stmts.getTgAccount.get(id);
  if (!row) {
    const e = new Error("Account not found");
    e.status = 404;
    throw e;
  }
  return row;
}

function parseMeta(raw) {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw);
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

function normalizePrivacy(raw) {
  const out = { ...DEFAULT_PRIVACY };
  if (raw && typeof raw === "object") {
    for (const k of PRIVACY_KEYS) {
      const v = raw[k];
      if (typeof v === "string" && PRIVACY_VALUES.includes(v)) out[k] = v;
    }
  }
  return out;
}

function avatarPath(accountId) {
  return path.join(AVATAR_DIR, `${accountId}.jpg`);
}

function avatarRoute(accountId) {
  return `/api/telegram/accounts/${accountId}/profile/avatar`;
}

function buildProfile(row, meta) {
  const rel = meta.avatar_path;
  let hasAvatar = false;
  if (rel) {
    const base = path.resolve(path.join(__dirname, "..", "data"));
    const full = path.resolve(path.join(__dirname, "..", "data", rel));
    hasAvatar = full.startsWith(base + path.sep) && fs.existsSync(full);
  }
  return {
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    username: row.username || null,
    bio: meta.bio || null,
    bio_ru: meta.bio_ru || null,
    avatar_url: hasAvatar ? avatarRoute(row.id) : null,
    privacy: normalizePrivacy(meta.privacy),
    profile_applied_at: meta.profile_applied_at || null,
    profile_applied_parts: meta.profile_applied_parts || null,
  };
}

function deriveCountry(row) {
  const c = (row.country || "").trim();
  if (c) return c;
  const p = (row.phone || "").replace(/\s+/g, "");
  if (p.startsWith("+7") || p.startsWith("7")) return "Russia";
  if (p.startsWith("+380")) return "Ukraine";
  if (p.startsWith("+373")) return "Moldova";
  if (p.startsWith("+375")) return "Belarus";
  return "International";
}

function slugifyUsername(raw) {
  let s = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);
  if (s.length < 5)
    s = (s + "_usr" + Math.floor(Math.random() * 9000 + 1000)).slice(0, 32);
  return s;
}

function apiError(res, status, msg) {
  return res.status(status).json({ success: false, error: msg });
}

async function antiBanSleep(first) {
  if (!first)
    await new Promise((r) =>
      setTimeout(r, 1000 + Math.floor(Math.random() * 2000)),
    );
}

// ─── GET /accounts/:id/profile ───────────────────────────────────────────────

router.get("/accounts/:id/profile", (req, res) => {
  try {
    const row = loadRow(parseInt(req.params.id, 10));
    res.json({
      success: true,
      profile: buildProfile(row, parseMeta(row.metadata)),
    });
  } catch (e) {
    apiError(res, e.status || 500, e.message);
  }
});

// ─── PATCH /accounts/:id/profile ─────────────────────────────────────────────

router.patch("/accounts/:id/profile", adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = loadRow(id);
    const meta = parseMeta(row.metadata);
    const body = req.body || {};

    if (body.bio != null && body.bio.length > BIO_MAX)
      return apiError(
        res,
        400,
        `bio не может быть длиннее ${BIO_MAX} символов`,
      );

    if (body.username != null && body.username !== "") {
      body.username = body.username.toLowerCase().replace(/^@/, "");
      if (!USERNAME_RE.test(body.username))
        return apiError(res, 400, "username: 5-32 символа, только a-z 0-9 _");
    }

    if (body.privacy && typeof body.privacy === "object") {
      for (const [k, v] of Object.entries(body.privacy)) {
        if (v != null && !PRIVACY_VALUES.includes(v))
          return apiError(
            res,
            400,
            `privacy.${k} должен быть одним из: ${PRIVACY_VALUES.join(", ")}`,
          );
      }
    }

    const colParts = [];
    const vals = { id };
    if (body.first_name !== undefined) {
      colParts.push("first_name = @first_name");
      vals.first_name = body.first_name;
    }
    if (body.last_name !== undefined) {
      colParts.push("last_name = @last_name");
      vals.last_name = body.last_name;
    }
    if (body.username !== undefined) {
      colParts.push("username = @username");
      vals.username = body.username;
    }

    if (body.bio !== undefined) meta.bio = body.bio;
    if (body.bio_ru !== undefined) meta.bio_ru = body.bio_ru;
    if (body.privacy && typeof body.privacy === "object") {
      const cur = normalizePrivacy(meta.privacy);
      for (const k of PRIVACY_KEYS) {
        if (body.privacy[k] != null) cur[k] = body.privacy[k];
      }
      meta.privacy = cur;
    }

    colParts.push("metadata = @metadata");
    vals.metadata = JSON.stringify(meta);
    colParts.push("updated_at = @updated_at");
    vals.updated_at = new Date().toISOString();

    db.prepare(
      `UPDATE tg_account SET ${colParts.join(", ")} WHERE id = @id`,
    ).run(vals);
    const fresh = loadRow(id);
    res.json({
      success: true,
      profile: buildProfile(fresh, parseMeta(fresh.metadata)),
    });
  } catch (e) {
    apiError(res, e.status || 500, e.message);
  }
});

// ─── POST /accounts/:id/profile/generate-identity ────────────────────────────

router.post(
  "/accounts/:id/profile/generate-identity",
  adminAuth,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = loadRow(id);
      const country = deriveCountry(row);
      const body = req.body || {};

      const gender = ["male", "female"].includes(body.gender)
        ? body.gender
        : null;
      const niche = (body.niche || "").trim() || "an ordinary everyday person";

      const keepFirst =
        body.gen_first === false && !!(body.first_name || "").trim();
      const keepLast =
        body.gen_last === false && !!(body.last_name || "").trim();
      const keptFirst = (body.first_name || "").trim().slice(0, 64);
      const keptLast = (body.last_name || "").trim().slice(0, 64);

      const nameRules = [];
      if (keepFirst) {
        nameRules.push(
          `KEEP first_name EXACTLY as "${keptFirst}" — return it verbatim.`,
        );
      } else {
        nameRules.push(
          "Generate a VARIED, realistic first name authentic for the country and gender; vary it on every generation.",
        );
      }
      if (keepLast) {
        nameRules.push(
          `KEEP last_name EXACTLY as "${keptLast}" — return it verbatim.`,
        );
      } else {
        nameRules.push(
          "Generate a VARIED, realistic surname for the country (do NOT default to the single most common surname; vary it on every generation).",
        );
      }

      const systemPrompt =
        "You generate realistic human Telegram personas. " +
        "Reply with ONLY a single JSON object, no markdown fences, no prose. " +
        "Keys: first_name, last_name, username, bio, bio_ru. " +
        nameRules.join(" ") +
        " " +
        "CRITICAL: username MUST be derived from the final first_name+last_name — latin lowercase 5-32 chars a-z 0-9 underscore. " +
        `bio MUST be ≤${BIO_MAX} chars, authentic for niche/country, written in the local language (NOT English unless country is English-speaking). ` +
        "bio_ru: faithful Russian translation of bio for a Russian-speaking moderator.";

      const userMsg =
        `Country: ${country}\nGender: ${gender || "any"}\nNiche: ${niche}\n` +
        `Seed: ${crypto.randomBytes(4).toString("hex")} — vary every generation.\n` +
        "Generate the persona JSON now.";

      const resp = await aiClient().messages.create({
        model: HAIKU_MODEL,
        max_tokens: 400,
        temperature: 1.0,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });

      let text = (
        resp.content.find((b) => b.type === "text")?.text || ""
      ).trim();
      if (text.startsWith("```"))
        text = text.replace(/^```[a-z]*\n?/, "").replace(/```$/, "");
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return apiError(res, 502, "AI вернул непарсируемый ответ");

      let data;
      try {
        data = JSON.parse(match[0]);
      } catch {
        return apiError(res, 502, "AI вернул невалидный JSON");
      }

      let firstName = String(data.first_name || "")
        .trim()
        .slice(0, 64);
      let lastName = String(data.last_name || "")
        .trim()
        .slice(0, 64);
      if (keepFirst) firstName = keptFirst;
      if (keepLast) lastName = keptLast;
      if (!firstName) return apiError(res, 502, "AI не вернул имя");

      const username = slugifyUsername(String(data.username || ""));
      const bio = String(data.bio || "")
        .trim()
        .slice(0, BIO_MAX);
      const bioRu = String(data.bio_ru || "").trim();

      res.json({
        success: true,
        suggestion: {
          first_name: firstName,
          last_name: lastName,
          username,
          bio,
          bio_ru: bioRu,
        },
      });
    } catch (e) {
      apiError(res, e.status || 500, e.message);
    }
  },
);

// ─── POST /accounts/:id/profile/translate ────────────────────────────────────

router.post("/accounts/:id/profile/translate", adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    loadRow(id);
    const text = (req.body?.text || "").trim();
    if (!text) return res.json({ success: true, translation: "" });

    const resp = await aiClient().messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      temperature: 0.3,
      system:
        "Translate the user's text into Russian. Reply with ONLY the Russian translation — no quotes, no notes, no original.",
      messages: [{ role: "user", content: text }],
    });
    const translation = (
      resp.content.find((b) => b.type === "text")?.text || ""
    ).trim();
    res.json({ success: true, translation });
  } catch (e) {
    apiError(res, e.status || 500, e.message);
  }
});

// ─── POST /accounts/:id/profile/generate-avatar ──────────────────────────────

router.post(
  "/accounts/:id/profile/generate-avatar",
  adminAuth,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = loadRow(id);

      const sources = [
        "https://thispersondoesnotexist.com/",
        `https://i.pravatar.cc/512?u=${id}`,
      ];
      let imgBytes = null;
      let lastErr = "";
      for (const url of sources) {
        try {
          const r = await fetch(url, {
            headers: { "User-Agent": AVATAR_UA, Accept: "image/jpeg,image/*" },
            redirect: "follow",
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) {
            lastErr = `${url}: HTTP ${r.status}`;
            continue;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length >= 512) {
            imgBytes = buf;
            break;
          }
          lastErr = `${url}: слишком маленький ответ`;
        } catch (e) {
          lastErr = `${url}: ${e.message}`;
        }
      }
      if (!imgBytes)
        return apiError(
          res,
          502,
          `Все источники аватаров недоступны: ${lastErr}`,
        );

      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      fs.writeFileSync(avatarPath(id), imgBytes);

      const meta = parseMeta(row.metadata);
      meta.avatar_path = `tg-avatars/${id}.jpg`;
      db.prepare(
        `UPDATE tg_account SET metadata = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(meta), new Date().toISOString(), id);

      res.json({ success: true, avatar_url: avatarRoute(id) });
    } catch (e) {
      apiError(res, e.status || 500, e.message);
    }
  },
);

// ─── POST /accounts/:id/profile/upload-avatar ────────────────────────────────

router.post(
  "/accounts/:id/profile/upload-avatar",
  adminAuth,
  uploadAvatar.single("file"),
  (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = loadRow(id);
      if (!req.file) return apiError(res, 400, "файл обязателен");
      if (req.file.buffer.length < 512)
        return apiError(res, 400, "Файл слишком мал");
      const ctype = (req.file.mimetype || "").toLowerCase();
      if (ctype && !ctype.startsWith("image/"))
        return apiError(res, 400, `Ожидалось изображение, получен ${ctype}`);

      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      fs.writeFileSync(avatarPath(id), req.file.buffer);

      const meta = parseMeta(row.metadata);
      meta.avatar_path = `tg-avatars/${id}.jpg`;
      db.prepare(
        `UPDATE tg_account SET metadata = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(meta), new Date().toISOString(), id);

      res.json({ success: true, avatar_url: avatarRoute(id) });
    } catch (e) {
      apiError(res, e.status || 500, e.message);
    }
  },
);

// ─── GET /accounts/:id/profile/avatar ────────────────────────────────────────

router.get("/accounts/:id/profile/avatar", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = loadRow(id);
    const meta = parseMeta(row.metadata);

    const base = path.resolve(path.join(__dirname, "..", "data"));
    let candidate = null;
    if (meta.avatar_path) {
      const full = path.resolve(
        path.join(__dirname, "..", "data", meta.avatar_path),
      );
      if (full.startsWith(base + path.sep) && fs.existsSync(full))
        candidate = full;
    }
    if (!candidate) {
      const det = avatarPath(id);
      if (fs.existsSync(det)) candidate = det;
    }
    if (!candidate) return apiError(res, 404, "Аватар не задан");

    res.setHeader("Content-Type", "image/jpeg");
    res.sendFile(candidate);
  } catch (e) {
    apiError(res, e.status || 500, e.message);
  }
});

// ─── POST /accounts/:id/profile/check-username ───────────────────────────────

router.post(
  "/accounts/:id/profile/check-username",
  adminAuth,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = loadRow(id);
      const username = (req.body?.username || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
      if (!USERNAME_RE.test(username))
        return apiError(res, 400, "username: 5-32 символа, только a-z 0-9 _");

      let available = false;
      await withAccountClient(row, async (client) => {
        available = await client.invoke(
          new Api.account.CheckUsername({ username }),
        );
      });
      res.json({ success: true, username, available });
    } catch (e) {
      apiError(res, e.status || 500, e.message);
    }
  },
);

// ─── POST /accounts/:id/profile/apply ────────────────────────────────────────

router.post("/accounts/:id/profile/apply", adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = loadRow(id);
    const meta = parseMeta(row.metadata);

    const requested =
      Array.isArray(req.body?.parts) && req.body.parts.length > 0
        ? req.body.parts
        : [...APPLY_PARTS];
    const unknown = requested.filter((p) => !APPLY_PARTS.includes(p));
    if (unknown.length)
      return apiError(
        res,
        400,
        `Неизвестные части: ${unknown.join(", ")}; допустимы: ${APPLY_PARTS.join(", ")}`,
      );

    const parts = APPLY_PARTS.filter((p) => requested.includes(p));
    const doParts = new Set(parts);

    const firstName = row.first_name || "";
    const lastName = row.last_name || "";
    const username = row.username || "";
    const bio = meta.bio || "";
    const avatarRel = meta.avatar_path || "";
    const privacy = normalizePrivacy(meta.privacy);

    const applied = {};
    let first = true;
    let nameOk = false;
    let usernameOk = false;

    await withAccountClient(row, async (client) => {
      // name + bio
      if (doParts.has("name")) {
        await antiBanSleep(first);
        first = false;
        try {
          await client.invoke(
            new Api.account.UpdateProfile({ firstName, lastName, about: bio }),
          );
          applied.name = "ok";
          nameOk = true;
        } catch (e) {
          applied.name = `error: ${String(e.message || e).slice(0, 120)}`;
        }
      }

      // username
      if (doParts.has("username")) {
        if (username) {
          await antiBanSleep(first);
          first = false;
          try {
            await client.invoke(new Api.account.UpdateUsername({ username }));
            applied.username = "ok";
            usernameOk = true;
          } catch (e) {
            applied.username = `error: ${String(e.errorMessage || e.message || e).slice(0, 120)}`;
          }
        } else {
          applied.username = "error: username не задан";
        }
      }

      // photo
      if (doParts.has("photo")) {
        if (avatarRel) {
          const base = path.resolve(path.join(__dirname, "..", "data"));
          const fullPath = path.resolve(
            path.join(__dirname, "..", "data", avatarRel),
          );
          if (fullPath.startsWith(base + path.sep) && fs.existsSync(fullPath)) {
            await antiBanSleep(first);
            first = false;
            try {
              const stat = fs.statSync(fullPath);
              const file = await client.uploadFile({
                file: new CustomFile(
                  path.basename(fullPath),
                  stat.size,
                  fullPath,
                ),
                workers: 1,
              });
              await client.invoke(new Api.photos.UploadProfilePhoto({ file }));
              applied.photo = "ok";
            } catch (e) {
              applied.photo = `error: ${String(e.message || e).slice(0, 120)}`;
            }
          } else {
            applied.photo = "error: файл аватара не найден";
          }
        } else {
          applied.photo = "error: аватар не задан";
        }
      }

      // privacy
      if (doParts.has("privacy")) {
        await antiBanSleep(first);
        first = false;
        const keyMap = {
          phone: new Api.InputPrivacyKeyPhoneNumber(),
          photo: new Api.InputPrivacyKeyProfilePhoto(),
          last_seen: new Api.InputPrivacyKeyStatusTimestamp(),
        };
        const privErrors = [];
        for (const [k, keyObj] of Object.entries(keyMap)) {
          try {
            const val = privacy[k];
            const rule =
              val === "everybody"
                ? new Api.InputPrivacyValueAllowAll()
                : val === "nobody"
                  ? new Api.InputPrivacyValueDisallowAll()
                  : new Api.InputPrivacyValueAllowContacts();
            await client.invoke(
              new Api.account.SetPrivacy({ key: keyObj, rules: [rule] }),
            );
          } catch (e) {
            privErrors.push(`${k}: ${String(e.message || e).slice(0, 80)}`);
          }
        }
        applied.privacy =
          privErrors.length === 0 ? "ok" : `error: ${privErrors.join("; ")}`;
      }
    });

    // Сохраняем результат в БД
    const setParts = [];
    const colVals = { id };
    if (nameOk) {
      setParts.push("first_name = @first_name", "last_name = @last_name");
      colVals.first_name = firstName;
      colVals.last_name = lastName;
    }
    if (usernameOk) {
      setParts.push("username = @username");
      colVals.username = username;
    }
    if (Object.keys(applied).length > 0) {
      meta.profile_applied_at = new Date().toISOString();
      meta.profile_applied_parts = parts;
      setParts.push("metadata = @metadata");
      colVals.metadata = JSON.stringify(meta);
    }
    if (setParts.length > 0) {
      setParts.push("updated_at = @updated_at");
      colVals.updated_at = new Date().toISOString();
      db.prepare(
        `UPDATE tg_account SET ${setParts.join(", ")} WHERE id = @id`,
      ).run(colVals);
    }

    res.json({ success: true, applied });
  } catch (e) {
    apiError(res, e.status || 500, e.message);
  }
});

module.exports = router;
