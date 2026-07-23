const DISCORD_API_BASE = "https://discord.com/api";
const DEFAULT_BASE_URL = "https://gamelist.shabiimitjans.workers.dev";
const STATUS_CACHE_URL = "https://gamelist-discord-widget.local/status";
const FALLBACK_SYNC_DATA = {
  games: [
    {
      title: "Baldur's Gate III",
      platform: "PS5",
      section: "backlog",
      playing: true,
      startedAt: "2026-07-01",
      cover: "https://images.igdb.com/igdb/image/upload/t_cover_big/co670h.jpg",
    },
    {
      title: "Digimon Story: Time Stranger",
      platform: "Switch 2",
      section: "backlog",
      playing: true,
      startedAt: "2026-07-11",
      cover: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/coakzr.jpg",
    },
    {
      title: "Hi-Fi Rush",
      platform: "PS5",
      section: "backlog",
      playing: true,
      startedAt: "2026-07-21",
      cover: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co6219.jpg",
    },
  ],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      return authPage(env);
    }

    if (url.pathname === "/auth/redirect") {
      return authRedirectPage();
    }

    if (url.pathname === "/guide" || url.pathname === "/discord-widget-guide.html") {
      return env.ASSETS.fetch(assetRequest(request, "/discord-widget-guide.html"));
    }

    if (url.pathname === "/refresh") {
      if (!isAuthorizedRefresh(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      const result = await runAndRecordUpdate(env, "manual");
      return jsonResponse(result, result.ok ? 200 : 500);
    }

    if (url.pathname === "/widget-data") {
      if (!isAuthorizedRefresh(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      try {
        return jsonResponse(await buildWidgetData(env));
      } catch (error) {
        console.error(error);
        return jsonResponse(errorPayload(error), 500);
      }
    }

    if (url.pathname === "/health") {
      if (!isAuthorizedRefresh(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      return jsonResponse(await healthCheck(env));
    }

    if (url.pathname === "/status") {
      return jsonResponse(await readUpdateStatus());
    }

    return homePage();
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runAndRecordUpdate(env, "scheduled"));
  },
};

async function runAndRecordUpdate(env, source) {
  try {
    const result = await updateDiscordWidget(env, source);
    const status = { ok: true, ...result };
    await writeUpdateStatus(status);
    return status;
  } catch (error) {
    console.error(error);
    const status = {
      ...errorPayload(error),
      source,
      updatedAt: new Date().toISOString(),
    };
    await writeUpdateStatus(status);
    return status;
  }
}

async function updateDiscordWidget(env, source) {
  assertRequiredEnv(env, ["DISCORD_BOT_TOKEN", "DISCORD_USER_ID", "DISCORD_APP_ID"]);

  const widgetData = await buildWidgetData(env);
  await patchDiscordIdentity(env, widgetData);

  const dynamic = widgetData.data.dynamic || [];
  const field = (name) => dynamic.find((entry) => entry.name === name)?.value;

  return {
    source,
    updatedAt: new Date().toISOString(),
    username: widgetData.username,
    currentGame: field("game_subtitle_1") || field("game_subtitle_1_trophies") || "",
    completedGames: field("completed_games") || 0,
  };
}

async function patchDiscordIdentity(env, widgetData) {
  const path = `/v9/applications/${discordAppId(env)}/users/${cleanEnv(env.DISCORD_USER_ID)}/identities/0/profile`;

  try {
    return await discordJson(env, "PATCH", path, widgetData);
  } catch (error) {
    const canUseBearer = cleanEnv(env.DISCORD_ACCESS_TOKEN)
      && (String(error.message || "").includes("50025") || /Invalid OAuth2 access token/i.test(error.body || ""));

    if (!canUseBearer) throw error;

    console.warn("Bot-token identity update failed with OAuth token error. Trying DISCORD_ACCESS_TOKEN fallback.");
    return discordJson(env, "PATCH", path, widgetData, { accessToken: env.DISCORD_ACCESS_TOKEN });
  }
}

async function buildWidgetData(env) {
  const [lists, finished, achievementCompletions, shelf, sync, activity] = await Promise.all([
    maybeGetJson(env, "/api/gamelist-games-by-list"),
    maybeGetJson(env, "/api/completed-games-by-year"),
    waitForAchievementCompletions(env),
    maybeGetJson(env, "/api/shelf-games-platforms"),
    maybeGetJson(env, "/api/sync"),
    maybeGetJson(env, "/api/achievements"),
  ]);

  const syncData = sync || FALLBACK_SYNC_DATA;
  const providerCompletions = await providerCompletionSummary(env, syncData, achievementCompletions, activity);
  const playing = playingGames(syncData);
  const selectedGames = rotatePlayingGames(playing, 3);
  const coverGame = selectedGames.find((game) => game?.cover) || null;
  const trophyRows = sync ? await Promise.all(selectedGames.map((game) => trophyProgressForGame(env, game, activity || {}))) : [];
  const displayRows = [0, 1, 2].map((index) => gameDisplayRow(selectedGames[index], trophyRows[index]));
  if (playing.length > 3) displayRows[2] = withAndMore(displayRows[2]);
  const subtitles = displayRows.map((row) => row.subtitle);
  const subtitleTrophies = displayRows.map((row) => row.trophies);
  const subtitleIcons = [0, 1, 2].map((index) => platformIconUrl(env, selectedGames[index]?.platform));

  return {
    data: {
      dynamic: [
        imageField(env, "game_cover_image", squareCoverUrl(env, coverGame?.cover || latestCompletedCover(finished, syncData) || fallbackImage(env))),
        textField("game_title", "Currently Playing"),
        imageField(env, "platform_icon_image", subtitleIcons[0]),
        imageField(env, "game_subtitle_1_image", subtitleIcons[0]),
        textField("game_subtitle_1", subtitles[0]),
        textField("game_subtitle_1_trophies", subtitleTrophies[0]),
        imageField(env, "game_subtitle_2_image", subtitleIcons[1]),
        textField("game_subtitle_2", subtitles[1]),
        textField("game_subtitle_2_trophies", subtitleTrophies[1]),
        imageField(env, "game_subtitle_3_image", subtitleIcons[2]),
        textField("game_subtitle_3", subtitles[2]),
        textField("game_subtitle_3_trophies", subtitleTrophies[2]),
        textField("total_completed_count", achievementCompletionSummary(env, providerCompletions)),
        imageField(env, "total_completed_count_image", statImages(env).completed),
        textField("finished_this_year", finishedThisYear(finished, syncData)),
        imageField(env, "finished_image", statImages(env).finished),
        textField("backlog_games", backlogCount(lists, syncData)),
        imageField(env, "backlog_image", statImages(env).backlog),
        textField("shelf_games", shelfCount(shelf, syncData)),
        imageField(env, "shelf_image", statImages(env).shelf),
        numberField("completed_games", achievementCompletionCount(env, providerCompletions)),
        textField("rotation_note", sync ? (playing.length > 1 ? `Randomized from ${playing.length} games on each update` : "") : "Using fallback data"),
      ],
    },
    username: cleanEnv(env.DISCORD_WIDGET_USERNAME) || "Shabii",
  };
}

async function getJson(env, path) {
  const targetUrl = `${baseUrl(env)}${path}`;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchGamelist(env, path);
    if (response.ok) return response.json();

    const text = await response.text().catch(() => "");
    const excerpt = text ? `: ${text.slice(0, 200)}` : "";
    lastError = new Error(`${targetUrl} returned ${response.status}${excerpt}`);

    if (attempt < 3) await sleep(attempt * 1000);
  }

  throw lastError;
}

async function maybeGetJson(env, path) {
  try {
    return await getJson(env, path);
  } catch {
    return null;
  }
}

async function healthCheck(env) {
  const paths = [
    "/api/gamelist-games-by-list",
    "/api/completed-games-by-year",
    "/api/achievement-completions-by-year",
    "/api/shelf-games-platforms",
    "/api/sync",
    "/api/achievements",
  ];

  const checks = await Promise.all(paths.map(async (path) => {
    const startedAt = Date.now();
    try {
      const response = await fetchGamelist(env, path);
      const body = response.ok ? "" : await response.text().catch(() => "");
      return {
        path,
        ok: response.ok,
        status: response.status,
        fetchMode: env.GAMELIST ? "service-binding" : "global-fetch",
        body: body.slice(0, 200),
        ms: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        path,
        ok: false,
        error: error?.message || "Request failed",
        ms: Date.now() - startedAt,
      };
    }
  }));

  return {
    ok: checks.every((check) => check.ok),
    baseUrl: baseUrl(env),
    fetchMode: env.GAMELIST ? "service-binding" : "global-fetch",
    checks,
    checkedAt: new Date().toISOString(),
  };
}

async function waitForAchievementCompletions(env) {
  let best = null;
  const requiredSources = new Set(["psn", "steam", "xbox"]);

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const data = await maybeGetJson(env, "/api/achievement-completions-by-year");
    if (data) {
      if (!best || achievementCompletionCount(env, data) >= achievementCompletionCount(env, best)) {
        best = data;
      }

      const hasRequiredSources = [...requiredSources].every((source) => sourceHasCompletionData(data, source));
      const hasNoErrors = !Array.isArray(data.errors) || data.errors.length === 0;

      if (hasRequiredSources && hasNoErrors && attempt >= 3) return best;
    }

    if (attempt < 8) await sleep(2000);
  }

  return best;
}

function fetchGamelist(env, path) {
  const request = new Request(`${baseUrl(env)}${path}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "gamelist-discord-widget/1.0",
    },
  });

  return env.GAMELIST ? env.GAMELIST.fetch(request) : fetch(request);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceHasCompletionData(data, source) {
  const platform = (data?.platforms || []).find((item) => String(item.source || "").toLowerCase() === source);
  if (!platform) return false;
  return Number(platform.totalCompletedGames || 0) > 0
    || (platform.completedGames || []).length > 0
    || (platform.completedGamesByYear || []).length > 0;
}

function playingGames(syncData) {
  return activeGames(syncData)
    .filter((game) => game.playing)
    .sort((a, b) => startedSortValue(a) - startedSortValue(b) || String(a.title || "").localeCompare(String(b.title || "")));
}

function activeGames(syncData) {
  return (syncData?.games || []).filter((game) => !game.deletedAt);
}

function randomGames(games, count = games.length) {
  return [...games]
    .map((game) => ({ game, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .slice(0, count)
    .map(({ game }) => game);
}

function rotatePlayingGames(games, count) {
  const candidates = games.filter((game) => game.cover);
  const firstGame = randomGames(candidates.length ? candidates : games, 1)[0];
  if (!firstGame) return [];
  const firstKey = coverKey(firstGame);
  const rest = games.filter((game) => coverKey(game) !== firstKey);
  return [firstGame, ...randomGames(rest, count - 1)].slice(0, count);
}

function coverKey(game) {
  return [game?.id, game?.title, game?.platform, game?.cover].filter(Boolean).join("|");
}

function startedSortValue(game) {
  return game.startedAt ? new Date(`${game.startedAt}T00:00:00Z`).getTime() : Number.POSITIVE_INFINITY;
}

function backlogCount(listsData, syncData) {
  const listCount = (listsData?.lists || []).find((item) => item.list === "backlog")?.count;
  if (Number.isFinite(Number(listCount))) return Number(listCount);
  return activeGames(syncData).filter((game) => game.section === "backlog").length;
}

function shelfCount(shelfData, syncData) {
  const shelfTotal = Number(shelfData?.totalGames || 0);
  if (shelfTotal) return shelfTotal;
  return Array.isArray(syncData?.games) ? syncData.games.filter((game) => !game.deletedAt).length : 0;
}

async function providerCompletionSummary(env, syncData, summaryData, psnActivity) {
  const settings = syncData?.settings || {};
  const [psn, steam, xbox] = await Promise.all([
    psnCompletionData(env, settings, psnActivity),
    steamCompletionData(env, settings),
    xboxCompletionData(env, settings),
  ]);

  const summaryPlatforms = (summaryData?.platforms || [])
    .filter((platform) => ["psn", "steam", "xbox"].includes(String(platform.source || "").toLowerCase()));
  const directBySource = new Map([psn, steam, xbox].map((platform) => [platform.source, platform]));
  const platforms = ["psn", "steam", "xbox"].map((source) => {
    const direct = directBySource.get(source);
    const summary = summaryPlatforms.find((platform) => String(platform.source || "").toLowerCase() === source);
    return Number(direct.totalCompletedGames || 0) || !summary ? direct : normalizeCompletionPlatform(summary, source);
  });

  const completedGamesByYear = countByYear(platforms.flatMap((platform) => platform.completedGames || []));
  return {
    source: "provider-completions",
    platforms,
    providerTotals: Object.fromEntries(platforms.map((platform) => [platform.source, platform.totalCompletedGames])),
    completedGames: platforms.flatMap((platform) => platform.completedGames || []),
    completedGamesByYear,
    totalCompletedGames: platforms.reduce((sum, platform) => sum + Number(platform.totalCompletedGames || 0), 0),
  };
}

async function psnCompletionData(env, settings, existingData) {
  const user = cleanEnv(settings.psnUser);
  const data = existingData || await maybeGetJson(env, `/api/achievements?${new URLSearchParams({ schema: "3", user })}`);
  const completedGames = (data?.platinums || []).map((item) => ({
    title: item.title || item.game || "",
    rawEarnedAt: item.rawEarnedAt || item.earnedAt || "",
    source: "psn",
  }));
  return {
    source: "psn",
    platform: "PlayStation",
    completedGames,
    completedGamesByYear: countByYear(completedGames),
    totalCompletedGames: completedGames.length,
  };
}

async function steamCompletionData(env, settings) {
  const user = cleanEnv(settings.steamUser);
  if (!user) return emptyCompletionPlatform("steam", "Steam");

  const completedGames = [];
  let cursor = 0;
  for (let page = 0; page < 20 && cursor !== null; page += 1) {
    const params = new URLSearchParams({ activity: "1", limit: "20", debug: "1", user, cursor: String(cursor) });
    const data = await maybeGetJson(env, `/api/steam-achievements?${params}`);
    if (!data || data.needsSetup || data.authError || data.error) break;

    for (const game of data.games || []) {
      if (isCompletedAchievementGame(game)) {
        completedGames.push({
          title: game.name || game.title || "",
          rawEarnedAt: latestEarnedAt(game.achievements || []),
          source: "steam",
        });
      }
    }

    cursor = data.nextCursor !== null && Number.isFinite(Number(data.nextCursor)) ? Number(data.nextCursor) : null;
  }

  return {
    source: "steam",
    platform: "Steam",
    completedGames,
    completedGamesByYear: countByYear(completedGames),
    totalCompletedGames: completedGames.length,
  };
}

async function xboxCompletionData(env, settings) {
  const user = cleanEnv(settings.microsoftUser);
  const params = new URLSearchParams({ schema: "2" });
  if (user) params.set("user", user);
  const data = await maybeGetJson(env, `/api/xbox-achievements?${params}`);
  const completedGames = [
    ...(data?.completed || []),
    ...(data?.games || []).filter((game) => Number(game.total || 0) > 0 && Number(game.earned || 0) >= Number(game.total || 0)),
  ].map((item) => ({
    title: item.title || item.name || "",
    rawEarnedAt: item.rawEarnedAt || item.earnedAt || "",
    source: "xbox",
  }));
  return {
    source: "xbox",
    platform: "Xbox",
    completedGames,
    completedGamesByYear: countByYear(completedGames),
    totalCompletedGames: completedGames.length,
  };
}

function normalizeCompletionPlatform(platform, source) {
  const completedGames = (platform.completedGames || []).map((item) => ({ ...item, source }));
  return {
    source,
    platform: platform.platform || source,
    completedGames,
    completedGamesByYear: platform.completedGamesByYear || countByYear(completedGames),
    totalCompletedGames: Number(platform.totalCompletedGames || completedGames.length || 0),
  };
}

function emptyCompletionPlatform(source, platform) {
  return { source, platform, completedGames: [], completedGamesByYear: [], totalCompletedGames: 0 };
}

function isCompletedAchievementGame(game) {
  const achievements = game?.achievements || [];
  return achievements.length > 0 && achievements.every((achievement) => achievement.earned);
}

function latestEarnedAt(achievements) {
  return achievements
    .map((achievement) => achievement.rawEarnedAt || achievement.earnedAt || "")
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function countByYear(items) {
  const counts = new Map();
  for (const item of items) {
    const year = completionYear(item.rawEarnedAt || item.earnedAt);
    if (!year) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .map(([year, count]) => ({ year, count }));
}

function completionYear(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})/);
  if (iso) return iso[1];
  const time = Date.parse(raw);
  return Number.isFinite(time) ? String(new Date(time).getUTCFullYear()) : "";
}

function achievementCompletionCount(env, completionsData) {
  const apiTotal = Number(completionsData?.totalCompletedGames || 0)
    || (Array.isArray(completionsData?.completedGames) ? completionsData.completedGames.length : 0)
    || (completionsData?.platforms || []).reduce((sum, platform) => sum + Number(platform.totalCompletedGames || 0), 0);
  return apiTotal;
}

function achievementCompletionsThisYear(env, completionsData) {
  const year = String(new Date().getFullYear());
  const apiTotal = (completionsData?.completedGamesByYear || []).find((item) => item.year === year)?.count;
  if (Number.isFinite(Number(apiTotal))) return Number(apiTotal);
  return (completionsData?.platforms || []).reduce((sum, platform) => {
    const count = (platform.completedGamesByYear || []).find((item) => item.year === year)?.count;
    return sum + Number(count || 0);
  }, 0);
}

function achievementCompletionSummary(env, completionsData) {
  return `${achievementCompletionCount(env, completionsData)} (${achievementCompletionsThisYear(env, completionsData)} this year)`;
}

async function readUpdateStatus() {
  const fallback = {
    ok: null,
    source: "",
    updatedAt: "",
    error: "",
    nextScheduledAt: nextScheduledUpdateIso(),
  };
  try {
    const response = await caches.default.match(statusCacheRequest());
    if (!response) return fallback;
    return { ...fallback, ...(await response.json()), nextScheduledAt: nextScheduledUpdateIso() };
  } catch {
    return fallback;
  }
}

async function writeUpdateStatus(status) {
  try {
    await caches.default.put(statusCacheRequest(), new Response(JSON.stringify({
      ...status,
      nextScheduledAt: nextScheduledUpdateIso(),
    }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=604800",
      },
    }));
  } catch {
    // Status is best-effort; widget updates should not fail if cache writes do.
  }
}

function statusCacheRequest() {
  return new Request(STATUS_CACHE_URL);
}

function nextScheduledUpdateIso(now = new Date()) {
  const next = new Date(now);
  const minutes = next.getUTCMinutes();
  next.setUTCSeconds(0, 0);
  if (minutes < 30) {
    next.setUTCMinutes(30);
  } else {
    next.setUTCHours(next.getUTCHours() + 1, 0);
  }
  return next.toISOString();
}

function finishedThisYear(completedData, syncData) {
  const year = String(new Date().getFullYear());
  const apiCount = (completedData?.years || []).find((item) => item.year === year)?.count;
  if (Number.isFinite(Number(apiCount))) return Number(apiCount);
  return activeGames(syncData).filter((game) => String(game.completedAt || "").startsWith(year)).length;
}

function latestCompletedCover(completedData, syncData) {
  const apiCover = (completedData?.years || [])
    .flatMap((year) => year.games || [])
    .find((game) => game.cover)?.cover || "";
  if (apiCover) return apiCover;
  return activeGames(syncData)
    .filter((game) => game.completedAt && game.cover)
    .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))
    .find((game) => game.cover)?.cover || "";
}

function platformIconUrl(env, platform) {
  const value = String(platform || "").toLowerCase();
  const images = platformImages(env);
  if (hasPlatform(value, "steam", "pc", "windows")) return images.steam;
  if (hasPlatform(value, "switch")) return images.switch;
  if (hasPlatform(value, "wii u", "wiiu")) return images.wiiu;
  if (hasPlatform(value, "wii")) return images.wii;
  if (hasPlatform(value, "gamecube", "game cube")) return images.gamecube;
  if (hasPlatform(value, "n64", "nintendo 64")) return images.n64;
  if (hasPlatform(value, "snes", "super nintendo")) return images.snes;
  if (hasPlatform(value, "nes", "nintendo entertainment")) return images.nes;
  if (hasPlatform(value, "3ds")) return images.threeDs;
  if (hasPlatform(value, "ds")) return images.ds;
  if (hasPlatform(value, "gba", "game boy advance")) return images.gba;
  if (hasPlatform(value, "gbc", "game boy color")) return images.gbc;
  if (hasPlatform(value, "game boy", "gameboy", "gb")) return images.gb;
  if (hasPlatform(value, "game gear")) return images.gamegear;
  if (hasPlatform(value, "dreamcast")) return images.dreamcast;
  if (hasPlatform(value, "genesis", "mega drive", "sega")) return images.sega;
  if (hasPlatform(value, "xbox 360", "x360")) return images.xbox360;
  if (hasPlatform(value, "original xbox", "classic xbox")) return images.xboxRetro;
  if (hasPlatform(value, "xbox")) return images.xbox;
  if (hasPlatform(value, "ps5", "playstation 5", "ps1", "ps2", "ps3", "ps4", "playstation", "psp", "vita")) return images.playstation;
  return fallbackImage(env);
}

function hasPlatform(value, ...needles) {
  return needles.some((needle) => value.includes(needle));
}

function gameDisplayRow(game, trophyRow = {}) {
  if (!game) return { subtitle: " ", trophies: " " };
  const endpointTitle = String(trophyRow.title || "").trim();
  if (trophyRow.progress) {
    return {
      subtitle: endpointTitle || game.title || " ",
      trophies: trophyRow.progress,
    };
  }
  return {
    subtitle: "",
    trophies: endpointTitle || game.title || " ",
  };
}

function withAndMore(row) {
  if (!row) return { subtitle: " ", trophies: "AND MORE" };
  const next = { ...row };
  const target = next.trophies && next.trophies.trim() ? "trophies" : "subtitle";
  next[target] = appendAndMore(next[target]);
  return next;
}

function appendAndMore(value) {
  const text = String(value || "").trim();
  return text ? `${text} AND MORE` : "AND MORE";
}

async function trophyProgressForGame(env, game, activityData) {
  if (!game) return { progress: "", title: "" };
  const direct = await directTrophyProgress(env, game);
  if (direct.progress) return direct;
  const fallbackProgress = activityTrophyProgress(game, activityData);
  return {
    progress: fallbackProgress,
    title: fallbackProgress ? "" : direct.title,
  };
}

async function directTrophyProgress(env, game) {
  const psnId = String(game.npCommunicationId || "").trim();
  if (psnId) {
    const params = new URLSearchParams({ id: psnId });
    if (game.npServiceName) params.set("service", game.npServiceName);
    return progressFromPayload(await maybeGetJson(env, `/api/trophies?${params}`), "trophies");
  }

  const steamAppId = cleanSteamAppId(game.steamAppId) || steamAppIdFromUrl(game.storeLinks?.steam);
  if (steamAppId) {
    return progressFromPayload(await maybeGetJson(env, `/api/steam-achievements?${new URLSearchParams({ appId: steamAppId })}`), "achievements");
  }

  const titleId = String(game.titleId || "").replace(/\D/g, "").slice(0, 20);
  if (titleId) {
    return progressFromPayload(await maybeGetJson(env, `/api/xbox-achievements?${new URLSearchParams({ titleId })}`), "achievements");
  }

  return { progress: "", title: "" };
}

function progressFromPayload(data, itemKey) {
  if (!data) return { progress: "", title: "" };
  const items = Array.isArray(data[itemKey]) ? data[itemKey] : [];
  const total = Number(data.count || items.length || 0);
  const earned = Number.isFinite(Number(data.earnedCount))
    ? Number(data.earnedCount)
    : items.filter((item) => item.earned).length;
  return {
    progress: total ? trophyCountText(earned, total) : "",
    title: endpointGameTitle(data),
  };
}

function activityTrophyProgress(game, activityData) {
  const match = (activityData.games || []).find((item) => titleMatch(game.trophyName || game.title, item.title));
  const progress = String(match?.game || "").match(/(\d+)\s*\/\s*(\d+)\s*(?:trophies|achievements)?/i);
  return progress ? trophyCountText(progress[1], progress[2]) : "";
}

function trophyCountText(earned, total) {
  return `${earned}/${total} trophies\u2800`;
}

function endpointGameTitle(data) {
  return String(data?.title || data?.name || data?.trophyTitleName || data?.gameName || "").trim();
}

function titleMatch(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\biii\b/g, "3")
    .replace(/\bii\b/g, "2")
    .replace(/\biv\b/g, "4")
    .replace(/\bvi\b/g, "6")
    .replace(/\bv\b/g, "5")
    .replace(/\bix\b/g, "9")
    .replace(/\bviii\b/g, "8")
    .replace(/\bvii\b/g, "7")
    .replace(/\bx\b/g, "10")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanSteamAppId(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 12);
}

function steamAppIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/store\.steampowered\.com$/i.test(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const appIndex = parts.indexOf("app");
    return cleanSteamAppId(appIndex >= 0 ? parts[appIndex + 1] : "");
  } catch {
    return "";
  }
}

function textField(name, value) {
  return { name, type: 1, value: String(value || "").slice(0, 120) };
}

function numberField(name, value) {
  return { name, type: 2, value: Number(value || 0) };
}

function imageField(env, name, url) {
  return { name, type: 3, value: { url: absoluteImageUrl(env, url) || fallbackImage(env) } };
}

function squareCoverUrl(env, value) {
  const source = absoluteImageUrl(env, value);
  if (!source) return fallbackImage(env);
  return `${baseUrl(env)}/api/cover?${new URLSearchParams({ width: "152", height: "152", fit: "cover", src: source })}`;
}

function absoluteImageUrl(env, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl(env)).toString();
  } catch {
    return "";
  }
}

async function discordJson(env, method, path, body, options = {}) {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: options.accessToken ? `Bearer ${cleanEnv(options.accessToken)}` : `Bot ${cleanEnv(env.DISCORD_BOT_TOKEN)}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!response.ok) {
    const error = new Error(`Discord API ${method} ${path} failed (${response.status})`);
    error.status = response.status;
    error.body = typeof data === "string" ? data : JSON.stringify(data);
    throw error;
  }
  return data;
}

function assertRequiredEnv(env, names) {
  const missing = names.filter((name) => !cleanEnv(env[name]));
  if (missing.length) {
    throw new Error(`Missing required environment value(s): ${missing.join(", ")}`);
  }
}

function isAuthorizedRefresh(request, env) {
  const expected = cleanEnv(env.REFRESH_SECRET);
  if (!expected) return false;

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret") || "";
  const bearerSecret = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

  return constantTimeEqual(querySecret, expected) || constantTimeEqual(bearerSecret, expected);
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.length !== b.length) return false;

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return new Request(url, request);
}

