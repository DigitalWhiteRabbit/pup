/**
 * InnerTube API — извлечение ссылок и метаданных из вкладки "О канале" YouTube.
 * Используем внутренний API YouTube (browse endpoint) без API-ключа.
 * Бесплатно, без квоты, но требует аккуратного парсинга.
 */

const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/browse";
const CLIENT_VERSION = "2.20240101.00.00";

// Рейт-лимит: минимальная задержка между запросами (мс)
const RATE_LIMIT_MS = 500;
let lastRequestTime = 0;

/**
 * Задержка для соблюдения рейт-лимита.
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, RATE_LIMIT_MS - elapsed),
    );
  }
  lastRequestTime = Date.now();
}

/**
 * Декодирует YouTube redirect URL — извлекает реальный URL из параметра q.
 * Пример: https://www.youtube.com/redirect?event=...&q=https%3A%2F%2Ft.me%2Fxyz → https://t.me/xyz
 */
function decodeRedirectUrl(url) {
  if (!url) return url;
  try {
    // Если это redirect-ссылка YouTube
    if (
      url.includes("youtube.com/redirect") ||
      url.includes("youtube.com%2Fredirect")
    ) {
      const parsed = new URL(url);
      const q = parsed.searchParams.get("q");
      if (q) return q;
    }
    // Если URL закодирован (содержит %3A)
    if (url.includes("%3A") || url.includes("%2F")) {
      return decodeURIComponent(url);
    }
  } catch {
    // Ошибка парсинга — возвращаем как есть
  }
  return url;
}

/**
 * POST-запрос к InnerTube browse endpoint.
 */
