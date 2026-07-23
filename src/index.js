const DISCORD_API_BASE = "https://discord.com/api";
const DEFAULT_BASE_URL = "https://gamelist.shabiimitjans.workers.dev";
const FALLBACK_TOTAL_COMPLETED_COUNT = 41;
const FALLBACK_TOTAL_COMPLETED_THIS_YEAR = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/refresh") {
      if (!isAuthorizedRefresh(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      try {
        const result = await updateDiscordWidget(env, "manual");
        return jsonResponse({ ok: true, ...result });
      } catch (error) {
        console.error(error);
        return jsonResponse(errorPayload(error), 500);
      }
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

    return jsonResponse({
      ok: true,
      name: "gamelist-discord-widget",
      endpoints: ["/refresh", "/widget-data"],
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(updateDiscordWidget(env, "scheduled"));
  },
};

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
  const path = `/v9/applications/${cleanEnv(env.DISCORD_APP_ID)}/users/${cleanEnv(env.DISCORD_USER_ID)}/identities/0/profile`;

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
    getJson(env, "/api/gamelist-games-by-list"),
    getJson(env, "/api/completed-games-by-year"),
    maybeGetJson(env, "/api/achievement-completions-by-year"),
    getJson(env, "/api/shelf-games-platforms"),
    getJson(env, "/api/sync"),
    maybeGetJson(env, "/api/achievements"),
  ]);

  const playing = playingGames(sync);
  const coverGame = randomCoverGame(playing);
  const selectedGames = coverGame ? gamesStartingWith(playing, coverGame, 3) : randomGames(playing, 3);
  const trophyRows = await Promise.all(selectedGames.map((game) => trophyProgressForGame(env, game, activity || {})));
  const displayRows = [0, 1, 2].map((index) => gameDisplayRow(selectedGames[index], trophyRows[index]));
  const subtitles = displayRows.map((row) => row.subtitle);
  const subtitleTrophies = displayRows.map((row) => row.trophies);
  const subtitleIcons = [0, 1, 2].map((index) => platformIconUrl(env, selectedGames[index]?.platform));

  return {
    data: {
      dynamic: [
        imageField(env, "game_cover_image", squareCoverUrl(env, coverGame?.cover || latestCompletedCover(finished) || fallbackImage(env))),
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
        textField("total_completed_count", achievementCompletionSummary(env, achievementCompletions)),
        imageField(env, "total_completed_count_image", statImages(env).completed),
        textField("finished_this_year", finishedThisYear(finished)),
        imageField(env, "finished_image", statImages(env).finished),
        textField("backlog_games", backlogCount(lists)),
        imageField(env, "backlog_image", statImages(env).backlog),
        textField("shelf_games", Number(shelf.totalGames || 0)),
        imageField(env, "shelf_image", statImages(env).shelf),
        numberField("completed_games", achievementCompletionCount(env, achievementCompletions)),
        textField("rotation_note", playing.length > 1 ? `Randomized from ${playing.length} games on each update` : ""),
      ],
    },
    username: cleanEnv(env.DISCORD_WIDGET_USERNAME) || "Shabii",
  };
}

async function getJson(env, path) {
  const response = await fetch(`${baseUrl(env)}${path}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${baseUrl(env)}${path} returned ${response.status}`);
  return response.json();
}

async function maybeGetJson(env, path) {
  try {
    return await getJson(env, path);
  } catch {
    return null;
  }
}

function playingGames(syncData) {
  return (syncData.games || [])
    .filter((game) => !game.deletedAt && game.playing)
    .sort((a, b) => startedSortValue(a) - startedSortValue(b) || String(a.title || "").localeCompare(String(b.title || "")));
}

function randomGames(games, count = games.length) {
  return [...games]
    .map((game) => ({ game, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .slice(0, count)
    .map(({ game }) => game);
}

function gamesStartingWith(games, firstGame, count) {
  const firstKey = coverKey(firstGame);
  const rest = games.filter((game) => coverKey(game) !== firstKey);
  return [firstGame, ...randomGames(rest, count - 1)].slice(0, count);
}

function randomCoverGame(games) {
  const candidates = games.filter((game) => game.cover);
  return randomGames(candidates, 1)[0] || null;
}

function coverKey(game) {
  return [game?.id, game?.title, game?.platform, game?.cover].filter(Boolean).join("|");
}

function startedSortValue(game) {
  return game.startedAt ? new Date(`${game.startedAt}T00:00:00Z`).getTime() : Number.POSITIVE_INFINITY;
}

function backlogCount(listsData) {
  return (listsData.lists || []).find((item) => item.list === "backlog")?.count || 0;
}

function achievementCompletionCount(env, completionsData) {
  const override = numericOverride(env.TOTAL_COMPLETED_COUNT);
  if (override != null) return override;
  const apiTotal = Number(completionsData?.totalCompletedGames || 0)
    || (completionsData?.platforms || []).reduce((sum, platform) => sum + Number(platform.totalCompletedGames || 0), 0);
  return Math.max(apiTotal, FALLBACK_TOTAL_COMPLETED_COUNT);
}

function achievementCompletionsThisYear(env, completionsData) {
  const override = numericOverride(env.TOTAL_COMPLETED_THIS_YEAR);
  if (override != null) return override;
  const year = String(new Date().getFullYear());
  const apiTotal = (completionsData?.completedGamesByYear || []).find((item) => item.year === year)?.count || 0;
  return Math.max(apiTotal, FALLBACK_TOTAL_COMPLETED_THIS_YEAR);
}

function achievementCompletionSummary(env, completionsData) {
  return `${achievementCompletionCount(env, completionsData)} (${achievementCompletionsThisYear(env, completionsData)} this year)`;
}

function finishedThisYear(completedData) {
  const year = String(new Date().getFullYear());
  return (completedData.years || []).find((item) => item.year === year)?.count || 0;
}

function latestCompletedCover(completedData) {
  return (completedData.years || [])
    .flatMap((year) => year.games || [])
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

function numericOverride(value) {
  if (cleanEnv(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
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
