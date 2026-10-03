const $ = id => document.getElementById(id);
const views = ["languageView", "catalogView", "introView", "gameView", "endingView"];
const APP_ROOT = (() => {
  const script = document.currentScript;
  if (!script) return "/";
  const path = new URL(script.src, location.href).pathname;
  return path.endsWith("/app/app.js") ? path.slice(0, -"app/app.js".length) : "/";
})();

function rootUrl(path) {
  return new URL(path, new URL(APP_ROOT, location.href)).href;
}

let world = null;
let worldEntries = [];
let selectedWorldEntry = null;
let activeLevel = null;
let sceneIndex = 0;
let state = {};
let choiceLocked = false;
let soundEnabled = true;
let musicPath = "";
let shownMilestones = new Set();
const COLLECTION_KEY = "glimmers-collection-v1";
let lang = "en";                 // default language: English
let uiText = null;               // platform UI strings for the active language
const textOverrideCache = new Map();
let catalogSourcePromise = null;

function requestedLang() {
  const urlLang = new URLSearchParams(location.search).get("lang");
  return urlLang === "zh" || urlLang === "en" ? urlLang : null;
}

function setLang(next) {
  lang = next;
  localStorage.setItem("glimmers-lang", next);
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  if (uiText) {
    applyPlatformText();
    labelStaticDom();
  }
  document.querySelectorAll(".lang-button").forEach(b => {
    b.textContent = next.toUpperCase();
    b.title = next === "en" ? "Switch to Chinese" : "切换到英文";
  });
}

/* Deep-merge a translation over the original object. Arrays keep the original
   length; every missing key falls back to the Chinese source string. */
function mergeText(base, over) {
  if (!over) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(over)) return base;
    return base.map((item, i) => mergeText(item, over[i]));
  }
  if (base && typeof base === "object") {
    const out = { ...base };
    for (const key of Object.keys(base)) {
      if (key in over && over[key] !== undefined && over[key] !== null) out[key] = mergeText(base[key], over[key]);
    }
    return out;
  }
  return (typeof over === "string" && over.trim()) ? over : base;
}

async function loadTextOverride(baseFolder, name) {
  if (lang !== "en") return null;
  return prefetchTextOverride(baseFolder, name);
}

function textOverrideUrl(baseFolder, name) {
  return baseFolder.endsWith("i18n/") ? `${baseFolder}${name}` : `${baseFolder}i18n/${name}`;
}

function prefetchTextOverride(baseFolder, name) {
  const url = textOverrideUrl(baseFolder, name);
  if (!textOverrideCache.has(url)) {
    textOverrideCache.set(url, fetch(rootUrl(url), { cache: "no-store" })
      .then(res => res.ok ? res.json() : null)
      .catch(() => null));
  }
  return textOverrideCache.get(url);
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
}

function showView(id) {
  views.forEach(viewId => { $(viewId).hidden = viewId !== id; });
  document.body.classList.toggle("is-playing", id === "gameView");
  window.scrollTo(0, 0);
}