async function innertubePost(body) {
  const res = await fetch(INNERTUBE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Запрашивает вкладку "О канале" через InnerTube API (двухшаговый).
 * Шаг 1: browse с params → получаем continuation token
 * Шаг 2: browse с continuation → получаем aboutChannelViewModel
 * @param {string} channelId — ID канала (UCxxxx)
 * @returns {object|null} — { links, country, description, joinedDate } или null при ошибке
 */
async function fetchChannelAbout(channelId) {
  if (!channelId) return null;

  const clientContext = {
    context: { client: { clientName: "WEB", clientVersion: CLIENT_VERSION } },
  };

  try {
    // Шаг 1: получаем continuation token
    await rateLimitWait();
    const data1 = await innertubePost({
      ...clientContext,
      browseId: channelId,
      params: "EgVhYm91dA==", // base64("about")
    });

    // Сначала пробуем найти aboutChannelViewModel напрямую (старый формат)
    let aboutViewModel = extractAboutViewModel(data1);

    // Если не нашли — ищем continuation token (новый формат 2024+)
    if (!aboutViewModel) {
      const json1 = JSON.stringify(data1);
      const tokenMatch = json1.match(/"token":"([A-Za-z0-9_-]{50,})"/);
      if (!tokenMatch) {
        console.log(`[innertube] Нет continuation token для ${channelId}`);
        return null;
      }

      // Шаг 2: запрос с continuation token
      await rateLimitWait();
      const data2 = await innertubePost({
        ...clientContext,
        continuation: tokenMatch[1],
      });

      aboutViewModel = extractAboutViewModel(data2);
    }

    if (!aboutViewModel) {
      console.log(
        `[innertube] Не найдена aboutChannelViewModel для ${channelId}`,
      );
      return null;
    }

    // Извлекаем поля
    const description = aboutViewModel.description || "";
    const country = aboutViewModel.country || "";
    const joinedDate = aboutViewModel.joinedDateText?.content || "";
    const subscriberCount = aboutViewModel.subscriberCountText || "";
    const viewCount = aboutViewModel.viewCountText || "";

    // Извлекаем ссылки
    const rawLinks = aboutViewModel.links || [];
    const links = rawLinks
      .map((linkItem) => {
        const vm = linkItem.channelExternalLinkViewModel || linkItem;
        const title = vm.title?.content || vm.title || "";
        let url = vm.link?.content || vm.link || "";
        url = decodeRedirectUrl(url);
        return { title, url };
      })
      .filter((l) => l.url);

    console.log(
      `[innertube] Найдено ${links.length} ссылок для канала ${channelId}`,
    );

    return {
      links,
      country,
      description: description.slice(0, 2000),
      joinedDate,
      subscriberCount,
      viewCount,
    };
  } catch (e) {
    console.error(`[innertube] Ошибка для ${channelId}:`, e.message);
    return null;
  }
}

/**
 * Безопасно извлекает aboutChannelViewModel из ответа InnerTube.
 * Пробуем несколько путей на случай изменения структуры.
 */
function extractAboutViewModel(data) {
  // Путь 1: стандартный (onResponseReceivedEndpoints)
  try {
    const endpoint = data.onResponseReceivedEndpoints?.[0];
    const items = endpoint?.appendContinuationItemsAction?.continuationItems;
    if (items?.[0]?.aboutChannelRenderer?.metadata?.aboutChannelViewModel) {
      return items[0].aboutChannelRenderer.metadata.aboutChannelViewModel;
    }
  } catch {
    /* пробуем другой путь */
  }

  // Путь 2: header → aboutChannelRenderer (иногда встречается)
  try {
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const tabRenderer = tab.tabRenderer;
      if (
        tabRenderer?.tabIdentifier === "about" ||
        tabRenderer?.title === "About"
      ) {
        const section = tabRenderer.content?.sectionListRenderer?.contents?.[0];
        const itemSection = section?.itemSectionRenderer?.contents?.[0];
        if (
          itemSection?.aboutChannelRenderer?.metadata?.aboutChannelViewModel
        ) {
          return itemSection.aboutChannelRenderer.metadata
            .aboutChannelViewModel;
        }
      }
    }
  } catch {
    /* пробуем другой путь */
  }

  // Путь 3: прямой доступ через header
  try {
    if (data.header?.aboutChannelViewModel) {
      return data.header.aboutChannelViewModel;
    }
  } catch {
    /* не найден */
  }

  return null;
}

/**
 * Из массива ссылок извлекает структурированные контакты.
 * @param {Array<{title: string, url: string}>} links
 * @returns {object} — { telegram, instagram, twitter, email, website, otherLinks }
 */
function extractContactsFromLinks(links) {
  if (!links || !Array.isArray(links)) {
    return {
      telegram: "",
      instagram: "",
      twitter: "",
      email: "",
      website: "",
      otherLinks: [],
    };
  }

  const result = {
    telegram: "",
    instagram: "",
    twitter: "",
    email: "",
    website: "",
    otherLinks: [],
  };

  for (const { title, url } of links) {
    if (!url) continue;
    const lower = url.toLowerCase();

    // Telegram
    if (lower.includes("t.me/") || lower.includes("telegram.me/")) {
      const handle = extractHandle(
        url,
        /(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)/i,
      );
      if (handle && !result.telegram) {
        result.telegram = handle;
      }
      continue;
    }

    // Instagram
    if (lower.includes("instagram.com/")) {
      const handle = extractHandle(url, /instagram\.com\/([a-zA-Z0-9_.]+)/i);
      if (handle && !result.instagram) {
        result.instagram = handle;
      }
      continue;
    }

    // Twitter / X
    if (lower.includes("twitter.com/") || lower.includes("x.com/")) {
      const handle = extractHandle(
        url,
        /(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i,
      );
      if (handle && !result.twitter) {
        result.twitter = handle;
      }
      continue;
    }

    // Email (mailto: или видимый адрес)
    if (lower.startsWith("mailto:")) {
      const email = url.replace(/^mailto:/i, "").split("?")[0];
      if (email && !result.email) {
        result.email = email;
      }
      continue;
    }

    // Email-паттерн в URL
    const emailMatch = url.match(/[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      if (!result.email) result.email = emailMatch[0];
      continue;
    }

    // Пропускаем ссылки на YouTube/Google
    if (
      lower.includes("youtube.com") ||
      lower.includes("youtu.be") ||
      lower.includes("google.com")
    ) {
      continue;
    }

    // Всё остальное — website или otherLinks
    if (!result.website) {
      result.website = url;
    } else {
      result.otherLinks.push({ title, url });
    }
  }

  return result;
}

/**
 * Извлекает хендл из URL по regex.
 */
function extractHandle(url, regex) {
  const m = url.match(regex);
  if (!m || !m[1]) return null;
  const handle = m[1];
  // Фильтруем служебные пути
  const skip = [
    "explore",
    "home",
    "about",
    "intent",
    "share",
    "hashtag",
    "settings",
    "p",
    "reel",
    "stories",
  ];
  if (skip.includes(handle.toLowerCase())) return null;
  return handle;
}

module.exports = {
  fetchChannelAbout,
  extractContactsFromLinks,
  decodeRedirectUrl,
};