function homePage() {
  return htmlResponse(pageShell("Gamelist Discord Widget", `
    <main>
      <h1>Gamelist Discord Widget</h1>
      <p>Save your refresh secret locally, then use the buttons below. The secret is stored only in this browser.</p>

      <label for="secret">Refresh secret</label>
      <input id="secret" type="password" autocomplete="current-password" placeholder="YOUR_REFRESH_SECRET">

      <div class="actions two">
        <button id="save-secret" type="button">Save secret</button>
        <button id="clear-secret" class="secondary" type="button">Clear</button>
      </div>

      <div class="actions">
        <a class="button" href="/auth">Discord auth</a>
        <a class="button" href="/guide">Setup guide</a>
        <a class="button protected" data-path="/health" href="/health?secret=YOUR_REFRESH_SECRET">Health check</a>
        <a class="button protected" data-path="/refresh" href="/refresh?secret=YOUR_REFRESH_SECRET">Refresh Discord</a>
        <a class="button protected" data-path="/widget-data" href="/widget-data?secret=YOUR_REFRESH_SECRET">Preview widget data</a>
      </div>

      <section class="status-panel">
        <div>
          <span>Last update</span>
          <strong id="last-updated">Never</strong>
        </div>
        <div>
          <span>Type</span>
          <strong id="last-source">-</strong>
        </div>
        <div>
          <span>Next update</span>
          <strong id="next-countdown">-</strong>
        </div>
        <div>
          <span>Result</span>
          <strong id="last-result">Unknown</strong>
        </div>
      </section>

      <p id="status" class="note"></p>
    </main>
    <script>
      const storageKey = "gamelist-discord-widget-refresh-secret";
      const input = document.getElementById("secret");
      const status = document.getElementById("status");
      const protectedLinks = [...document.querySelectorAll(".protected")];
      let nextUpdateAt = "";

      function updateLinks() {
        const secret = input.value.trim();
        protectedLinks.forEach((link) => {
          const path = link.dataset.path;
          link.href = secret ? path + "?secret=" + encodeURIComponent(secret) : path + "?secret=YOUR_REFRESH_SECRET";
        });
      }

      input.value = localStorage.getItem(storageKey) || "";
      updateLinks();

      input.addEventListener("input", updateLinks);
      document.getElementById("save-secret").addEventListener("click", () => {
        localStorage.setItem(storageKey, input.value.trim());
        updateLinks();
        status.textContent = "Secret saved locally.";
      });
      document.getElementById("clear-secret").addEventListener("click", () => {
        localStorage.removeItem(storageKey);
        input.value = "";
        updateLinks();
        status.textContent = "Secret cleared.";
      });

      function madridTime(value) {
        if (!value) return "Never";
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Madrid",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value));
      }

      function updateCountdown() {
        const target = nextUpdateAt ? new Date(nextUpdateAt).getTime() : 0;
        const remaining = Math.max(0, target - Date.now());
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        document.getElementById("next-countdown").textContent = target
          ? String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
          : "-";
      }

      async function loadStatus() {
        try {
          const response = await fetch("/status", { cache: "no-store" });
          const data = await response.json();
          nextUpdateAt = data.nextScheduledAt || "";
          document.getElementById("last-updated").textContent = madridTime(data.updatedAt);
          document.getElementById("last-source").textContent = data.source || "-";
          const result = document.getElementById("last-result");
          result.textContent = data.ok === true ? "Success" : data.ok === false ? "Failed" : "Unknown";
          result.className = data.ok === true ? "success" : data.ok === false ? "failed" : "";
          if (data.ok === false && data.error) status.textContent = "Last failure: " + data.error;
          updateCountdown();
        } catch {
          status.textContent = "Could not load update status.";
        }
      }

      loadStatus();
      setInterval(updateCountdown, 1000);
    </script>
  `));
}