function maybeShuffleActions(actions) {
  if (!Array.isArray(actions) || actions.length < 2 || world?.shuffleActions === false) return actions;
  const shuffled = [...actions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const TEXT_BOOST_KEY = "glimmers-text-boost";

function applyTextBoost() {
  const on = localStorage.getItem(TEXT_BOOST_KEY) === "1";
  document.body.classList.toggle("text-boost", on);
  const button = document.getElementById("textToggle");
  if (button) {
    button.textContent = on ? "A－" : "A＋";
    button.setAttribute("aria-label", lang === "en" ? (on ? "Shrink text" : "Enlarge text") : (on ? "缩小文字" : "放大文字"));
    button.title = button.getAttribute("aria-label");
  }
}

function toggleTextBoost() {
  const on = localStorage.getItem(TEXT_BOOST_KEY) === "1";
  localStorage.setItem(TEXT_BOOST_KEY, on ? "0" : "1");
  applyTextBoost();
}

function updateSoundButtons() {
  [$('catalogSound'), $('soundToggle')].forEach(button => {
    button.setAttribute("aria-label", t("soundLabel"));
    button.textContent = soundEnabled ? "♫" : "×";
    button.classList.toggle("is-muted", !soundEnabled);
  });
  // Ending videos are visual rewards only. Keep their own audio disabled so
  // the selected world's background track remains continuous underneath.
  $("endingVideo").muted = true;
  const music = $("worldMusic");
  music.muted = !soundEnabled;
  if (soundEnabled && musicPath && music.paused) music.play().catch(() => {});
  if (!soundEnabled) music.pause();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  updateSoundButtons();
}

function installAudioUnlock() {
  const unlock = () => {
    updateSoundButtons();
    document.removeEventListener("click", unlock);
    document.removeEventListener("keydown", unlock);
  };
  // Browsers block audio that starts during the initial page load. The first
  // real click or keypress unlocks it; this avoids requiring a language toggle.
  document.addEventListener("click", unlock);
  document.addEventListener("keydown", unlock);
}

const STRINGS = {
  en: {
    quizHint: "Look at the picture and answer",
    quizQuestion: "What is this cat acting out?",
    quizDescription: "Watch the picture and guess what the cat is performing.",
    quizChapter: (n) => `Round ${n}`,
    quizCorrect: (text) => `Correct! The answer is: ${text}`,
    quizWrong: (text) => `Not this time - the answer is: ${text}`,
    quizVideoFail: "The cat is still rehearsing, try again",
    successTitle: (t) => `${t} · You got it`,
    successDesc: "You saw through most of the cat's performance. You know this little actor well.",
    failureTitle: (t) => `${t} · Guess again`,
    failureDesc: "The cat's performance still has a few mysteries left. Watch again next round.",
    chapterN: (n) => `Chapter ${n}`,
    sceneN: (n) => `Scene ${n}`,
    scoreLabel: "Correct",
    enterWorld: "Enter this world",
    shareWorld: "Share this world",
    shareCopied: "Link copied",
    comingSoon: "In development",
    exploring: "Explore this world",
    enterChapter: "Enter chapter →",
    openingAlt: "World opening",
    fallbackTitle: "Glimmers of Elsewhere",
    fallbackDesc: "A new world is waiting for you.",
    choiceFallback: "Choose this option",
    waterLabel: "Current state",
    stageLabel: "Current scene",
    endingEyebrow: "Your world echo",
    keepsakeLabel: "Ending keepsake",
    keepsakeHint: "Drag to rotate · scroll to zoom",
    keepsakeOpenHint: "Tap to open the 3D showroom",
    keepsakeDownload: "Download GLB",
    keepsakeGet: "Get it",
    keepsakeGetHint: "3D print · made real",
    keepsakeImage: "Download image",
    shelfOpen: "My figurines",
    shelfEyebrow: "Collected endings",
    shelfTitle: "The figurine shelf",
    shelfLocked: "Not unlocked yet",
    shelfView: "View in 3D",
    shelfContinue: "Back to the adventure",
    tuntunSummary: "Hidden page: a real cat",
    ksLoading: "Loading the 3D model…",
    soundLabel: "Toggle sound",
    sceneProgressHint: "Scene",
    creatorEntry: "Creator studio",
    noChange: "No change",
    replayVideo: "Replay",
  },
  zh: {
    quizHint: "观察画面并作答",
    quizQuestion: "这只猫正在演什么？",
    quizDescription: "观察画面，猜猜猫咪正在演什么。",
    quizChapter: (n) => `第 ${n} 题`,
    quizCorrect: (text) => `答对了！正确答案是：${text}`,
    quizWrong: (text) => `这次猜错了，正确答案是：${text}`,
    quizVideoFail: "猫咪还在排练，再试一次吧",
    successTitle: (t) => `${t} · 猜中了`,
    successDesc: "你看穿了猫咪的大部分表演，已经很懂这位小演员了。",
    failureTitle: (t) => `${t} · 再猜一次`,
    failureDesc: "猫咪的表演还藏着一点谜题，下一轮继续观察。",
    chapterN: (n) => `第 ${n} 章`,
    sceneN: (n) => `第 ${n} 幕`,
    scoreLabel: "答对",
    enterWorld: "进入这个世界",
    shareWorld: "分享这个世界",
    shareCopied: "链接已复制",
    comingSoon: "开发中",
    exploring: "探索这个异界",
    enterChapter: "进入篇章　→",
    openingAlt: "世界开场",
    fallbackTitle: "异境拾光",
    fallbackDesc: "一个新的世界正在等待你。",
    choiceFallback: "选择这个选项",
    waterLabel: "当前状态",
    stageLabel: "当前画面",
    endingEyebrow: "你的世界回响",
    keepsakeLabel: "获得结局信物",
    keepsakeHint: "拖动旋转 · 滚轮缩放",
    keepsakeOpenHint: "点击进入 3D 展厅",
    keepsakeDownload: "下载 GLB",
    keepsakeGet: "拿到它",
    keepsakeGetHint: "3D 打印 · 做成实物",
    keepsakeImage: "下载图片",
    shelfOpen: "我的手办柜",
    shelfEyebrow: "已收集的结局",
    shelfTitle: "手办柜",
    shelfLocked: "还没解锁",
    shelfView: "转一转",
    shelfContinue: "继续冒险",
    tuntunSummary: "彩蛋：一只真实的猫",
    ksLoading: "正在载入 3D 模型…",
    soundLabel: "切换声音",
    sceneProgressHint: "进度",
    creatorEntry: "设计关卡",
    noChange: "没有状态变化",
  },
};
const t = (key, ...args) => { const v = STRINGS[lang]?.[key] ?? STRINGS.zh[key]; return typeof v === "function" ? v(...args) : v; };

function escapeHtml(value = "") {
  return String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
}

function content() {
  return activeLevel || world || {};
}

function worldUi(key, fallback) {
  return world?.ui?.[key] || fallback;
}

async function loadLevelConfig(level) {
  const configPath = level.config.startsWith("worlds/") ? level.config : `${world.assetBase || `worlds/${world.id}/`}${level.config}`;
  const response = await fetch(rootUrl(configPath), { cache: "no-store" });
  if (!response.ok) throw new Error(`无法载入篇章配置：${configPath}`);
  const rawConfig = await response.json();
  const levelFolder = world.assetBase || `worlds/${world.id}/`;
  const levelOverride = await loadTextOverride(levelFolder, `en.${level.id}.json`);
  const config = mergeText(rawConfig, levelOverride);
  if (Array.isArray(config.scenes) && Array.isArray(config.endings)) {
    return { ...config, id: level.id || config.id, title: level.title || config.title || config.id };
  }
  const caseFiles = Array.isArray(config.caseFiles) ? config.caseFiles : [];
  const caseOverride = (await loadTextOverride(levelFolder, "en.cases.json")) || {};
  const cases = await Promise.all(caseFiles.map(async caseFile => {
    const casePath = caseFile.startsWith("worlds/") ? caseFile : `${world.assetBase || `worlds/${world.id}/`}${caseFile}`;
    const caseResponse = await fetch(rootUrl(casePath), { cache: "no-store" });
    if (!caseResponse.ok) throw new Error(`无法载入题目配置：${casePath}`);
    const raw = await caseResponse.json();
    return mergeText(raw, caseOverride[raw.id]);
  }));
  const scenes = cases.map((item, index) => {
    const options = Array.isArray(item.options) ? item.options : [];
    const correct = item.correctOptionId;
    const actions = options.map((option, optionIndex) => ({
      id: option.id,
      name: option.text,
      plain: option.text,
      hint: t("quizHint"),
      icon: lang === "en" ? String.fromCharCode(65 + optionIndex) : "菜",
      image: option.image || null,
    }));
    const outcomes = Object.fromEntries(options.map(option => [option.id, {
        image: option.image || null,
        stateChanges: { score: option.id === correct ? 1 : 0 },
        text: option.id === correct ? t("quizCorrect", option.text) : t("quizWrong", options.find(candidate => candidate.id === correct)?.text || option.text),
      }]));
    return {
      id: item.id,
      chapter: t("quizChapter", index + 1),
      image: item.mysteryImages?.medium || item.mysteryImage,
      title: item.title || t("quizQuestion"),
      description: t("quizDescription"),
      actions,
      outcomes,
    };
  });
  const finaleVideos = config.finaleVideos || {};
  return {
    ...config,
    id: level.id || config.id,
    title: level.title || config.title || config.id,
    scenes,
    initialState: { score: 0 },
    states: [{ id: "score", label: t("scoreLabel"), color: "#d69a38", chipBackground: "#fff0c7", max: scenes.length }],
    endings: [
      { id: "success", title: t("successTitle", level.title || config.title || t("chapterN", 1)), video: finaleVideos.success || config.finaleVideo, all: [{ state: "score", operator: ">", value: Math.floor(scenes.length / 2) }], description: t("successDesc") },
      { id: "failure", title: t("failureTitle", level.title || config.title || t("chapterN", 1)), video: finaleVideos.failure || config.finaleVideo, all: [], description: t("failureDesc") },
    ],
  };
}

async function loadLevels() {
  if (!Array.isArray(world?.levels) || !world.levels.length) return;
  world.levels = await Promise.all(world.levels.map(loadLevelConfig));
}

async function loadWorld(configPath) {
  if (!configPath) return;
  const response = await fetch(rootUrl(configPath), { cache: "no-store" });
  if (!response.ok) throw new Error(`无法载入异界配置：${configPath}`);
  const rawWorld = await response.json();
  const worldFolder = rawWorld.assetBase || `worlds/${rawWorld.id}/`;
  const worldOverride = await loadTextOverride(worldFolder, "en.json");
  world = mergeText(rawWorld, worldOverride);
  document.body.dataset.worldId = world.id;
  activeLevel = null;
  await loadLevels();
  selectedWorldEntry = worldEntries.find(entry => entry.config === configPath) || selectedWorldEntry;
  renderWorldIdentity();
  // Label overrides can only resolve once the world data is in: Ah Hui calls
  // its endings' rewards "figurines" while other worlds keep "keepsakes".
  labelStaticDom();
}

async function loadPlatformText() {
  const over = await loadTextOverride("", "en.json");
  uiText = mergeText({
    platformTitle: "异境拾光",
    catalogNote: "世界会记住你的每一次选择。",
    soundToggle: "切换声音",
    backCatalog: "← 返回世界",
    levelSelectTitle: "选择篇章开始",
    continueButton: "继续看下去",
    finalContinueButton: "查看结果",
    replayButton: "再玩一次",
    replayVideo: "重新播放",
    introButton: "睁开猫眼",
    enterWorld: "进入这个世界",
    comingSoon: "开发中",
    exploring: "探索这个异界",
    enterChapter: "进入篇章　→",
    choiceFallback: "选择这个选项",
    soundLabel: "切换声音",
    catalog: { eyebrow: "", headline: "", description: "" },
    creatorEntry: "设计关卡",
  }, over || {});
}

function prefetchCatalogSource() {
  if (!catalogSourcePromise) {
    catalogSourcePromise = (async () => {
      const response = await fetch(rootUrl("worlds/index.json?v=1"), { cache: "no-store" });
      if (!response.ok) throw new Error("无法载入异界目录");
      const catalog = await response.json();
      const entries = (Array.isArray(catalog.worlds) ? catalog.worlds : []).filter(entry => !entry.hidden);
      const rawEntries = await Promise.all(entries.map(async entry => {
        if (entry.status === "coming-soon" || (!entry.config && !entry.launchUrl)) {
          return { entry, configPath: null, rawWorld: null, folder: null };
        }
        if (!entry.config && entry.launchUrl) {
          return { entry, configPath: null, rawWorld: null, folder: null };
        }
        const configPath = entry.config.startsWith("worlds/") ? entry.config : `worlds/${entry.config}`;
        const configResponse = await fetch(rootUrl(configPath), { cache: "no-store" });
        if (!configResponse.ok) throw new Error(`异界配置不存在：${configPath}`);
        const rawWorld = await configResponse.json();
        const folder = rawWorld.assetBase || `worlds/${rawWorld.id}/`;
        prefetchTextOverride(folder, "en.json");
        return { entry, configPath, rawWorld, folder };
      }));
      prefetchTextOverride("", "en.json");
      return { catalog, rawEntries };
    })();
  }
  return catalogSourcePromise;
}

async function loadCatalog() {
  const sourcePromise = prefetchCatalogSource();
  await loadPlatformText();
  const { catalog, rawEntries } = await sourcePromise;
  worldEntries = await Promise.all(rawEntries.map(async rawEntry => {
    const { entry, configPath, rawWorld, folder } = rawEntry;
    if (!configPath) {
      return {
        ...entry,
        config: null,
        world: {
          ...entry,
          assetBase: entry.assetBase || `worlds/${entry.id}/`,
          status: entry.status || (entry.launchUrl ? "ready" : "coming-soon"),
        },
      };
    }
    const worldOver = await loadTextOverride(folder, "en.json");
    return { ...entry, config: configPath, world: mergeText(rawWorld, worldOver) };
  }));
  if (!worldEntries.length) throw new Error("异界目录为空");
  renderCatalog(catalog);
}

let lastCatalog = null;
function applyPlatformText() {
  const catalog = lastCatalog; if (!catalog) return;
  const platform = mergeText(catalog.catalog || {}, uiText?.catalog || {});
  $("platformTitle").textContent = uiText?.platformTitle || "异境拾光";
  $("catalogEyebrow").textContent = platform.eyebrow || "异境拾光 · 世界目录";
  $("catalogHeadline").textContent = platform.headline || "每一片异境，都有一场自己的游戏。";
  $("catalogDescription").textContent = platform.description || "选择一个世界，进入一段属于它的故事。";
  $("catalogNote").textContent = uiText.catalogNote;
  const creatorEntry = document.querySelector("#creatorEntry");
  if (creatorEntry) creatorEntry.textContent = t("creatorEntry");
}

function renderCatalog(catalog) {
  lastCatalog = catalog;
  applyPlatformText();
  $("worldCards").innerHTML = worldEntries.map((entry, index) => worldCardMarkup(entry, index)).join("");
  $("worldCards").querySelectorAll("[data-world-config]").forEach(button => {
    button.addEventListener("click", () => {
      const entry = worldEntries.find(item => item.config === button.dataset.worldConfig);
      if (!entry) return;
      window.location.href = worldShareUrl(entry);
    });
  });
  $("worldCards").querySelectorAll("[data-world-launch]").forEach(button => {
    button.addEventListener("click", () => { window.location.href = button.dataset.worldLaunch; });
  });
  $("worldCards").querySelectorAll("[data-world-share]").forEach(button => {
    button.addEventListener("click", async () => {
      const url = button.dataset.worldShare;
      try {
        if (navigator.share) {
          await navigator.share({ title: document.title, url });
        } else {
          await navigator.clipboard.writeText(url);
          const original = button.textContent;
          button.textContent = "✓";
          button.title = t("shareCopied");
          window.setTimeout(() => { button.textContent = original; button.title = t("shareWorld"); }, 1200);
        }
      } catch (_) { /* user cancelled the native share sheet */ }
    });
  });
}

function worldShareUrl(entry) {
  const url = new URL(rootUrl(`worlds/${entry.id}/`), location.href);
  url.searchParams.set("lang", lang);
  return url.href;
}

function worldCardMarkup(entry, index) {
  const item = entry.world;
  const catalog = item.catalog || {};
  const useEn = lang === "en";
  const cardTitle = (useEn && (entry.titleEn || item.titleEn)) || item.title;
  const cardSubtitle = (useEn && (entry.subtitleEn || item.subtitleEn)) || item.subtitle || "一个等待探索的异界";
  const cardDesc = (useEn && (entry.descriptionEn || item.descriptionEn)) || catalog.cardDescription || item.cardDescription || "";
  const gradient = (catalog.cardGradient || ["#8172c3", "#44346e", "#28203f"]).join(", ");
  const accent = catalog.cardAccent || "#f7d582";
  const icon = catalog.cardIcon || "✦";
  const label = `WORLD ${String(index + 1).padStart(2, "0")}`;
  const actionSummary = (useEn && catalog.actionSummary) || (item.actions || []).map(action => action.plain || action.name).join(" · ");
  const coverRel = (item.cover && item.cover[useEn ? "en" : "zh"]) || item.cover?.default || item.coverImage || item.assets?.cover;
  const cover = coverRel ? rootUrl(`${item.assetBase || `worlds/${item.id}/`}${coverRel}`) : "";
  const comingSoon = entry.status === "coming-soon" || item.status === "coming-soon";
  const launch = entry.launchUrl || item.launchUrl;
  const button = comingSoon
    ? `<button class="is-coming-soon" type="button" disabled>${t("comingSoon")} <b>·</b></button>`
    : launch
      ? `<button data-world-launch="${escapeHtml(launch)}" type="button">${t("enterWorld")} <b>→</b></button>`
    : `<button data-world-config="${escapeHtml(entry.config)}" data-world-entry="${escapeHtml(worldShareUrl(entry))}" type="button">${t("enterWorld")} <b>→</b></button>`;
  return `<article class="world-card">
    <div class="world-card-art${cover ? " has-cover" : ""}" style="--world-gradient:${gradient};--world-accent:${escapeHtml(accent)}" aria-hidden="true">
      ${cover ? `<img class="world-cover" src="${escapeHtml(cover)}" alt="" loading="lazy">` : ""}
      <span class="world-number">${escapeHtml(label)}</span>
      ${comingSoon ? "" : `<button class="world-share" type="button" data-world-share="${escapeHtml(worldShareUrl(entry))}" title="${escapeHtml(t("shareWorld"))}" aria-label="${escapeHtml(t("shareWorld"))}">⇗</button>`}
      <div class="world-orbit"><i>${escapeHtml(icon)}</i></div>
      <span class="spark spark-a">✦</span><span class="spark spark-b">✧</span><span class="spark spark-c">✦</span>
    </div>
    <div class="world-card-copy"><p>${escapeHtml(cardSubtitle)}</p><h3>${escapeHtml(cardTitle)}</h3>${cardDesc ? `<div class="world-card-description">${escapeHtml(cardDesc)}</div>` : ""}<span>${escapeHtml(actionSummary || (comingSoon ? t("comingSoon") : t("exploring")))}</span>${button}</div>
  </article>`;
}

function renderWorldIdentity() {
  $("worldMiniTitle").textContent = world.shortTitle || world.title;
  $("replayButton").textContent = worldUi("replayButton", uiText.replayButton);
  $("beginJourney").textContent = worldUi("introButton", uiText.introButton);
  document.querySelectorAll("[data-back-catalog]").forEach(button => {
    button.textContent = worldUi("backToCatalog", uiText.backCatalog);
  });
  document.querySelectorAll("[data-back-catalog]").forEach(button => { button.title = uiText.backCatalog; });
}

async function enterWorldFromCatalog(configPath) {
  await loadWorld(configPath);
  enterWorld();
}

function resetGame() {
  sceneIndex = 0;
  lifeTurn = 0;
  lifeEventHistory = [];
  queuedLifeEvent = null;
  lifeTalentIds = [];
  shownMilestones = new Set();
  state = { ...(content().initialState || {}) };
  renderMeters();
}

function renderLevelSelect() {
  const select = $("levelSelect");
  const levels = world?.levels || [];
  // A world with a single chapter skips the picker entirely and starts right away.
  if (levels.length === 1 && !activeLevel) { select.hidden = true; $("beginJourney").hidden = true; startLevel(levels[0].id); return; }
  select.hidden = !levels.length;
  $("beginJourney").hidden = Boolean(levels.length);
  if (!levels.length) return;
  $("openingFallback").hidden = true;
  $("levelSelectTitle").textContent = worldUi("levelSelectTitle", uiText.levelSelectTitle);
  const showNumbers = levels.length > 1;
  $("levelCards").innerHTML = levels.map((level, index) => `<button class="level-card" type="button" data-level-id="${escapeHtml(level.id)}">${showNumbers ? `<span>CHAPTER ${String(index + 1).padStart(2, "0")}</span>` : ""}<strong>${escapeHtml(level.title)}</strong><small>${level.scenes.length} ${lang === "en" ? "scenes" : "幕"} · ${lang === "en" ? "tap to start" : "选择后开始"}</small><b>${t("enterChapter")}</b></button>`).join("");
  $("levelCards").querySelectorAll("[data-level-id]").forEach(button => button.addEventListener("click", () => startLevel(button.dataset.levelId)));
}

function startLevel(levelId) {
  activeLevel = world.levels.find(level => level.id === levelId) || null;
  if (!activeLevel) return;
  resetGame();
  showView("gameView");
  renderScene();
}

function enterWorld() {
  activeLevel = null;
  resetGame();
  const opening = world.opening || { mode: "html", html: world.openingHtml };
  const video = $("openingVideo");
  const frame = $("openingFrame");
  const fallback = $("openingFallback");
  const openingImage = $("openingImage");
  fallback.hidden = true;
  openingImage.hidden = true;
  if (opening.mode === "video" && opening.video) {
    video.hidden = false;
    video.muted = true;
    frame.hidden = true;
    video.poster = opening.poster ? worldAsset(opening.poster) : "";
    video.src = worldAsset(opening.video);
    video.play().catch(() => {
      if (opening.html) {
        video.hidden = true;
        frame.hidden = false;
        frame.src = `${worldAsset(opening.html)}?lang=${lang}`;
      } else {
        video.hidden = true;
        frame.hidden = true;
        showOpeningFallback();
      }
    });
  } else if (opening.mode === "image" && opening.image) {
    video.pause();
    video.hidden = true;
    frame.hidden = true;
    fallback.hidden = true;
    openingImage.src = worldAsset(opening.image);
    openingImage.alt = world.title || t("openingAlt");
    openingImage.hidden = false;
  } else {
    video.pause();
    video.hidden = true;
    $("openingImage").hidden = true;
    if (opening.html || world.openingHtml) {
      frame.hidden = false;
      frame.src = `${worldAsset(opening.html || world.openingHtml)}?lang=${lang}`;
    } else {
      frame.hidden = true;
      showOpeningFallback();
    }
  }
  showView("introView");
  renderLevelSelect();
  setWorldMusic(world.music);
  preloadFirstPlayableScene();
}

function showOpeningFallback() {
  const fallback = $("openingFallback");
  fallback.querySelector("h2").textContent = world.title || t("fallbackTitle");
  fallback.querySelector("p:last-child").textContent = world.description || t("fallbackDesc");
  fallback.hidden = false;
}

function playMusicPath(nextPath, volume = 0.12) {
  const music = $("worldMusic");
  if (nextPath === musicPath && !music.paused) return;
  music.pause();
  music.currentTime = 0;
  musicPath = nextPath;
  music.src = nextPath;
  music.loop = true;
  music.volume = Number.isFinite(Number(volume)) ? Number(volume) : 0.12;
  music.muted = !soundEnabled;
  if (soundEnabled && nextPath) music.play().catch(() => {});
}

function setWorldMusic(relativePath) {
  playMusicPath(relativePath ? worldAsset(relativePath) : "", world?.musicVolume);
}

function setCatalogMusic() {
  playMusicPath(rootUrl("worlds/meow-supreme/assets/audio/curious-patrol.mp3"), 0.1);
}

function stopWorldMusic() {
  const music = $("worldMusic");
  music.pause();
  music.currentTime = 0;
  musicPath = "";
}

function startJourney() {
  if (world?.levels?.length) return;
  if (world?.mode === "life") { showTalentSelect(); return; }
  if (world?.id === "stray-cat") { showStrayTalentSelect(); return; }
  showView("gameView");
  renderScene();
}

function pickWeightedTalents(count = 3) {
  const talents = [...(content().talents || [])];
  const picked = [];
  while (talents.length && picked.length < count) {
    const total = talents.reduce((sum, item) => sum + Number(item.weight || 1), 0);
    let roll = Math.random() * total;
    let index = talents.length - 1;
    for (let i = 0; i < talents.length; i++) {
      roll -= Number(talents[i].weight || 1);
      if (roll <= 0) { index = i; break; }
    }
    picked.push(talents.splice(index, 1)[0]);
  }
  return picked;
}

function showStrayTalentSelect() {
  const talents = content().talents || [];
  if (!talents.length) { startStrayGame(); return; }
  const selection = content().talentSelection || {};
  const options = selection.weighted
    ? pickWeightedTalents(selection.count || 3)
    : [...talents].sort(() => Math.random() - 0.5).slice(0, selection.count || 3);

  showView("introView");
  $("openingFallback").hidden = true;
  $("openingImage").hidden = true;
  $("openingVideo").hidden = true;
  $("levelSelect").hidden = false;
  $("levelSelectTitle").textContent = lang === "en" ? "Ah Hui's talent" : "阿灰的天赋";
  $("beginJourney").hidden = true;

  const rarityLabels = { 0: "WHITE", 1: "BLUE", 2: "PURPLE", 3: "ORANGE", 4: "RED" };
  $("levelCards").innerHTML = options.map(talent => `
    <button class="level-card talent-card" type="button" data-stray-talent="${escapeHtml(talent.id)}">
      ${talent.image ? `<img class="talent-image" src="${escapeHtml(worldAsset(talent.image))}" alt="">` : ""}
      <span class="talent-rarity rarity-${talent.rarity || 0}">${rarityLabels[talent.rarity || 0] || "WHITE"}</span>
      <strong>${escapeHtml(talent.name)}</strong>
      <small>${escapeHtml(talent.description || "")}</small>
      <b class="talent-check">✓</b>
    </button>
  `).join("") + `
    <button id="strayTalentConfirm" class="talent-confirm" type="button" disabled>
      ${escapeHtml(lang === "en" ? "Confirm" : "确认")}
    </button>
  `;

  let selected = null;
  const confirmBtn = $("strayTalentConfirm");
  const updateConfirm = () => {
    confirmBtn.disabled = !selected;
    confirmBtn.textContent = lang === "en" ? "Start the adventure" : "开始冒险";
    confirmBtn.classList.toggle("is-ready", Boolean(selected));
  };
  updateConfirm();

  $("levelCards").querySelectorAll("[data-stray-talent]").forEach(button => {
    button.addEventListener("click", () => {
      selected = button.dataset.strayTalent;
      $("levelCards").querySelectorAll("[data-stray-talent]").forEach(item => item.classList.remove("is-selected"));
      button.classList.add("is-selected");
      updateConfirm();
    });
  });

  confirmBtn.addEventListener("click", () => {
    if (!selected) return;
    lifeTalentIds = [selected];
    startStrayGame();
  });
}

function startStrayGame() {
  const selectedTalentIds = [...lifeTalentIds];
  prepareStraySceneOrder();
  resetGame();
  lifeTalentIds = selectedTalentIds;
  for (const talentId of lifeTalentIds) {
    const talent = (content().talents || []).find(item => item.id === talentId);
    if (talent?.effect) {
      for (const [key, value] of Object.entries(talent.effect)) {
        state[key] = (state[key] || 0) + value;
      }
    }
  }
  showView("gameView");
  renderScene();
  warmUpStrayScenes();
}

/* ---------- Ah Hui: shuffled middle, warmed art ---------- */
function prepareStraySceneOrder() {
  const shuffle = world?.sceneShuffle;
  // Keep the master pool once: the run order is rebuilt from it every time, so
  // replaying cannot shrink the pool the way mutating world.scenes would.
  if (!world.__scenePool) world.__scenePool = [...(world.scenes || [])];
  const scenes = world.__scenePool;
  if (!shuffle || scenes.length < 2) return;
  const head = Math.max(0, Number(shuffle.head) || 0);
  const tail = Math.max(0, Number(shuffle.tail) || 0);
  const end = Math.max(head, scenes.length - tail);
  let middle = scenes.slice(head, end);
  // With a bigger event pool the run only shows `sample` of them, so two runs
  // never walk the same street twice.
  const sample = Number(shuffle.sample) || 0;
  if (sample > 0 && middle.length > sample) {
    const pool = [...middle];
    const picked = [];
    while (picked.length < sample && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    middle = picked;
  }
  for (let i = middle.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [middle[i], middle[j]] = [middle[j], middle[i]];
  }
  // Opening quarters and the closing danger block stay fixed; the middle of the
  // cat's life is different every run, like the life-sim worlds.
  world.scenes = [...scenes.slice(0, head), ...middle, ...scenes.slice(end)];
  world.scenes.forEach((scene, index) => {
    const start = 2 * index;
    scene.chapterEn = `Q${index + 1} · Months ${start}-${start + 2}`;
    // The label has to follow the current language, otherwise English runs show
    // the Chinese 个月 that the merge step had already translated away.
    scene.chapter = lang === "en" ? scene.chapterEn : `Q${index + 1} · ${start}-${start + 2}个月`;
  });
}

function warmUpStrayScenes() {
  // The late pictures (cat meat dealer, wire, abuser) used to pop in blank on a
  // slow connection, so warm every scene and every ending in the background.
  const scenes = [...(content().scenes || [])];
  scenes.forEach((scene, index) => window.setTimeout(() => preloadImage(scene.image), 800 + index * 130));
  const endings = [...(content().endings || [])];
  endings.forEach((ending, index) => {
    if (ending.image) window.setTimeout(() => preloadImage(ending.image), 3200 + index * 130);
  });
}

function goCatalog() {
  if (window.__WORLD_ID__) {
    const back = new URL(rootUrl(""), location.href);
    back.searchParams.set("lang", lang);
    location.href = `${back.pathname}${back.search}`;
    return;
  }
  showView("catalogView");
  // resolve relative to the deployed folder so this also works under a
  // GitHub Pages project subpath (e.g. /GlimmersElsewhere/)
  const back = new URL(location.pathname.replace(/[^/]*$/, ""), location.origin);
  back.searchParams.set("lang", lang);
  history.replaceState({}, "", `${back.pathname}${back.search}`);
  setCatalogMusic();
}

function labelStaticDom() {
  const set = (sel, text) => { const el = document.querySelector(sel); if (el && text) el.textContent = text; };
  set("#sceneMissing", lang === "en" ? "Scene image could not load" : "场景图片暂时没有加载出来");
  set(".ending-card .eyebrow", t("endingEyebrow"));
  document.querySelectorAll("[data-shelf-open]").forEach(el => el.setAttribute("aria-label", t("shelfOpen")));
  // A world can rename shared labels (Ah Hui's endings hand out figurines, not keepsakes).
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = worldUi(el.dataset.i18n, t(el.dataset.i18n));
    if (typeof v === "string") el.textContent = v;
  });
  // A world can be shipped as a standalone game: hide the catalogue doors.
  const hideBack = Boolean(world?.ui?.hideBackToCatalog);
  document.querySelectorAll("[data-back-catalog]").forEach(button => { button.hidden = hideBack; });
  const meters = document.getElementById("meters");
  if (meters) meters.setAttribute("aria-label", t("waterLabel"));
  const stage = document.getElementById("visualStage");
  if (stage) stage.setAttribute("aria-label", t("stageLabel"));
  const choices = document.getElementById("choicePanel");
  if (choices) choices.setAttribute("aria-label", lang === "en" ? "Choose an action" : "选择动作");
}

/* ---------- P1: outcome resolution (tiers + weighted variants) ---------- */
function pickWeighted(variants) {
  const total = variants.reduce((sum, item) => sum + (Number(item.weight) || 1), 0);
  let roll = Math.random() * total;
  for (const item of variants) {
    roll -= Number(item.weight) || 1;
    if (roll <= 0) return item;
  }
  return variants[variants.length - 1];
}

function meetsMins(mins) {
  return Object.entries(mins || {}).every(([key, value]) => (state[key] || 0) >= Number(value));
}

function resolveOutcome(scene, actionId) {
  const base = (scene.outcomes || {})[actionId] || {};
  if (base.compare) {
    const condition = base.compare;
    const left = Number(state[condition.stat] || 0);
    const right = Number(scene.enemy?.[condition.enemyStat] || 0);
    const passed = condition.op === ">" ? left > right : condition.op === "<" ? left < right : left >= right;
    return passed ? condition.success : condition.failure;
  }
  let resolved = base;
  if (Array.isArray(base.tiers) && base.tiers.length) {
    resolved = base.tiers.find(tier => meetsMins(tier.min)) || base.tiers[base.tiers.length - 1];
  }
  if (Array.isArray(resolved.variants) && resolved.variants.length) {
    const picked = pickWeighted(resolved.variants);
    resolved = { ...resolved, ...picked };
  }
  return resolved;
}

/* ---------- P1: milestones (threshold feedback during a run) ---------- */
function checkMilestone() {
  for (const milestone of content().milestones || []) {
    if (shownMilestones.has(milestone.id)) continue;
    if ((state[milestone.state] || 0) >= Number(milestone.at)) {
      shownMilestones.add(milestone.id);
      return milestone;
    }
  }
  return null;
}

function milestoneMarkup(milestone) {
  if (!milestone) return "";
  return `<div class="milestone-card">
    <small>${escapeHtml(milestone.eyebrow || (lang === "en" ? "THRESHOLD" : "状态变化"))}</small>
    <strong>${escapeHtml(milestone.title || "")}</strong>
    <p>${escapeHtml(milestone.text || "")}</p>
    ${milestone.image ? `<img src="${escapeHtml(worldAsset(milestone.image))}" alt="">` : ""}
  </div>`;
}

/* ---------- P1: collection (persists in localStorage, works on static hosting) ---------- */
function loadCollection() {
  try { return JSON.parse(localStorage.getItem(COLLECTION_KEY)) || {}; } catch (_) { return {}; }
}
function saveCollection(collection) { localStorage.setItem(COLLECTION_KEY, JSON.stringify(collection)); }
function recordChoice(worldId, sceneId, actionId) {
  const collection = loadCollection();
  const world = collection[worldId] = collection[worldId] || { actions: [], endings: [] };
  const key = `${sceneId}:${actionId}`;
  if (!world.actions.includes(key)) { world.actions.push(key); saveCollection(collection); }
}
function recordEnding(worldId, endingId) {
  const collection = loadCollection();
  const world = collection[worldId] = collection[worldId] || { actions: [], endings: [] };
  if (!world.endings.includes(endingId)) { world.endings.push(endingId); saveCollection(collection); }
}
function collectionMarkup(worldId) {
  const scenes = content().scenes || [];
  // count per-scene actions, or world-level actions when scenes don't define their own
  const perScene = scenes.reduce((sum, scene) => sum + (scene.actions || []).length, 0);
  const total = perScene || (content().actions || []).length * scenes.length;
  const endings = content().endings || [];
  const mine = (loadCollection()[worldId] || { actions: [], endings: [] });
  const actionKeys = new Set(mine.actions);
  const endingIds = new Set(mine.endings);
  if (!total && !endings.length) return "";
  const sceneActions = perScene
    ? (content().scenes || []).flatMap(scene => (scene.actions || []).map(action => ({ ...action, sceneId: scene.id })))
    : (content().scenes || []).flatMap(scene => (content().actions || []).map(action => ({ ...action, sceneId: scene.id })));
  const chips = sceneActions.map((action, index) => {
    const got = actionKeys.has(`${action.sceneId}:${action.id}`);
    const icon = lang === "en"
      ? (action.icon && /^[A-Za-z0-9]$/.test(action.icon) ? action.icon : String.fromCharCode(65 + (index % 26)))
      : (action.icon || "✦");
    return `<span class="${got ? "is-got" : ""}" title="${escapeHtml(action.name || action.id)}">${got ? escapeHtml(icon) : "?"}</span>`;
  });
  const endingChips = endings.map(ending => {
    const got = endingIds.has(ending.id);
    return `<span class="${got ? "is-got" : ""}" title="${escapeHtml(got ? ending.title : (lang === "en" ? "Locked ending" : "未解锁结局"))}">${got ? "★" : "☆"}</span>`;
  });
  return `<div class="collection-box">
    <div><small>${escapeHtml(lang === "en" ? "COLLECTION" : "图鉴")}</small>
    <strong>${mine.actions.length}/${total} ${escapeHtml(lang === "en" ? "actions" : "个动作")} · ${mine.endings.length}/${endings.length} ${escapeHtml(lang === "en" ? "endings" : "个结局")}</strong></div>
    <div class="collection-grid">${chips.join("")}${endingChips.join("")}</div>
  </div>`;
}


/* ============================================================
   LIFE-SIM ENGINE (mode: "life")
   Random events, talents, branching, lifespan, achievements.
   ============================================================ */

let lifeTurn = 0;
let lifeEventHistory = [];
let lifeTalentIds = [];
let queuedLifeEvent = null;
let lifeFinalTrialShown = false;

/* ---------- condition parser ----------
   Grammar:  expr := andExpr ( "|" andExpr )*
             andExpr := primary ( "&" primary )*
             primary := "(" expr ")" | comparison
             comparison := IDENT OP NUMBER
   Ops: >=, <=, >, <, =, ==
---------------------------------------------------------------- */
function parseConditionTokens(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "(" || c === ")" || c === "|" || c === "&") { tokens.push(c); i++; continue; }
    if (c === ">" || c === "<") {
      if (input[i + 1] === "=") { tokens.push(">="); i += 2; }
      else { tokens.push(c); i++; }
      continue;
    }
    if (c === "!" && input[i + 1] === "=") { tokens.push("!="); i += 2; continue; }
    if (c === "=") { tokens.push("=="); i++; continue; }
    // identifier or number
    let j = i;
    while (j < input.length && ![" ", "\t", "(", ")", "|", "&", ">", "<", "="].includes(input[j])) j++;
    tokens.push(input.slice(i, j));
    i = j;
  }
  return tokens;
}

function checkLifeCondition(condition) {
  if (!condition) return true;
  const tokens = parseConditionTokens(condition);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }
  function parseExpr() {
    let result = parseAnd();
    while (peek() === "|") { next(); result = parseAnd() || result; }
    return result;
  }
  function parseAnd() {
    let result = parsePrimary();
    while (peek() === "&") { next(); result = parsePrimary() && result; }
    return result;
  }
  function parsePrimary() {
    if (peek() === "(") { next(); const v = parseExpr(); if (peek() === ")") next(); return v; }
    return parseComparison();
  }
  function parseComparison() {
    const ident = next();
    const op = next();
    const value = parseFloat(next());
    const left = state[ident] || 0;
    switch (op) {
      case ">=": return left >= value;
      case "<=": return left <= value;
      case ">":  return left > value;
      case "<":  return left < value;
      case "==": return left === value;
      case "!=": return left !== value;
      default: return false;
    }
  }
  return parseExpr();
}

/* ---------- weighted event drawing ---------- */
const LIFE_RARITY_WEIGHT = { 0: 10, 1: 5, 2: 2, 3: 1 };

function drawLifeEvent() {
  const allEvents = content().events || [];
  // filter by turn stage, include/exclude and not-already-seen
  const available = allEvents.filter(event => {
    if (lifeEventHistory.includes(event.id)) return false;
    if (event.minTurn !== undefined && lifeTurn < event.minTurn) return false;
    if (event.maxTurn !== undefined && lifeTurn > event.maxTurn) return false;
    if (event.requiredProfession && state.profession !== event.requiredProfession) return false;
    if (Array.isArray(event.requiredProfessions) && !event.requiredProfessions.includes(state.profession)) return false;
    if (event.include && !checkLifeCondition(event.include)) return false;
    if (event.exclude && checkLifeCondition(event.exclude)) return false;
    return true;
  });
  if (!available.length) return null;
  const luckyPaw = lifeTalentIds.includes("lucky-paw");
  const weights = luckyPaw
    ? { 0: 6, 1: 6, 2: 5, 3: 4 }
    : LIFE_RARITY_WEIGHT;
  // weighted pick by rarity
  const total = available.reduce((sum, e) => sum + (weights[e.rarity || 0] || 5), 0);
  let roll = Math.random() * total;
  for (const event of available) {
    roll -= weights[event.rarity || 0] || 5;
    if (roll <= 0) return event;
  }
  return available[available.length - 1];
}