function authPage(env) {
  const appId = discordAppId(env);
  if (!appId) {
    return htmlResponse(pageShell("Discord Auth", `
      <main>
        <h1>Missing Discord App ID</h1>
        <p>Set <code>DISCORD_APP_ID</code> as a Worker secret, redeploy, then open this page again.</p>
      </main>
    `), 500);
  }

  const links = authUrls(appId).map((url, index) => `
    <a class="button" href="${escapeHtml(url)}">Authorize option ${index + 1}</a>
  `).join("");

  return htmlResponse(pageShell("Discord Auth", `
    <main>
      <h1>Discord Auth</h1>
      <p>Open these while logged into the Discord account from <code>DISCORD_USER_ID</code>. Start with option 1.</p>
      <div class="actions">${links}</div>
      <p class="note">If Discord redirects with an <code>access_token</code> in the URL, copy it and save it as the <code>DISCORD_ACCESS_TOKEN</code> Worker secret.</p>
    </main>
  `));
}

function authRedirectPage() {
  return htmlResponse(pageShell("Discord Auth Redirect", `
    <main>
      <h1>Discord Auth Result</h1>
      <p>If Discord returned an access token, it will appear below.</p>
      <label for="token">Access token</label>
      <textarea id="token" readonly></textarea>
      <button id="copy" type="button">Copy token</button>
      <p class="note">Then run <code>wrangler secret put DISCORD_ACCESS_TOKEN</code>, paste the token, deploy again, and trigger <code>/refresh</code>.</p>
    </main>
    <script>
      const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
      const token = params.get("access_token") || "";
      const textarea = document.getElementById("token");
      textarea.value = token || "No access_token found in the redirect URL.";
      document.getElementById("copy").addEventListener("click", async () => {
        if (!token) return;
        await navigator.clipboard.writeText(token);
        document.getElementById("copy").textContent = "Copied";
      });
    </script>
  `));
}