function preloadLifeEventImage(event) {
  if (!event) return;
  preloadImage(event.image || content().lifeDefaultImage);
  for (const choice of event.choices || []) preloadImage(choice.image);
}

function preloadImage(relativePath) {
  if (!relativePath) return;
  const preload = new Image();
  preload.decoding = "async";
  preload.src = worldAsset(relativePath);
}

function queueNextLifeEvent() {
  queuedLifeEvent = null;
  const current = content();
  const hardLimit = current.lifespanMax || 50;
  const turnLimit = current.lifeTurnLimit || hardLimit;
  const age = Number(state.age || 0);
  const totalLifespan = Number(state.lifespan || 0);
  if (age >= hardLimit || age >= totalLifespan || lifeTurn + 1 > turnLimit) return;

  // Draw the next random event while the player reads the outcome, then start
  // its image immediately. renderLifeEvent() consumes this exact event next.
  const originalTurn = lifeTurn;
  lifeTurn++;
  queuedLifeEvent = drawLifeEvent();
  lifeTurn = originalTurn;
  preloadLifeEventImage(queuedLifeEvent);
}

function applyLifeEffect(effect = {}) {
  const applied = {};
  const spiritRoot = lifeTalentIds.includes("spirit-root");
  for (const [key, rawValue] of Object.entries(effect)) {
    if (typeof rawValue === "string") {
      state[key] = rawValue;
      applied[key] = rawValue;
      continue;
    }
    let value = Number(rawValue) || 0;
    if (key === "cultivation" && value > 0 && spiritRoot) value *= 2;
    state[key] = (state[key] || 0) + value;
    applied[key] = value;
  }
  clampLifeState();
  return applied;
}

/* ---------- life-sim flow ---------- */
function startLifeSim() {
  lifeTurn = 0;
  lifeEventHistory = [];
  queuedLifeEvent = null;
  lifeFinalTrialShown = false;
  state = { ...(content().initialState || {}) };
  const startEventId = content().startEventId;
  queuedLifeEvent = startEventId
    ? (content().events || []).find(event => event.id === startEventId)
    : null;
  for (const talentId of lifeTalentIds) {
    const talent = (content().talents || []).find(t => t.id === talentId);
    if (talent?.effect) {
      for (const [key, value] of Object.entries(talent.effect)) {
        state[key] = (state[key] || 0) + value;
      }
    }
  }
  clampLifeState();
  showView("gameView");
  renderLifeEvent();
}

const LIFE_REALMS = [
  { min: 0, label: "凡猫", en: "Mortal Cat" },
  { min: 8, label: "炼气", en: "Qi Refining" },
  { min: 16, label: "筑基", en: "Foundation" },
  { min: 24, label: "金丹", en: "Golden Core" },
  { min: 32, label: "元婴", en: "Nascent Soul" },
  { min: 40, label: "化神", en: "Spirit Transform" },
  { min: 50, label: "大乘", en: "Mahayana" },
];

function lifeRealm() {
  const realmState = content().realmState || "cultivation";
  const v = state[realmState] || 0;
  const realms = content().lifeRealms || LIFE_REALMS;
  let realm = realms[0];
  for (const r of realms) {
    if (v >= r.min) realm = r;
  }
  return realm;
}

function lifeProfession() {
  const professionId = state.profession || (content().initialState || {}).profession;
  const definition = (content().professions || []).find(item => item.id === professionId);
  if (!definition) return "";
  return definition.label || definition.labelEn || professionId;
}

function renderLifeProfession() {
  const chip = $("professionChip");
  if (!chip) return;
  const label = lifeProfession();
  chip.hidden = !label || world?.mode !== "life";
  if (label) {
    chip.innerHTML = `<small>${escapeHtml(lang === "en" ? "PROFESSION" : "职业")}</small><strong>${escapeHtml(label)}</strong>`;
  }
}

function clampLifeState() {
  const maxLifespan = content().lifespanMax || 50;
  state.age = Math.max(0, Math.min(maxLifespan, Number(state.age || 0)));
  state.lifespan = Math.max(0, Math.min(maxLifespan, Number(state.lifespan || 0)));
  for (const def of content().states || []) {
    // A stat can declare a floor of its own: morale in 玉猫登仙 is allowed to go
    // negative, otherwise talents and events that cost morale do nothing at all.
    const floor = Number.isFinite(Number(def.min)) ? Number(def.min) : 0;
    const ceiling = Number.isFinite(Number(def.max)) ? Number(def.max) : Infinity;
    state[def.id] = Math.min(Math.max(floor, Number(state[def.id]) || 0), ceiling);
  }
  state.fish = Math.min(Math.max(0, state.fish || 0), 99);
}

function renderLifeEvent() {
  clampLifeState();
  const current = content();
  const hardLimit = current.lifespanMax || 50;
  const turnLimit = current.lifeTurnLimit || hardLimit;
  const age = Number(state.age || 0);
  const totalLifespan = Number(state.lifespan || 0);
  // The hard safety valve is 50 time units (500 years). "lifespan" is the
  // cumulative maximum age, not remaining HP, so events can no longer loop forever.
  if (age >= hardLimit || age >= totalLifespan || lifeTurn >= turnLimit) {
    if (current.finalTrial && !lifeFinalTrialShown) {
      showLifeFinalTrial();
      return;
    }
    showEnding();
    return;
  }

  lifeTurn++;
  const event = queuedLifeEvent || drawLifeEvent();
  queuedLifeEvent = null;
  if (!event) { showEnding(); return; }
  lifeEventHistory.push(event.id);

  // One event is one narrative beat. timeCost is measured in 10-year units;
  // 0 means this beat happens in the same year as the previous one.
  const timeCost = Number(event.timeCost ?? 1);
  state.age = Math.max(0, Number(state.age || 0) + timeCost);
  applyLifeEffect(event.effect);

  const stageNames = current.lifeStages || ["幼猫", "入门", "筑基", "金丹", "元婴", "化神", "渡劫"];
  const totalExpected = hardLimit;
  const stageIndex = Math.min(Math.floor((state.age || 0) / (totalExpected / stageNames.length)), stageNames.length - 1);
  void stageIndex; // kept for future stage labels; event gating remains turn-based

  choiceLocked = false;
  $("sceneChapter").textContent = lang === "en"
    ? `Event ${lifeTurn}${timeCost === 0 ? " · same year" : ""}`
    : `事件 ${lifeTurn}${timeCost === 0 ? " · 同一年" : ""}`;
  // talent badge + fish counter
  const talentNames = (content().talents || []).filter(t => lifeTalentIds.includes(t.id)).map(t => t.name);
  const fish = state.fish ?? 0;
  $("worldMiniTitle").textContent = talentNames.length ? `${world.shortTitle} · ${talentNames.join(" / ")}` : world.shortTitle;
  const realm = lifeRealm();
  const realmLabel = lang === "en" ? realm.en : realm.label;
  const unit = content().lifespanUnit || 10;
  const ageYears = Math.round((state.age || 0) * unit);
  const lifespanYears = Math.round((state.lifespan || 0) * unit);
  $("sceneProgress").textContent = (lang === "en"
    ? `${realmLabel} · Age ${ageYears}/${lifespanYears}y`
    : `${realmLabel} · 年龄 ${ageYears}/${lifespanYears}年`) + ` · 🐟${fish}`;
  $("sceneTitle").textContent = event.title || event.event || "";
  $("sceneDescription").textContent = event.event || event.description || "";
  $("outcomePanel").hidden = true;
  $("choicePanel").hidden = false;

  const choices = maybeShuffleActions(event.choices || []);
  if (choices.length >= 2) {
    // interactive event: show choices
    $("choicePanel").innerHTML = choices.map((choice, index) => `
      <button class="choice-button${choice.cost && (state.fish || 0) < choice.cost ? " is-unaffordable" : ""}" type="button" data-life-choice="${escapeHtml(choice.id || index)}" ${choice.cost && (state.fish || 0) < choice.cost ? "disabled" : ""}>
        <span class="choice-icon">${String.fromCharCode(65 + index)}</span>
        <span><strong>${escapeHtml(choice.text)}</strong><small>${escapeHtml(choice.hint || "")}${choice.cost ? ` · ${escapeHtml(lang === "en" ? `Cost 🐟${choice.cost}` : `需要🐟${choice.cost}`)}` : ""}</small></span>
        ${choice.cost ? `<b>🐟${choice.cost}</b>` : "<b>›</b>"}
      </button>
    `).join("");
    $("choicePanel").querySelectorAll("[data-life-choice]").forEach(button => {
      button.addEventListener("click", () => {
        if (choiceLocked) return;
        choiceLocked = true;
        const choice = choices.find(c => (c.id || String(choices.indexOf(c))) === button.dataset.lifeChoice) || choices[0];
        resolveLifeChoice(event, choice);
      });
    });
  } else {
    // non-interactive event: just continue
    $("choicePanel").innerHTML = `<button class="choice-button" type="button" data-life-next>
      <span class="choice-icon">${escapeHtml(lang === "en" ? "→" : "继")}</span>
      <span><strong>${escapeHtml(lang === "en" ? "Continue" : "继续")}</strong></span>
      <b>›</b>
    </button>`;
    $("choicePanel").querySelector("[data-life-next]").addEventListener("click", () => {
      renderLifeEvent();
    });
  }

  // render image
  const image = event.image || current.lifeDefaultImage;
  if (image) {
    const img = $("sceneImage");
    img.hidden = false;
    $("sceneMissing").hidden = true;
    img.src = worldAsset(image);
    img.alt = event.event || event.title || "";
  } else {
    $("sceneImage").hidden = true;
    $("sceneMissing").hidden = false;
  }

  renderMeters();
  renderLifeProfession();
  for (const choice of event.choices || []) {
    preloadImage(choice.image);
  }
  if (choices.length < 2) queueNextLifeEvent();
}

function showLifeFinalTrial() {
  const current = content();
  const trial = current.finalTrial;
  lifeFinalTrialShown = true;
  const chanceState = trial.chanceState || "cultivation";
  const chanceValue = Math.max(0, Math.min(100, Number(state[chanceState] || 0)));
  const chancePercent = Math.round(chanceValue);
  const success = Math.random() * 100 < chanceValue;
  state.tribulationPassed = success ? 1 : 0;

  $("sceneChapter").textContent = lang === "en" ? "FINAL TRIAL" : "最终试炼";
  $("sceneTitle").textContent = lang === "en" ? trial.titleEn || trial.title : trial.title;
  $("sceneDescription").textContent = (lang === "en" ? trial.eventEn || trial.event : trial.event)
    .replace("{chance}", `${chancePercent}%`);
  $("outcomePanel").hidden = true;
  $("choicePanel").hidden = false;
  $("choicePanel").innerHTML = `
    <button class="choice-button" type="button" data-life-final-trial>
      <span class="choice-icon">${escapeHtml(lang === "en" ? "⚡" : "雷")}</span>
      <span><strong>${escapeHtml(lang === "en" ? trial.buttonEn || trial.button : trial.button)}</strong><small>${escapeHtml(lang === "en" ? `Success chance: ${chancePercent}%` : `成功率：${chancePercent}%`)}</small></span>
      <b>›</b>
    </button>
  `;
  const image = $("sceneImage");
  image.hidden = false;
  $("sceneMissing").hidden = true;
  image.src = worldAsset(trial.image);
  image.alt = trial.title;
  renderMeters();
  renderLifeProfession();

  $("choicePanel").querySelector("[data-life-final-trial]").addEventListener("click", () => {
    const resultImage = success ? trial.successImage : trial.failureImage;
    const resultText = success
      ? (lang === "en" ? trial.successEn || trial.success : trial.success)
      : (lang === "en" ? trial.failureEn || trial.failure : trial.failure);
    $("choicePanel").hidden = true;
    $("outcomePanel").hidden = false;
    $("outcomeText").textContent = resultText;
    $("outcomeMilestone").innerHTML = "";
    $("deltaChips").innerHTML = `<span>${escapeHtml(lang === "en" ? `Trial ${success ? "passed" : "failed"} · ${chancePercent}% chance` : `试炼${success ? "成功" : "失败"} · ${chancePercent}% 概率`)}</span>`;
    $("continueButton").innerHTML = `${escapeHtml(worldUi("finalContinueButton", lang === "en" ? "Continue" : "继续"))} <b>→</b>`;
    if (resultImage) {
      image.src = worldAsset(resultImage);
      image.alt = trial.title;
    }
  });
}

function lifeDeltaMarkup(effect = {}) {
  const definitions = content().states || [];
  const extras = [
    { key: "lifespan", label: lang === "en" ? "Lifespan" : "寿元", color: "#76b7cd", background: "#dff2f7" }
  ];
  const chips = [];
  if (effect.profession) {
    const definition = (content().professions || []).find(item => item.id === effect.profession);
    if (definition) chips.push(`<span class="profession-delta">${escapeHtml(lang === "en" ? "Profession" : "职业")} → ${escapeHtml(definition.label)}</span>`);
  }
  for (const definition of [...definitions, ...extras]) {
    const value = Number(effect[definition.id || definition.key] || 0);
    if (!value) continue;
    chips.push(`<span style="color:${definition.color};background:${definition.chipBackground || definition.background || '#eee'}">${definition.label} ${value > 0 ? '+' : ''}${value}</span>`);
  }
  return chips.join("");
}