function authUrls(appId) {
  const common = new URLSearchParams({
    client_id: appId,
    response_type: "token",
    prompt: "consent",
  });

  return [
    ["sdk.social_layer_presence", common],
    ["openid sdk.social_layer_presence", common],
    ["openid sdk.social_layer", common],
  ].map(([scope, params]) => {
    const next = new URLSearchParams(params);
    next.set("scope", scope);
    return `https://discord.com/oauth2/authorize?${next}`;
  });
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #161619;
      --panel: rgba(20, 22, 28, 0.58);
      --panel-strong: rgba(28, 31, 40, 0.82);
      --line: rgba(255, 255, 255, 0.13);
      --text: #f6f7fb;
      --muted: #a6adbd;
      --dim: #6f7789;
      --accent: #ff0039;
      --accent-1: #79f2ce;
      --danger: #ff6f85;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.48);
      --glow-primary: rgba(255, 0, 81, 0.22);
      --glow-secondary: rgba(0, 0, 255, 0.14);
      --grid-texture:
        linear-gradient(rgba(255, 255, 255, 0.016) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.014) 1px, transparent 1px);
      font-family: "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: var(--bg);
      color: var(--text);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 78% 9%, var(--glow-primary), transparent 30rem),
        radial-gradient(circle at 11% 84%, var(--glow-secondary), transparent 34rem),
        linear-gradient(120deg, rgba(255, 255, 255, 0.04), transparent 38%),
        var(--grid-texture),
        var(--bg);
      background-size: auto, auto, auto, 24px 24px, 24px 24px, auto;
    }

    main {
      width: min(620px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: clamp(20px, 4vw, 32px);
      backdrop-filter: blur(18px);
    }

    h1 {
      margin: 0 0 12px;
      font-size: 32px;
      line-height: 1.1;
      letter-spacing: 0;
      color: var(--accent);
    }

    p {
      color: var(--muted);
      line-height: 1.55;
    }

    a { color: var(--accent-1); }

    code {
      color: var(--text);
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 5px;
      border-radius: 4px;
    }

    .actions {
      display: grid;
      gap: 10px;
      margin: 24px 0;
    }

    .button,
    button {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.07);
      color: var(--text);
      font: inherit;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }

    .button:hover,
    button:hover {
      border-color: color-mix(in srgb, var(--accent) 58%, transparent);
      background: color-mix(in srgb, var(--accent) 28%, transparent);
      box-shadow:
        0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent),
        0 10px 28px color-mix(in srgb, var(--accent) 12%, transparent);
      transform: translateY(-1px);
    }

    label {
      display: block;
      margin: 20px 0 8px;
      font-weight: 700;
    }

    input {
      box-sizing: border-box;
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(16, 17, 20, 0.72);
      color: var(--text);
      font: inherit;
    }

    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 150px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(16, 17, 20, 0.72);
      color: var(--text);
      font: 14px ui-monospace, SFMono-Regular, Consolas, monospace;
      resize: vertical;
    }

    .note {
      font-size: 14px;
      color: var(--muted);
    }

    .two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .secondary {
      background: rgba(255, 255, 255, 0.04);
    }

    .status-panel {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 20px 0 8px;
    }

    .status-panel div {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-strong);
      padding: 12px;
    }

    .status-panel span {
      display: block;
      margin-bottom: 6px;
      color: var(--dim);
      font-size: 12px;
      text-transform: uppercase;
    }

    .status-panel strong {
      display: block;
      overflow-wrap: anywhere;
      color: var(--text);
      font-size: 14px;
    }

    .success { color: var(--accent-1) !important; }
    .failed { color: var(--danger) !important; }

    @media (max-width: 560px) {
      body { padding: 16px; }
      .status-panel,
      .two { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorPayload(error) {
  return {
    ok: false,
    error: error?.message || "Unknown error",
    status: error?.status || 500,
    discordBody: error?.body,
  };
}

function cleanEnv(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function discordAppId(env) {
  return cleanEnv(env.DISCORD_APP_ID);
}

function baseUrl(env) {
  const raw = cleanEnv(env.GAMELIST_BASE_URL) || DEFAULT_BASE_URL;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function fallbackImage(env) {
  return `${baseUrl(env)}/assets/Icon.png`;
}

function statImages(env) {
  return {
    completed: `${baseUrl(env)}/assets/discord/completed_games.png`,
    finished: `${baseUrl(env)}/assets/discord/finished_games.png`,
    backlog: `${baseUrl(env)}/assets/app-Icon.png`,
    shelf: `${baseUrl(env)}/assets/discord/shelf.png`,
  };
}

function platformImages(env) {
  return {
    playstation: `${baseUrl(env)}/assets/platforms/playstation.png`,
    steam: `${baseUrl(env)}/assets/platforms/steam.png`,
    switch: `${baseUrl(env)}/assets/platforms/switch.png`,
    xbox: `${baseUrl(env)}/assets/platforms/xbox.png`,
    xbox360: `${baseUrl(env)}/assets/platforms/xbox360.png`,
    xboxRetro: `${baseUrl(env)}/assets/platforms/xbox_retro.png`,
    wii: `${baseUrl(env)}/assets/platforms/wii.png`,
    wiiu: `${baseUrl(env)}/assets/platforms/wiiu.png`,
    gamecube: `${baseUrl(env)}/assets/platforms/gc.png`,
    n64: `${baseUrl(env)}/assets/platforms/n64.png`,
    snes: `${baseUrl(env)}/assets/platforms/snes.png`,
    nes: `${baseUrl(env)}/assets/platforms/nes.png`,
    ds: `${baseUrl(env)}/assets/platforms/nds.png`,
    threeDs: `${baseUrl(env)}/assets/platforms/3ds.png`,
    gba: `${baseUrl(env)}/assets/platforms/gba.png`,
    gbc: `${baseUrl(env)}/assets/platforms/gbc.png`,
    gb: `${baseUrl(env)}/assets/platforms/gb.png`,
    gamegear: `${baseUrl(env)}/assets/platforms/gamegear.png`,
    dreamcast: `${baseUrl(env)}/assets/platforms/dreamcast.png`,
    sega: `${baseUrl(env)}/assets/platforms/sega.png`,
  };
}