function resolveLifeChoice(event, choice) {
  // check fish cost
  const cost = choice.cost || 0;
  if (cost > 0 && (state.fish || 0) < cost) {
    // not enough fish: show a message
    $("choicePanel").hidden = true;
    $("outcomePanel").hidden = false;
    $("outcomeText").textContent = lang === "en" ? "Not enough fish." : "鱼干不够。";
    $("outcomeMilestone").innerHTML = "";
    $("deltaChips").innerHTML = "";
    $("continueButton").innerHTML = `${escapeHtml(worldUi("continueButton", lang === "en" ? "Continue" : "继续"))} <b>→</b>`;
    queueNextLifeEvent();
    return;
  }
  if (cost > 0) state.fish = (state.fish || 0) - cost;
  // apply choice effects
  const appliedEffect = applyLifeEffect(choice.effect);
  if (cost > 0) appliedEffect.fish = (appliedEffect.fish || 0) - cost;
  // follow branch if present
  if (choice.branch) {
    const branchEvent = (content().events || []).find(e => e.id === choice.branch);
    if (branchEvent) {
      lifeEventHistory.push(branchEvent.id);
      applyLifeEffect(branchEvent.effect);
      // show branch as outcome
      $("choicePanel").hidden = true;
      $("outcomePanel").hidden = false;
      $("outcomeText").textContent = branchEvent.event || branchEvent.result || "";
      $("outcomeMilestone").innerHTML = milestoneMarkup(checkMilestone());
      $("deltaChips").innerHTML = lifeDeltaMarkup(appliedEffect);
      $("continueButton").innerHTML = `${escapeHtml(worldUi("continueButton", lang === "en" ? "Continue" : "继续"))} <b>→</b>`;
      renderMeters();
      if (branchEvent.image) {
        const img = $("sceneImage");
        img.hidden = false; $("sceneMissing").hidden = true;
        img.src = worldAsset(branchEvent.image);
      }
      queueNextLifeEvent();
      return;
    }
  }
  // no branch: show result and continue
  $("choicePanel").hidden = true;
  $("outcomePanel").hidden = false;
  $("outcomeText").textContent = choice.result || choice.text || "";
  $("outcomeMilestone").innerHTML = milestoneMarkup(checkMilestone());
  $("deltaChips").innerHTML = lifeDeltaMarkup(appliedEffect);
  $("continueButton").innerHTML = `${escapeHtml(worldUi("continueButton", lang === "en" ? "Continue" : "继续"))} <b>→</b>`;
  if (choice.image) {
    const img = $("sceneImage");
    img.hidden = false;
    $("sceneMissing").hidden = true;
    img.src = worldAsset(choice.image);
    img.alt = `${event.event || event.title || ""} ${choice.text || ""}`;
  }
  renderMeters();
  renderLifeProfession();
  queueNextLifeEvent();
}

/* ---------- talent selection ---------- */
function showTalentSelect() {
  const talents = content().talents || [];
  if (!talents.length) { startLifeSim(); return; }
  const shuffled = [...talents].sort(() => Math.random() - 0.5);
  const showCount = content().lifeTalentShow || 3;
  const options = shuffled.slice(0, Math.min(showCount, shuffled.length));
  const maxPicks = content().lifeTalentPicks || 1;

  showView("introView");
  $("openingFallback").hidden = true;
  $("openingImage").hidden = true;
  $("openingVideo").hidden = true;
  $("levelSelect").hidden = false;
  $("levelSelectTitle").textContent = lang === "en" ? "Choose your talent" : "选择你的天赋";
  $("beginJourney").hidden = true;

  const RARITY_LABEL = { 0: "WHITE", 1: "BLUE", 2: "PURPLE", 3: "ORANGE" };
  $("levelCards").innerHTML = options.map(talent => `
    <button class="level-card talent-card" type="button" data-talent="${escapeHtml(talent.id)}">
      <span class="talent-rarity rarity-${talent.rarity || 0}">${RARITY_LABEL[talent.rarity || 0] || "WHITE"}</span>
      <strong>${escapeHtml(talent.name)}</strong>
      <small>${escapeHtml(talent.description || "")}</small>
      <b class="talent-check">✓</b>
    </button>
  `).join("") + `
    <button id="talentConfirm" class="talent-confirm" type="button" disabled>
      ${escapeHtml(lang === "en" ? `Confirm (0/${maxPicks})` : `确认 (0/${maxPicks})`)}
    </button>
  `;

  const picked = new Set();
  const confirmBtn = $("talentConfirm");

  function updateConfirm() {
    const count = picked.size;
    confirmBtn.disabled = count !== maxPicks;
    confirmBtn.textContent = lang === "en"
      ? count >= maxPicks ? `Start Life` : `Pick ${maxPicks - count} more`
      : count >= maxPicks ? `开始猫生` : `还需选 ${maxPicks - count} 个`;
    confirmBtn.classList.toggle("is-ready", count === maxPicks);
  }

  $("levelCards").querySelectorAll("[data-talent]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.talent;
      btn.setAttribute("aria-pressed", String(picked.has(id)));
      if (picked.has(id)) {
        picked.delete(id);
        btn.classList.remove("is-selected");
      } else if (picked.size < maxPicks) {
        picked.add(id);
        btn.classList.add("is-selected");
      } else {
        // full: flash the confirm button
        confirmBtn.classList.add("is-full");
        setTimeout(() => confirmBtn.classList.remove("is-full"), 300);
      }
      updateConfirm();
    });
  });

  confirmBtn.addEventListener("click", () => {
    if (picked.size !== maxPicks) return;
    lifeTalentIds = [...picked];
    startLifeSim();
  });
}

/* ---------- life summary ---------- */
function lifeSummaryMarkup() {
  const attrs = content().states || [];
  const lines = attrs.map(def => `${def.label}: ${state[def.id] || 0}`).join(" · ");
  const unit = content().lifespanUnit || 10;
  const ageYears = Math.round((state.age || 0) * unit);
  const lifespanYears = Math.round((state.lifespan || 0) * unit);
  const turns = lang === "en" ? `${lifeTurn} events` : `${lifeTurn} 个事件`;
  const events = lang === "en"
    ? `Age ${ageYears}/${lifespanYears} years`
    : `年龄 ${ageYears}/${lifespanYears} 年`;
  const talents = (content().talents || []).filter(t => lifeTalentIds.includes(t.id)).map(t => t.name);
  const realm = lifeRealm();
  const realmLabel = lang === "en" ? realm.en : realm.label;
  const profession = lifeProfession();
  return `<div class="life-summary">
    <small>${escapeHtml(lang === "en" ? "LIFE SUMMARY" : "猫生总结")}</small>
    <p><strong>${escapeHtml(realmLabel)}</strong>${profession ? ` · ${escapeHtml(profession)}` : ""} · ${escapeHtml(lines)}</p>
    <p>${escapeHtml(turns)} · ${escapeHtml(events)}</p>
    ${talents.length ? `<p class="talent-badges">${talents.map(t => `<span>${escapeHtml(t)}</span>`).join("")}</p>` : ""}
  </div>`;
}

function renderMeters() {
  const definitions = content().states || Object.keys(state).map((id, index) => ({ id, label: id, color: index ? "#6d9e75" : "#d8654c", max: 14 }));
  // Six stats for the stray cat (strength, agility, charm, health, fish,
  // friendliness) sit as two tidy rows of three.
  const columns = Math.min(3, definitions.length);
  $("meters").style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  $("meters").innerHTML = definitions.map(definition => `
    <div class="meter" style="--meter-color:${definition.color || '#6b4bb9'}"><span><b>${definition.label}</b><em>${state[definition.id] || 0}</em></span><i><u style="width:${Math.min(100, (state[definition.id] || 0) / (definition.max || 10) * 100)}%"></u></i></div>`).join("");
}

function renderScene() {
  const current = content();
  const scene = current.scenes[sceneIndex];
  // Talents and event effects can change stats before a scene paints (for
  // example 飞檐走壁's agility +10), so always repaint the meters here.
  renderMeters();
  $("visualStage").classList.remove("is-hero");
  const actions = maybeShuffleActions(scene.actions || current.actions || []);
  choiceLocked = false;
  if (world?.id === "stray-cat") {
    const age = Math.round(state.age || 0);
    const lifespan = Math.round(state.lifespan || 60);
    const months = lang === "en" ? `${age}/${lifespan}mo` : `${age}/${lifespan}月`;
    // Kept tight on purpose: this line must not wrap onto a second row on a phone.
    // Friendliness has its own meter next to the other five stats.
    $("sceneProgress").textContent = lang === "en" ? `Event ${sceneIndex + 1}` : `第 ${sceneIndex + 1} 个事件`;
  } else {
    $("sceneProgress").textContent = `${String(sceneIndex + 1).padStart(2, "0")} / ${String(current.scenes.length).padStart(2, "0")}`;
  }
  $("sceneChapter").textContent = scene.chapter;
  $("sceneTitle").textContent = scene.title;
  $("sceneDescription").textContent = scene.description;
  const enemyStats = $("enemyStats");
  if (enemyStats) {
    if (scene.enemy) {
      const enemy = scene.enemy;
      const danger = ["cat eater", "abuser", "stray dog", "wild goose", "kid"].includes(enemy.kind);
      const label = (lang === "en" ? enemy.nameEn || enemy.name : enemy.name);
      // A cat cannot read stat sheets. Dangerous encounters only get a vague
      // impression, measured against the cat's own body — never a number, and
      // never an attribute on a human (friendliness belongs to the cat alone).
      const sizeWord = ratio => {
        if (ratio < 0.75) return lang === "en" ? "looks smaller than you" : "看起来比你小";
        if (ratio <= 1.3) return lang === "en" ? "looks about your size" : "看起来跟你差不多大";
        if (ratio <= 2.2) return lang === "en" ? "looks bigger than you" : "看起来比你大";
        return lang === "en" ? "looks much bigger than you" : "看起来比你大得多";
      };
      const speedWord = ratio => {
        if (ratio < 0.75) return lang === "en" ? "slower than you" : "跑得没你快";
        if (ratio <= 1.3) return lang === "en" ? "about as fast as you" : "和你差不多快";
        if (ratio <= 2.2) return lang === "en" ? "faster than you" : "比你快";
        return lang === "en" ? "much faster than you" : "比你快得多";
      };
      const chips = danger
        ? [
            `<span class="is-danger">${escapeHtml(sizeWord(Number(enemy.strength || 0) / Math.max(1, Number(state.strength || 0))))}</span>`,
            `<span>${escapeHtml(speedWord(Number(enemy.agility || 0) / Math.max(1, Number(state.agility || 0))))}</span>`,
          ]
        : [];
      enemyStats.hidden = false;
      enemyStats.innerHTML = `<strong>${escapeHtml(label)}</strong>${chips.join("")}`;
    } else {
      enemyStats.hidden = true;
      enemyStats.innerHTML = "";
    }
  }
  $("outcomePanel").hidden = true;
  $("choicePanel").hidden = false;
  $("choicePanel").innerHTML = actions.map(action => `
    <button class="choice-button" type="button" data-action="${action.id}">
      ${action.image ? `<span class="choice-thumb"><img src="${escapeHtml(worldAsset(action.image))}" alt=""></span>` : `<span class="choice-icon">${escapeHtml(lang === "en" ? (action.icon && /^[A-Za-z0-9]$/.test(action.icon) ? action.icon : String.fromCharCode(65 + (scene.actions || current.actions || []).indexOf(action))) : (action.icon || "✦"))}</span>`}
      <span><strong>${escapeHtml(action.name)}</strong><small>${escapeHtml(action.hint || action.plain || t("choiceFallback"))}</small></span>
      <b>›</b>
    </button>`).join("");
  $("choicePanel").querySelectorAll("button").forEach(button => {
    button.addEventListener("click", event => {
      if (choiceLocked) return;
      choiceLocked = true;
      const rect = button.getBoundingClientRect();
      button.style.setProperty("--tap-x", `${Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))}%`);
      button.style.setProperty("--tap-y", `${Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))}%`);
      button.classList.add("is-choosing");
      window.setTimeout(() => resolveChoice(button.dataset.action), 150);
    });
  });
  renderSceneImage(scene);
  preloadOutcomeImages(scene);
}

function worldAsset(relativePath) {
  return rootUrl(`${world.assetBase || `worlds/${world.id}/`}${relativePath}`);
}

/* In-app browsers and phones with a toolbar give the page a taller layout
   viewport than the area you can actually see, so a 100dvh game column gets its
   bottom button cut off. Track the real visible height instead. */
function installViewportHeightSync() {
  const sync = () => {
    const height = Math.round(window.visualViewport?.height || window.innerHeight || 0);
    if (height > 0) document.documentElement.style.setProperty("--app-vh", `${height}px`);
  };
  sync();
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  window.visualViewport?.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("scroll", sync);
}

/* Every keepsake can be turned into a real object over on jujubit: the game
   funnels there instead of integrating their API. */
const KEEPSAKE_STORE_URL = "https://studio.tripo3d.ai/";
function setKeepsakeGetLinks() {
  for (const id of ["keepsakeGet", "ksGet"]) {
    const link = $(id);
    if (link) link.href = KEEPSAKE_STORE_URL;
  }
}

function renderSceneImage(scene) {
  const image = $("sceneImage");
  const missing = $("sceneMissing");
  image.hidden = false;
  missing.hidden = true;
  image.alt = scene.description;
  image.onload = () => { missing.hidden = true; };
  image.onerror = () => {
    image.hidden = true;
    missing.hidden = false;
  };
  image.src = worldAsset(scene.image);
}

function preloadOutcomeImages(scene) {
  Object.values(scene.outcomes || {}).forEach(outcome => {
    const candidates = [outcome, ...(outcome.variants || [])];
    if (outcome.tiers) {
      for (const tier of Object.values(outcome.tiers)) {
        candidates.push(...(Array.isArray(tier) ? tier : [tier]));
      }
    }
    for (const candidate of candidates) {
      preloadImage(candidate.image);
    }
  });
}

function preloadScene(scene) {
  if (!scene) return;
  preloadImage(scene.image);
  preloadOutcomeImages(scene);
}

function firstPlayableScene() {
  if (world?.mode === "life") return null;
  const source = world?.levels?.length ? world.levels[0] : world;
  return source?.scenes?.[0] || null;
}

function preloadFirstPlayableScene() {
  if (world?.mode === "life") {
    preloadLifeEventImage(world.events?.[0]);
    return;
  }
  preloadScene(firstPlayableScene());
}

function preloadNextScene() {
  const current = content();
  const nextScene = current.scenes?.[sceneIndex + 1];
  if (!nextScene) return;
  preloadScene(nextScene);
}

function renderOutcomeImage(scene, outcome) {
  if (!outcome.image) return;
  const image = $("sceneImage");
  const missing = $("sceneMissing");
  image.hidden = false;
  missing.hidden = true;
  image.alt = `${scene.description} ${outcome.text}`;
  image.onload = () => { missing.hidden = true; };
  image.onerror = () => {
    image.hidden = true;
    missing.hidden = false;
  };
  image.src = worldAsset(outcome.image);
}

function resolveChoice(actionId) {
  const current = content();
  const scene = current.scenes[sceneIndex];
  const outcome = resolveOutcome(scene, actionId);
  recordChoice(world.id, scene.id, actionId);
  const before = { ...state };
  for (const [key, value] of Object.entries(outcome.stateChanges || {})) {
    if (typeof value === "string") {
      state[key] = value;
      continue;
    }
    state[key] = (state[key] || 0) + value;
  }
  // 鱼干抵扣：给出去的鱼干按 1:1 抵扣这次结果里的健康损失。
  // 不够也照样给，只是抵扣得少 —— 所以没有"钱不够就不能选"的情况。
  if (world?.id === "stray-cat" && outcome.fishOffset) {
    const need = Math.max(0, Number(outcome.fishOffset.need) || 0);
    const loss = Math.min(0, Number(outcome.fishOffset.health) || 0);
    const spend = Math.min(Math.max(0, Number(state.fish) || 0), need);
    if (spend > 0) state.fish = Number(state.fish || 0) - spend;
    state.health = Number(state.health || 0) + Math.min(0, loss + spend);
  }
  if (world?.id === "stray-cat") {
    // 鱼干是手里攒着的资源，输掉一场架最多把手里的都丢掉，不会变成负数。
    state.fish = Math.max(0, Number(state.fish || 0));
    state.age = Math.max(0, Number(state.age || 0) + 2);
    const health = Math.round(Number(state.health || 0));
    if (health < 0 && !state.forcedEnding) {
      // A sick cat burns through its lifeline: |health| months per month, so an
      // event covering two months at -5 health costs 10 months of the budget.
      // The -100 health of a fatal scene is not a sickness, so it is skipped.
      state.lifespan = Math.max(0, Number(state.lifespan || 0) + 2 * health);
      state.sickMonths = (Number(state.sickMonths) || 0) + 2 * Math.abs(health);
      // When the illness eats the rest of the nine lives the cat dies of it.
      if (Number(state.age || 0) >= Number(state.lifespan || 0)) state.forcedEnding = "sick";
    }
  }
  renderMeters();
  renderOutcomeImage(scene, outcome);
  $("resultFlash").hidden = false;
  $("resultFlash").classList.remove("result-flash");
  $("visualStage").classList.toggle("is-hero", outcome.impact === "hero");
  void $("resultFlash").offsetWidth;
  $("resultFlash").classList.add("result-flash");
  if (outcome.impact === "hero") {
    $("resultFlash").classList.remove("result-hero-flash");
    void $("resultFlash").offsetWidth;
    $("resultFlash").classList.add("result-hero-flash");
  }
  setTimeout(() => { $("resultFlash").hidden = true; }, 600);
  $("choicePanel").hidden = true;
  $("outcomePanel").hidden = false;
  $("outcomeText").textContent = outcome.text;
  $("outcomeMilestone").innerHTML = milestoneMarkup(checkMilestone());
  const chips = [];
  for (const definition of current.states || []) {
    // Show what actually changed (this also covers the fish-offset maths and
    // any other engine-level adjustment).
    const delta = Number(state[definition.id] || 0) - Number(before[definition.id] || 0);
    if (delta) chips.push(`<span style="color:${definition.color};background:${definition.chipBackground || '#eee'}">${definition.label} ${delta > 0 ? '+' : ''}${delta}</span>`);
  }
  if (!chips.length) chips.push(`<span>${escapeHtml(t("noChange"))}</span>`);
  $("deltaChips").innerHTML = chips.join("");
  // Adoption, forced endings, and a used-up lifespan all end the story right here,
  // so the button must promise the ending instead of another scene.
  const storyEndsHere = sceneIndex === current.scenes.length - 1
    || Boolean(state.forcedEnding)
    || (world?.id === "stray-cat" && Number(state.age || 0) >= Number(state.lifespan || 60));
  $("continueButton").innerHTML = storyEndsHere ? `${escapeHtml(worldUi("finalContinueButton", uiText.finalContinueButton))} <b>→</b>` : `${escapeHtml(worldUi("continueButton", uiText.continueButton))} <b>→</b>`;
  preloadNextScene();
}

function continueJourney() {
  if (world?.mode === "life") { renderLifeEvent(); return; }
  if (state.forcedEnding) { showEnding(); return; }
  if (world?.id === "stray-cat" && Number(state.age || 0) >= Number(state.lifespan || 60)) {
    showEnding();
    return;
  }
  if (sceneIndex >= content().scenes.length - 1) {
    showEnding();
  } else {
    sceneIndex += 1;
    renderScene();
  }
}

function compareCondition(condition) {
  if (!condition) return true;
  if (condition.profession) {
    return state.profession === condition.profession;
  }
  const left = state[condition.state] || 0;
  const right = condition.otherState ? (state[condition.otherState] || 0) + (condition.offset || 0) : condition.value;
  if (condition.operator === ">") return left > right;
  if (condition.operator === ">=") return left >= right;
  if (condition.operator === "<=") return left <= right;
  if (condition.operator === "=") return left === right;
  return left < right;
}

function endingMatches(ending) {
  if (state.forcedEnding) return ending.id === state.forcedEnding;
  return (ending.all || []).every(compareCondition);
}

function endingChance(ending) {
  const chance = ending.chance;
  if (!chance) return 1;
  const value = state[chance.state] || 0;
  const from = Number(chance.from ?? 0);
  const to = Number(chance.to ?? 100);
  const min = Math.max(0, Math.min(1, Number(chance.min ?? 0)));
  const progress = Math.max(0, Math.min(1, (value - from) / Math.max(1, to - from)));
  return min + (1 - min) * progress;
}

function chooseLifeEnding() {
  const endings = content().endings || [];
  const eligible = endings.filter(endingMatches);
  // Probabilistic endings are checked once at settlement. This keeps the late
  // game tense: Mahayana is possible, but 100 cultivation makes ascension certain.
  const luckyEnding = eligible.find(ending => ending.chance && Math.random() < endingChance(ending));
  if (luckyEnding) return luckyEnding;
  return eligible.find(ending => !ending.chance) || endings.at(-1);
}

function showEnding() {
  const ending = world?.mode === "life"
    ? chooseLifeEnding()
    : content().endings.find(endingMatches) || content().endings.at(-1);
  noteUnlock(world?.id, ending.id);
  // Endings may quote the run: {age}, {lifespan} and {fish} are filled in here.
  const fillEndingText = (text = "") => String(text)
    .replace(/\{age\}/g, String(Math.round(Number(state.age || 0))))
    .replace(/\{lifespan\}/g, String(Math.round(Number(state.lifespan || 0))))
    .replace(/\{fish\}/g, String(Math.round(Number(state.fish || 0))));
  $("endingTitle").textContent = fillEndingText(ending.title);
  $("endingDescription").textContent = fillEndingText(ending.description);
  const finalStats = $("finalStats");
  finalStats.classList.toggle("is-life", world?.mode === "life");
  finalStats.innerHTML = (content().states || []).map(definition => `<span>${definition.label} <b>${state[definition.id] || 0}</b></span>`).join("") + (world?.mode === "life" ? lifeSummaryMarkup() : "");
  const video = $("endingVideo");
  const image = $("endingImage");
  const endingVideo = ending.video || world.endingVideo;
  if (endingVideo) {
    video.src = worldAsset(endingVideo);
    video.currentTime = 0;
    video.muted = true;
    video.hidden = false;
    const replay = $("replayEndingVideo");
    if (replay) replay.hidden = false;
    image.hidden = true;
    $("endingArt").hidden = true;
    video.play().catch(() => {
      video.hidden = true;
      image.hidden = !ending.image;
      $("endingArt").hidden = Boolean(ending.image);
    });
    video.onerror = () => { video.hidden = true; image.hidden = !ending.image; $("endingArt").hidden = Boolean(ending.image); };
  } else if (ending.image) {
    video.hidden = true;
    const replayHidden = $("replayEndingVideo");
    if (replayHidden) replayHidden.hidden = true;
    image.src = worldAsset(ending.image);
    image.alt = ending.title;
    image.hidden = false;
    $("endingArt").hidden = true;
  } else {
    video.hidden = true;
    const replayGone = $("replayEndingVideo");
    if (replayGone) replayGone.hidden = true;
    image.hidden = true;
    $("endingArt").hidden = false;
  }
  const keepsake = content().keepsakes?.find(item => item.endingId === ending.id) || content().keepsakes?.[0] || world.keepsakes?.find(item => item.endingId === ending.id) || world.keepsakes?.[0];
  // The keepsake box always shows: worlds without a 3D model still offer the
  // "获得这个信物" link out to jujubit.
  $("keepsakeBox").hidden = false;
  $("keepsakeBox").classList.toggle("is-link-only", !keepsake);
  setKeepsakeGetLinks();
  recordEnding(world.id, ending.id);
  $("collectionBox").innerHTML = collectionMarkup(world.id);
  // Some endings hide a "real photo" easter egg behind a fold-out, so the
  // ending art itself stays in the drawn style.
  const realPhotos = ending.realPhotos;
  const tuntunBox = $("tuntunBox");
  if (tuntunBox) {
    tuntunBox.hidden = !realPhotos;
    // The easter egg starts unfolded, so players who never notice the summary
    // still see the real cat's photos.
    tuntunBox.open = Boolean(realPhotos);
    if (realPhotos) {
      $("tuntunImage").src = worldAsset(realPhotos.image);
      $("tuntunCaption").textContent = lang === "en" ? (realPhotos.captionEn || realPhotos.caption) : realPhotos.caption;
      tuntunBox.querySelector("summary").textContent = lang === "en" ? (realPhotos.titleEn || realPhotos.title) : realPhotos.title;
    }
  }
  showView("endingView");
  if (keepsake) {
    const glbUrl = `${worldAsset(keepsake.glb)}?v=20260928`;
    const keepsakeTitle = lang === "en" && keepsake.titleEn ? keepsake.titleEn : keepsake.title;
    $("keepsakeTitle").textContent = keepsakeTitle;
    const story = $("keepsakeStory");
    if (story) {
      const storyText = lang === "en" && keepsake.storyEn ? keepsake.storyEn : keepsake.story;
      story.textContent = storyText || "";
      story.hidden = !storyText;
    }
    const modalStory = $("ksStory");
    if (modalStory) {
      const modalStoryText = lang === "en" && keepsake.storyEn ? keepsake.storyEn : keepsake.story;
      modalStory.textContent = modalStoryText || "";
      modalStory.hidden = !modalStoryText;
    }
    const storeUrl = keepsake.meshUrl || KEEPSAKE_STORE_URL;
    const cardGet = $("keepsakeGet");
    if (cardGet) cardGet.href = storeUrl;
    const modalGet = $("ksGet");
    if (modalGet) modalGet.href = storeUrl;
    $("keepsakeDownload").href = glbUrl;
    $("ksDownload").href = glbUrl;
    const shareUrl = keepsake.shareImage ? rootUrl(keepsake.shareImage) : "";
    for (const id of ["keepsakeImage", "ksImage"]) {
      const link = $(id);
      if (!link) continue;
      if (shareUrl) {
        link.href = shareUrl;
        link.download = shareUrl.split("/").pop();
        link.hidden = false;
      } else {
        link.hidden = true;
      }
    }
    $("ksTitle").textContent = keepsakeTitle;
    const thumb = $("keepsakeThumb");
    if (keepsake.preview) { thumb.src = worldAsset(keepsake.preview); thumb.hidden = false; }
    else { thumb.removeAttribute("src"); thumb.hidden = true; }
    closeKeepsake();
  } else {
    const thumb = $("keepsakeThumb");
    thumb.removeAttribute("src");
    thumb.hidden = true;
    const story = $("keepsakeStory");
    if (story) { story.hidden = true; story.textContent = ""; }
    const modalStory = $("ksStory");
    if (modalStory) { modalStory.hidden = true; modalStory.textContent = ""; }
    closeKeepsake();
  }
}

/* ---------- 手办柜：纯前端记录（localStorage），不需要登录或后端 ---------- */
const SHELF_KEY = "glimmers-shelf-v1";

function readShelf() {
  try { return JSON.parse(localStorage.getItem(SHELF_KEY) || "{}") || {}; } catch { return {}; }
}

function noteUnlock(worldId, endingId) {
  if (!worldId || !endingId) return;
  const shelf = readShelf();
  const list = Array.isArray(shelf[worldId]) ? shelf[worldId] : [];
  if (!list.includes(endingId)) {
    list.push(endingId);
    shelf[worldId] = list;
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(shelf)); } catch {}
  }
}

function renderShelf() {
  const grid = $("shelfGrid");
  if (!grid) return;
  const keepsakes = content().keepsakes || [];
  const unlocked = new Set(readShelf()[world?.id] || []);
  grid.innerHTML = keepsakes.map((keepsake, index) => {
    const open = unlocked.has(keepsake.endingId);
    const title = lang === "en" && keepsake.titleEn ? keepsake.titleEn : keepsake.title;
    const story = lang === "en" && keepsake.storyEn ? keepsake.storyEn : keepsake.story;
    const preview = keepsake.preview ? worldAsset(keepsake.preview) : "";
    return `<article class="shelf-card${open ? "" : " is-locked"}">
      <div class="shelf-thumb">${open && preview ? `<img src="${escapeHtml(preview)}" alt="">` : "<span>?</span>"}</div>
      <div class="shelf-copy">
        <small>NO.${index + 1}</small>
        <strong>${open ? escapeHtml(title) : escapeHtml(t("shelfLocked"))}</strong>
        ${open && story ? `<em>${escapeHtml(story)}</em>` : ""}
      </div>
      ${open ? `<button class="shelf-view" type="button" data-shelf-view="${escapeHtml(keepsake.id)}">${escapeHtml(t("shelfView"))}</button>` : ""}
    </article>`;
  }).join("");
  const total = keepsakes.length;
  $("shelfCount").textContent = lang === "en" ? `${unlocked.size} / ${total} collected` : `已收集 ${unlocked.size} / ${total}`;
  grid.querySelectorAll("[data-shelf-view]").forEach(button => {
    button.addEventListener("click", () => {
      const keepsake = keepsakes.find(item => item.id === button.dataset.shelfView);
      if (keepsake) openKeepsakeFor(keepsake);
    });
  });
}

function openShelf() {
  const modal = $("shelfModal");
  if (!modal) return;
  renderShelf();
  modal.hidden = false;
  document.body.classList.add("ks-open");
}

function closeShelf() {
  const modal = $("shelfModal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("ks-open");
}

function openKeepsakeFor(keepsake) {
  const glbUrl = `${worldAsset(keepsake.glb)}?v=20260928`;
  const storeUrl = keepsake.meshUrl || KEEPSAKE_STORE_URL;
  const modalGet = $("ksGet");
  if (modalGet) modalGet.href = storeUrl;
  const keepsakeTitle = lang === "en" && keepsake.titleEn ? keepsake.titleEn : keepsake.title;
  const storyText = lang === "en" && keepsake.storyEn ? keepsake.storyEn : keepsake.story;
  $("ksTitle").textContent = keepsakeTitle;
  const story = $("ksStory");
  story.textContent = storyText || "";
  story.hidden = !storyText;
  $("ksDownload").href = glbUrl;
  const shareUrl = keepsake.shareImage ? rootUrl(keepsake.shareImage) : "";
  const imageLink = $("ksImage");
  if (imageLink) {
    if (shareUrl) { imageLink.href = shareUrl; imageLink.download = shareUrl.split("/").pop(); imageLink.hidden = false; }
    else { imageLink.hidden = true; }
  }
  openKeepsake();
}

function openKeepsake() {
  const box = $("keepsakeBox");
  if (!box || box.hidden) return;
  const modal = $("keepsakeModal");
  modal.hidden = false;
  document.body.classList.add("ks-open");
  const glb = $("ksDownload").getAttribute("href");
  window.dispatchEvent(new CustomEvent("keepsake:show", { detail: { url: glb } }));
}
function closeKeepsake() {
  const modal = $("keepsakeModal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("ks-open");
  window.dispatchEvent(new CustomEvent("keepsake:hide"));
}

function replay() {
  resetGame();
  activeLevel = null;
  showView("introView");
  renderLevelSelect();
}

async function init() {
  installViewportHeightSync();
  try {
    const directWorldId = window.__WORLD_ID__;
    if (directWorldId) {
      const explicitLang = requestedLang() || "zh";
      await bootDirectWorld(explicitLang, directWorldId);
      return;
    }

    const explicitLang = requestedLang();
    if (explicitLang) {
      await bootPlayer(explicitLang);
      return;
    }

    showView("languageView");
    // Start the slow network work while the player is still choosing a language.
    prefetchCatalogSource();
    document.querySelectorAll("[data-language-select]").forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.classList.add("is-loading");
        button.setAttribute("aria-busy", "true");
        $("languageLoading").hidden = false;
        try {
          // Paint the loading state before any network await blocks the turn.
          await nextPaint();
          // Keep the first play() inside the click's user-activation window.
          await bootPlayer(button.dataset.languageSelect);
        } catch (error) {
          showFatalError(error);
        }
      });
    });
  } catch (error) {
    showFatalError(error);
  }
}

async function bootDirectWorld(nextLang, worldId) {
  setLang(nextLang);
  labelStaticDom();
  updateSoundButtons();
  installAudioUnlock();
  await loadPlatformText();
  const configPath = `worlds/${worldId}/world.json`;
  await loadWorld(configPath);
  $("beginJourney").addEventListener("click", startJourney);
  $("continueButton").addEventListener("click", continueJourney);
  $("replayButton").addEventListener("click", replay);
  $("keepsakeOpen").addEventListener("click", openKeepsake);
  $("replayEndingVideo")?.addEventListener("click", () => {
    const video = $("endingVideo");
    if (!video || video.hidden) return;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
  document.querySelectorAll("[data-ks-close]").forEach(el => el.addEventListener("click", closeKeepsake));
  document.querySelectorAll("[data-shelf-open]").forEach(el => el.addEventListener("click", openShelf));
  $("shelfContinue")?.addEventListener("click", closeShelf);
  document.querySelectorAll("[data-shelf-close]").forEach(el => el.addEventListener("click", closeShelf));
  document.addEventListener("keydown", event => { if (event.key === "Escape") { closeKeepsake(); closeShelf(); } });
  $("soundToggle").addEventListener("click", toggleSound);
  $("textToggle")?.addEventListener("click", toggleTextBoost);
  applyTextBoost();
  document.querySelectorAll(".lang-button").forEach(button => button.addEventListener("click", async () => {
    setLang(lang === "en" ? "zh" : "en");
    await loadPlatformText();
    await loadWorld(configPath);
    enterWorld();
  }));
  document.querySelectorAll("[data-back-catalog]").forEach(button => button.addEventListener("click", goCatalog));
  enterWorld();
}

function showFatalError(error) {
  document.body.innerHTML = `<main style="max-width:480px;margin:80px auto;padding:24px;font-family:system-ui"><h1>异境暂时没有打开</h1><p>${error.message}</p></main>`;
}

async function bootPlayer(nextLang) {
  setLang(nextLang);
  labelStaticDom();
  updateSoundButtons();
  installAudioUnlock();
  // Called before any await so a language-button click can unlock audio immediately.
  setCatalogMusic();
  await loadCatalog();
  $("beginJourney").addEventListener("click", startJourney);
  $("continueButton").addEventListener("click", continueJourney);
  $("replayButton").addEventListener("click", replay);
  $("keepsakeOpen").addEventListener("click", openKeepsake);
  document.querySelectorAll("[data-ks-close]").forEach(el => el.addEventListener("click", closeKeepsake));
  document.querySelectorAll("[data-shelf-open]").forEach(el => el.addEventListener("click", openShelf));
  $("shelfContinue")?.addEventListener("click", closeShelf);
  document.querySelectorAll("[data-shelf-close]").forEach(el => el.addEventListener("click", closeShelf));
  document.addEventListener("keydown", event => { if (event.key === "Escape") { closeKeepsake(); closeShelf(); } });
  $("replayEndingVideo")?.addEventListener("click", () => {
    const video = $("endingVideo");
    if (!video || video.hidden) return;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
  $("catalogSound").addEventListener("click", toggleSound);
  $("soundToggle").addEventListener("click", toggleSound);
  $("textToggle")?.addEventListener("click", toggleTextBoost);
  applyTextBoost();
  document.querySelectorAll(".lang-button").forEach(button => button.addEventListener("click", async () => {
    setLang(lang === "en" ? "zh" : "en");
    const configPath = selectedWorldEntry?.config;
    // refresh platform copy AND world-card data for the new language, otherwise the
    // catalogue keeps showing the previous language after toggling inside a world
    await loadPlatformText();
    await loadCatalog();
    if (configPath) { await loadWorld(configPath); enterWorld(); } else { showView("catalogView"); setCatalogMusic(); }
  }));
  document.querySelectorAll("[data-back-catalog]").forEach(button => button.addEventListener("click", goCatalog));
  showView("catalogView");
  const requestedWorldId = new URLSearchParams(location.search).get("world");
  const requestedEntry = requestedWorldId && worldEntries.find(entry => entry.id === requestedWorldId);
  if (requestedEntry?.config) await enterWorldFromCatalog(requestedEntry.config);
}

init();
