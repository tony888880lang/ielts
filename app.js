import { createCloudClient } from "./cloud.js";

const XDF_URL = "https://ieltscat.xdf.cn/";
const STORAGE_KEY = "ielts-study-panel-state-v1";
const SHARED_STATE_ID = "primary";

const taskDefs = [
  {
    id: 1,
    key: "listening",
    name: "雅思听力",
    subtitle: "做题 + 精听 + 生词记录",
    duration: "45-60 分钟",
  },
  {
    id: 2,
    key: "speaking",
    name: "雅思口语",
    subtitle: "精听 + 跟读 + 背诵",
    duration: "40-50 分钟",
  },
  {
    id: 3,
    key: "reading",
    name: "雅思阅读",
    subtitle: "一篇 Passage，体验真考过程",
    duration: "35-45 分钟",
  },
  {
    id: 4,
    key: "writing",
    name: "雅思写作",
    subtitle: "做一个写作题，体验真考过程",
    duration: "30-60 分钟",
  },
];

const taskKeyById = Object.fromEntries(taskDefs.map((task) => [task.id, task.key]));

const statusLabels = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
};

const speakingSteps = [
  "完整听一遍音频，不看文本",
  "看文本理解答案内容",
  "逐句跟读 3 遍",
  "标记值得背诵的句子和表达",
  "分块背诵答案",
  "不看文本，尝试复述一遍",
];

const xdfTasks = new Set([1, 3, 4]);
const taskNameByKey = Object.fromEntries(taskDefs.map((task) => [task.key, task.name]));

let speakingMaterials = [];
let hasLocalState = localStorage.getItem(STORAGE_KEY) !== null;
let state = loadState();
let selectedTaskId = state.currentTask || 1;
let activeSentenceIndex = null;
let sentenceMonitorTimer = null;
let cloudClient = null;
let cloudReady = false;
let cloudHydrating = false;
let cloudSaveTimer = null;
let cloudStatus = "connecting";
let cloudMessage = "";
let cloudLastSynced = null;
let activeLibrary = null;
let selectedLibraryMaterialId = 1;
let editingWritingCycleId = null;
let comparisonCycleId = null;
let vocabularyFilter = "all";

const dom = {
  today: document.querySelector("#todayText"),
  cycle: document.querySelector("#cycleText"),
  progress: document.querySelector("#progressText"),
  completedCycles: document.querySelector("#completedCyclesText"),
  weeklyTasks: document.querySelector("#weeklyTasksText"),
  progressBar: document.querySelector("#cycleProgressBar"),
  taskList: document.querySelector("#taskList"),
  taskDetail: document.querySelector("#taskDetail"),
  cloud: document.querySelector("#cloudSyncPanel"),
  overlay: document.querySelector("#appOverlay"),
  reset: document.querySelector("#resetProgress"),
};

init();

async function init() {
  const response = await fetch("./data/speaking.json?v=2");
  const data = await response.json();
  speakingMaterials = data.materials;
  ensureState();
  saveLocalState(false);
  render();
  void initCloudSync();
}

function defaultState() {
  return {
    cycleId: 1,
    currentTask: 1,
    completedCycles: 0,
    tasks: initialTasks(),
    records: {},
    completedEvents: [],
    vocabularyBook: [],
    writingArchive: [],
    updatedAt: new Date().toISOString(),
  };
}

function initialTasks() {
  return {
    listening: "in_progress",
    speaking: "not_started",
    reading: "not_started",
    writing: "not_started",
  };
}

function initialCycleRecord(cycleId) {
  const speakingMaterialId = recommendedSpeakingMaterialId(cycleId);
  return {
    listening: {
      completedNote: "",
    },
    speaking: {
      materialId: speakingMaterialId,
      materialManuallySelected: false,
      customTopic: "",
      materialName: "",
      text: "",
      speed: "1",
      loop: false,
      sentenceLoop: true,
      steps: Array(speakingSteps.length).fill(false),
      localAudioName: "",
    },
    reading: {
      materialName: "",
      passageNo: "",
      totalQuestions: "",
      correctAnswers: "",
      wrongTypes: [],
      mainReason: "",
    },
    writing: {
      writingType: recommendedWritingType(cycleId),
      topic: "",
      timed: "是",
      wordCount: "",
      mainProblem: "",
      essayText: "",
      modelText: "",
    },
    vocabularyDrafts: initialVocabularyDrafts(),
  };
}

function initialVocabularyDrafts() {
  return Object.fromEntries(
    taskDefs.map((task) => [
      task.key,
      {
        word: "",
        meaning: "",
        context: "",
        source: "",
      },
    ]),
  );
}

function recommendedWritingType(cycleId) {
  const pattern = ["Task 2", "Task 1", "Task 2", "Task 1", "Task 2", "Task 2"];
  return pattern[(cycleId - 1) % pattern.length];
}

function recommendedSpeakingMaterialId(cycleId) {
  const materialCount = speakingMaterials.length || 18;
  return ((Math.max(1, Number(cycleId) || 1) - 1) % materialCount) + 1;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState(), ...JSON.parse(raw) } : defaultState();
  } catch {
    return defaultState();
  }
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  saveLocalState();
  scheduleCloudSave();
}

function saveLocalState(markAsExisting = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (markAsExisting) hasLocalState = true;
}

async function initCloudSync() {
  try {
    cloudClient = await createCloudClient();
    await syncFromCloud();
  } catch (error) {
    markCloudError(error);
  }
}

async function syncFromCloud() {
  if (!cloudClient || cloudHydrating) return;
  cloudHydrating = true;
  cloudReady = false;
  cloudStatus = "connecting";
  cloudMessage = "正在读取云端学习记录。";
  renderCloudPanel();

  try {
    const { data, error } = await cloudClient
      .from("ielts_shared_state")
      .select("state, updated_at")
      .eq("id", SHARED_STATE_ID)
      .maybeSingle();
    if (error) throw error;

    if (!data?.state || Object.keys(data.state).length === 0) {
      cloudReady = true;
      cloudHydrating = false;
      await pushCloudState();
      return;
    }

    const remoteState = { ...defaultState(), ...data.state };
    const localTime = stateTime(state.updatedAt);
    const remoteTime = stateTime(remoteState.updatedAt || data.updated_at);
    const preferRemote = !hasLocalState || remoteTime > localTime;
    const mergedVocabulary = mergeVocabularyBooks(state.vocabularyBook, remoteState.vocabularyBook);
    const mergedWritingArchive = mergeWritingArchives(
      state.writingArchive,
      remoteState.writingArchive,
    );
    const remoteVocabularyCount = Array.isArray(remoteState.vocabularyBook)
      ? remoteState.vocabularyBook.length
      : 0;
    const remoteWritingArchiveCount = Array.isArray(remoteState.writingArchive)
      ? remoteState.writingArchive.length
      : 0;

    state = {
      ...defaultState(),
      ...(preferRemote ? remoteState : state),
      vocabularyBook: mergedVocabulary,
      writingArchive: mergedWritingArchive,
    };
    const stateBeforeNormalization = JSON.stringify(state);
    ensureState();
    const stateWasNormalized = JSON.stringify(state) !== stateBeforeNormalization;
    selectedTaskId = state.currentTask;
    saveLocalState();
    render();

    cloudReady = true;
    cloudHydrating = false;
    if (
      !preferRemote ||
      stateWasNormalized ||
      mergedVocabulary.length !== remoteVocabularyCount ||
      mergedWritingArchive.length !== remoteWritingArchiveCount
    ) {
      state.updatedAt = new Date().toISOString();
      saveLocalState();
      await pushCloudState();
    } else {
      cloudStatus = "synced";
      cloudMessage = "";
      cloudLastSynced = new Date(data.updated_at || Date.now());
      renderCloudPanel();
    }
  } catch (error) {
    cloudHydrating = false;
    markCloudError(error);
  }
}

function scheduleCloudSave() {
  if (!cloudClient || !cloudReady || cloudHydrating) return;
  if (cloudSaveTimer !== null) window.clearTimeout(cloudSaveTimer);
  cloudStatus = "saving";
  cloudMessage = "";
  renderCloudPanel();
  cloudSaveTimer = window.setTimeout(() => {
    cloudSaveTimer = null;
    void pushCloudState();
  }, 700);
}

async function pushCloudState() {
  if (!cloudClient) return;
  cloudStatus = "saving";
  cloudMessage = "";
  renderCloudPanel();

  try {
    const savedAt = new Date().toISOString();
    const { error } = await cloudClient.from("ielts_shared_state").upsert(
      {
        id: SHARED_STATE_ID,
        state: JSON.parse(JSON.stringify(state)),
        updated_at: savedAt,
      },
      { onConflict: "id" },
    );
    if (error) throw error;
    cloudReady = true;
    cloudStatus = "synced";
    cloudMessage = "";
    cloudLastSynced = new Date(savedAt);
    renderCloudPanel();
  } catch (error) {
    markCloudError(error);
  }
}

function mergeVocabularyBooks(localBook, remoteBook) {
  const entries = new Map();
  [...(remoteBook || []), ...(localBook || [])].forEach((item) => {
    const key = item.id || `${item.word || ""}|${item.addedAt || ""}`;
    entries.set(key, normalizeVocabularyItem(item));
  });
  return [...entries.values()].sort((a, b) => stateTime(a.addedAt) - stateTime(b.addedAt));
}

function normalizeVocabularyItem(item) {
  const subject = item.subject || "listening";
  return {
    ...item,
    subject,
    subjectName: item.subjectName || taskNameByKey[subject] || "雅思学习",
    source: item.source || item.materialName || "",
  };
}

function mergeWritingArchives(localArchive, remoteArchive) {
  const entries = new Map();
  [...(remoteArchive || []), ...(localArchive || [])].forEach((item) => {
    const key = item.id || `cycle-${item.cycleId || ""}`;
    const current = entries.get(key);
    if (!current || stateTime(item.updatedAt || item.completedAt) >= stateTime(current.updatedAt || current.completedAt)) {
      entries.set(key, normalizeWritingArchiveEntry(item));
    }
  });
  return [...entries.values()].sort(
    (a, b) => stateTime(a.completedAt || a.updatedAt) - stateTime(b.completedAt || b.updatedAt),
  );
}

function normalizeWritingArchiveEntry(item) {
  return {
    ...item,
    essayText: item.essayText || "",
    modelText: item.modelText || "",
    legacyAttachments: item.legacyAttachments || item.attachments || null,
  };
}

function stateTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function markCloudError(error) {
  console.error("Cloud sync error", error);
  cloudReady = Boolean(cloudClient);
  cloudStatus = "error";
  cloudMessage = "云端同步暂时失败，本机副本已经保存，可以稍后重试。";
  renderCloudPanel();
}

function renderCloudPanel() {
  if (!dom.cloud) return;
  const labels = {
    connecting: "正在连接云端",
    saving: "正在保存到云端",
    synced: "云端已同步",
    error: "云端暂时不可用",
  };
  const statusClass = ["saving", "connecting"].includes(cloudStatus)
    ? cloudStatus
    : cloudStatus === "synced"
      ? "synced"
      : cloudStatus === "error"
        ? "error"
        : "local";
  const syncedText = cloudLastSynced
    ? `最近同步 ${cloudLastSynced.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : "学习记录、生词本和写作档案会自动跨设备保存";
  dom.cloud.innerHTML = `
    <div class="cloud-layout">
      <div class="cloud-copy">
        <p class="cloud-title"><span class="sync-dot ${statusClass}"></span>${escapeHtml(labels[cloudStatus] || labels.connecting)}</p>
        <p>${escapeHtml(cloudStatus === "synced" ? syncedText : cloudMessage || syncedText)}</p>
      </div>
      <div class="cloud-actions">
        <span class="cloud-mode">单用户自动同步</span>
        <button class="quiet-button" type="button" data-cloud-sync ${cloudClient ? "" : "disabled"}>立即同步</button>
      </div>
    </div>
  `;
}

function ensureState() {
  if (!state.records || typeof state.records !== "object") state.records = {};
  if (!state.completedEvents || !Array.isArray(state.completedEvents)) state.completedEvents = [];
  if (!state.vocabularyBook || !Array.isArray(state.vocabularyBook)) state.vocabularyBook = [];
  state.vocabularyBook = state.vocabularyBook.map(normalizeVocabularyItem);
  if (!state.writingArchive || !Array.isArray(state.writingArchive)) state.writingArchive = [];
  state.writingArchive = state.writingArchive.map(normalizeWritingArchiveEntry);
  hydrateWritingArchiveFromHistory();
  if (!state.tasks) state.tasks = initialTasks();
  if (!state.currentTask) state.currentTask = 1;
  if (!state.cycleId) state.cycleId = 1;
  if (!state.updatedAt) state.updatedAt = new Date().toISOString();
  ensureCycleRecord();
}

function hydrateWritingArchiveFromHistory() {
  const archivedCycles = new Set(state.writingArchive.map((item) => String(item.cycleId)));
  state.completedEvents
    .filter((event) => event.taskId === 4 && !archivedCycles.has(String(event.cycleId)))
    .forEach((event) => {
      const writing = state.records?.[String(event.cycleId)]?.writing || {};
      state.writingArchive.push({
        id: `cycle-${event.cycleId}`,
        cycleId: event.cycleId,
        writingType: writing.writingType || "",
        topic: writing.topic || "",
        timed: writing.timed || "",
        wordCount: writing.wordCount || "",
        mainProblem: writing.mainProblem || "",
        essayText: writing.essayText || "",
        modelText: writing.modelText || "",
        legacyAttachments: writing.attachments || null,
        completedAt: event.at,
        updatedAt: event.at,
      });
      archivedCycles.add(String(event.cycleId));
    });
  state.writingArchive.sort(
    (a, b) => stateTime(a.completedAt || a.updatedAt) - stateTime(b.completedAt || b.updatedAt),
  );
}

function ensureCycleRecordFor(cycleId) {
  const normalizedCycleId = Math.max(1, Number(cycleId) || 1);
  const cycleKey = String(normalizedCycleId);
  if (!state.records[cycleKey]) {
    state.records[cycleKey] = initialCycleRecord(normalizedCycleId);
  }
  const record = state.records[cycleKey];
  if (!record.listening) record.listening = initialCycleRecord(normalizedCycleId).listening;
  if (!record.speaking) record.speaking = initialCycleRecord(normalizedCycleId).speaking;
  if (!record.speaking.steps?.length) record.speaking.steps = Array(speakingSteps.length).fill(false);
  if (typeof record.speaking.sentenceLoop !== "boolean") record.speaking.sentenceLoop = true;
  if (typeof record.speaking.materialManuallySelected !== "boolean") {
    record.speaking.materialManuallySelected = false;
  }
  hydrateSpeakingDefaults(record.speaking, normalizedCycleId);
  if (!record.reading) record.reading = initialCycleRecord(normalizedCycleId).reading;
  if (!record.writing) record.writing = initialCycleRecord(normalizedCycleId).writing;
  if (!record.writing.writingType) {
    record.writing.writingType = recommendedWritingType(normalizedCycleId);
  }
  if (typeof record.writing.essayText !== "string") record.writing.essayText = "";
  if (typeof record.writing.modelText !== "string") record.writing.modelText = "";
  if (!record.vocabularyDrafts || typeof record.vocabularyDrafts !== "object") {
    record.vocabularyDrafts = initialVocabularyDrafts();
  }
  taskDefs.forEach((task) => {
    if (!record.vocabularyDrafts[task.key]) {
      record.vocabularyDrafts[task.key] = initialVocabularyDrafts()[task.key];
    }
  });
  const legacyDraft = record.listening?.vocabularyDraft;
  if (
    legacyDraft &&
    !record.vocabularyDrafts.listening.word &&
    !record.vocabularyDrafts.listening.meaning
  ) {
    record.vocabularyDrafts.listening = {
      word: legacyDraft.word || "",
      meaning: legacyDraft.meaning || "",
      context: legacyDraft.context || "",
      source: record.listening.materialName || "",
    };
  }
  return record;
}

function ensureCycleRecord() {
  return ensureCycleRecordFor(state.cycleId);
}

function hydrateSpeakingDefaults(speaking, cycleId) {
  const firstMaterial = speakingMaterials[0];
  const recommendedMaterial =
    findMaterial(recommendedSpeakingMaterialId(cycleId)) || firstMaterial;
  const usesLegacyFirstMaterial =
    Number(cycleId) > 1 &&
    speaking.materialManuallySelected !== true &&
    String(speaking.materialId) === String(firstMaterial?.id) &&
    (!speaking.materialName || speaking.materialName === firstMaterial?.displayTitle) &&
    (!speaking.text || speaking.text === firstMaterial?.passage);
  const material = usesLegacyFirstMaterial
    ? recommendedMaterial
    : findMaterial(speaking.materialId) || recommendedMaterial;
  if (!material) return;
  if (!speaking.materialId || usesLegacyFirstMaterial) speaking.materialId = material.id;
  if (!speaking.materialName || usesLegacyFirstMaterial) speaking.materialName = material.displayTitle;
  if (!speaking.text || usesLegacyFirstMaterial) speaking.text = material.passage;
}

function currentCycleRecord() {
  return ensureCycleRecord();
}

function currentTaskDef() {
  return taskDefs.find((task) => task.id === state.currentTask) || taskDefs[0];
}

function selectedTaskDef() {
  return taskDefs.find((task) => task.id === selectedTaskId) || currentTaskDef();
}

function findMaterial(id) {
  return speakingMaterials.find((material) => String(material.id) === String(id));
}

function writingTextsReady(writing = currentCycleRecord().writing) {
  return Boolean(writing.essayText?.trim() && writing.modelText?.trim());
}

function taskCanComplete(taskId) {
  if (taskId !== state.currentTask || state.tasks[taskKeyById[taskId]] !== "in_progress") {
    return false;
  }
  return taskId !== 4 || writingTextsReady();
}

function render() {
  stopSentenceMonitor();
  activeSentenceIndex = null;
  renderStatus();
  renderTasks();
  renderDetail();
  renderCloudPanel();
  renderOverlay();
  syncAudioSettings();
  resizeTallTextareas();
}

function renderStatus() {
  const today = new Date();
  const task = currentTaskDef();
  const completedInCycle = taskDefs.filter((item) => state.tasks[item.key] === "completed").length;
  const progressPercent = (completedInCycle / taskDefs.length) * 100;

  dom.today.textContent = today.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  dom.cycle.textContent = `第 ${state.cycleId} 个小循环`;
  dom.progress.textContent = `任务 ${state.currentTask} / 4：${task.name}`;
  dom.completedCycles.textContent = `${state.completedCycles || 0} 个`;
  dom.weeklyTasks.textContent = `${weeklyTaskCount()} 项`;
  dom.progressBar.style.width = `${progressPercent}%`;
}

function weeklyTaskCount() {
  const start = startOfWeek(new Date()).getTime();
  return state.completedEvents.filter((event) => {
    const time = new Date(event.at).getTime();
    return Number.isFinite(time) && time >= start;
  }).length;
}

function startOfWeek(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function renderTasks() {
  dom.taskList.innerHTML = taskDefs
    .map((task) => {
      const status = state.tasks[task.key] || "not_started";
      const selected = selectedTaskId === task.id ? "is-selected" : "";
      const current = state.currentTask === task.id ? "is-current" : "";
      const completed = status === "completed" ? "is-completed" : "";
      const isCurrent = state.currentTask === task.id;
      const isCompleted = status === "completed";
      const canComplete = taskCanComplete(task.id);
      const waitingForWritingTexts = task.id === 4 && isCurrent && !writingTextsReady();
      return `
        <article class="task-card ${selected} ${current} ${completed}" data-select-task="${task.id}" tabindex="0">
          <div class="task-card-header">
            <span class="task-index">${task.id}</span>
            <div class="task-main">
              <h3>${escapeHtml(task.name)}</h3>
              <p>${escapeHtml(task.subtitle)}</p>
            </div>
            <span class="status-pill ${status}">${escapeHtml(statusLabels[status])}</span>
          </div>
          <div class="task-footer">
            <span class="duration">${escapeHtml(task.duration)}</span>
            <button class="mini-button" type="button" data-complete-task="${task.id}" ${canComplete ? "" : "disabled"}>
              ${isCompleted ? "已完成" : waitingForWritingTexts ? "待粘贴" : isCurrent ? "完成" : "等待"}
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderDetail() {
  const task = selectedTaskDef();
  const status = state.tasks[task.key] || "not_started";
  const canComplete = taskCanComplete(task.id);
  const locked = state.currentTask !== task.id && status !== "completed";
  const external = xdfTasks.has(task.id) ? renderXdfCallout() : "";
  const body = {
    1: renderListening,
    2: renderSpeaking,
    3: renderReading,
    4: renderWriting,
  }[task.id]();

  dom.taskDetail.innerHTML = `
    <div class="detail-title">
      <div>
        <p class="eyebrow">TASK ${task.id}</p>
        <h2>${escapeHtml(task.name)}</h2>
        <p>${escapeHtml(task.subtitle)}｜${escapeHtml(task.duration)}</p>
      </div>
      <span class="status-pill ${status}">${escapeHtml(statusLabels[status])}</span>
    </div>
    <div class="detail-stack">
      ${locked ? `<p class="task-lock">当前应先完成任务 ${state.currentTask}：${escapeHtml(currentTaskDef().name)}</p>` : ""}
      ${external}
      ${body}
      <div class="detail-actions">
        <p class="note">${completionNote(task.id, status)}</p>
        <button class="solid-button" type="button" data-complete-task="${task.id}" ${canComplete ? "" : "disabled"}>
          完成${escapeHtml(task.name)}任务
        </button>
      </div>
    </div>
  `;
}

function completionNote(taskId, status) {
  if (status === "completed") return "这个任务已在当前循环完成。";
  if (taskId === 4 && !writingTextsReady()) {
    return "粘贴“我的作文”和“范文”后，才能完成并自动生成对比档案。";
  }
  return "完成后会自动进入下一项任务。";
}

function renderXdfCallout() {
  return `
    <div class="xdf-callout">
      <div>
        <strong>新东方雅思学习网站</strong>
        <span>听力、阅读、写作任务可从这里进入学习。</span>
      </div>
      <a class="primary-link" href="${XDF_URL}" target="_blank" rel="noreferrer">打开网站</a>
    </div>
  `;
}

function renderListening() {
  return `
    <section class="section-block">
      <h3>学习步骤</h3>
      ${numberedSteps([
        "找一套雅思听力 Section 3 或 Section 4。",
        "按真考方式先完整做题，只听一遍。",
        "对答案，记录正确题数。",
        "对错误题和没听清的部分做逐句精听。",
        "精听过程中记录生词、短语、同义替换。",
        "最后重新听一遍，确认能听懂主要内容。",
      ])}
    </section>
    ${renderVocabularyCapture("listening")}
  `;
}

function renderSpeaking() {
  const rec = currentCycleRecord().speaking;
  const material = findMaterial(rec.materialId) || speakingMaterials[0];
  const expressionList = material?.expressions || [];
  const replacements = material?.replacements || [];
  const sentences = material?.sentences || [];
  return `
    <section class="section-block">
      <h3>口语材料</h3>
      <div class="form-grid">
        <label class="field">
          <span>今日口语主题</span>
          <select data-speaking-material>
            ${speakingMaterials
              .map(
                (item) =>
                  `<option value="${item.id}" ${String(item.id) === String(rec.materialId) ? "selected" : ""}>${escapeHtml(item.displayTitle)}</option>`,
              )
              .join("")}
          </select>
        </label>
        ${inputField("speaking.customTopic", "自定义主题", rec.customTopic)}
        ${inputField("speaking.materialName", "材料名称", rec.materialName)}
      </div>
    </section>

    <section class="section-block">
      <h3>MP3 播放器</h3>
      <div class="audio-box">
        <audio id="speakingAudio" controls preload="metadata" src="${escapeAttr(material?.audio || "")}"></audio>
        <div class="audio-tools">
          <button class="quiet-button" type="button" data-play-full>播放整篇</button>
          <button class="quiet-button" type="button" data-audio-jump="-5">后退 5 秒</button>
          <button class="quiet-button" type="button" data-audio-jump="5">前进 5 秒</button>
          <label class="field">
            <span>倍速</span>
            <select data-audio-speed>
              ${["0.75", "1", "1.25", "1.5"]
                .map((speed) => `<option value="${speed}" ${rec.speed === speed ? "selected" : ""}>${speed}x</option>`)
                .join("")}
            </select>
          </label>
          <label class="check-row">
            <input type="checkbox" data-audio-loop ${rec.loop ? "checked" : ""} />
            <span>整篇循环</span>
          </label>
        </div>
      </div>
    </section>

    <section class="section-block">
      <div class="section-heading-row sentence-heading">
        <div>
          <h3>逐句精听与背诵</h3>
          <p class="note" id="sentenceStatus">点击任意句子开始播放。</p>
        </div>
        <label class="check-row">
          <input type="checkbox" data-sentence-loop ${rec.sentenceLoop ? "checked" : ""} />
          <span>单句循环</span>
        </label>
      </div>
      <div class="sentence-navigation">
        <button class="quiet-button" type="button" data-sentence-nav="-1">上一句</button>
        <button class="quiet-button" type="button" data-sentence-nav="1">下一句</button>
      </div>
      <div class="sentence-list">
        ${sentences
          .map(
            (sentence, index) => `
              <button class="sentence-row" type="button" data-play-sentence="${index}" aria-pressed="false">
                <span class="sentence-number">${String(index + 1).padStart(2, "0")}</span>
                <span class="sentence-text">${escapeHtml(sentence.text)}</span>
                <span class="sentence-action">播放</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>

    <section class="section-block">
      <h3>完整文本</h3>
      <div class="form-grid speaking-text-panel">
        ${textareaField("speaking.text", "口语答案文本", rec.text, true)}
      </div>
    </section>

    <section class="section-block">
      <h3>训练步骤</h3>
      <div class="check-list">
        ${speakingSteps
          .map(
            (step, index) => `
              <label class="check-row">
                <input type="checkbox" data-speaking-step="${index}" ${rec.steps[index] ? "checked" : ""} />
                <span>Step ${index + 1}：${escapeHtml(step)}</span>
              </label>
            `,
          )
          .join("")}
      </div>
    </section>

    <section class="section-block">
      <h3>本篇必背表达</h3>
      <div class="chip-list">
        ${expressionList.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}
      </div>
    </section>

    <section class="section-block">
      <h3>替换练习</h3>
      <ul class="material-list">
        ${replacements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>
    ${renderVocabularyCapture("speaking", material?.displayTitle || "")}
  `;
}

function renderReading() {
  return `
    <section class="section-block">
      <h3>学习步骤</h3>
      ${numberedSteps([
        "找一篇雅思阅读 Passage。",
        "设置 20 分钟计时。",
        "按真实考试方式完成题目，不查词。",
        "对答案，记录正确题数。",
        "只分析错题。",
        "记录错因和同义替换。",
      ])}
    </section>
    ${renderVocabularyCapture("reading")}
  `;
}

function renderWriting() {
  const rec = currentCycleRecord().writing;
  return `
    <section class="section-block">
      <h3>推荐节奏</h3>
      <p class="note">当前循环建议：${escapeHtml(recommendedWritingType(state.cycleId))}</p>
    </section>
    <section class="section-block">
      <h3>学习步骤</h3>
      ${numberedSteps([
        "找一个雅思写作题。",
        "Task 1 限时 20 分钟，150 词以上。",
        "Task 2 限时 40 分钟，250 词以上。",
        "不查资料，按真实考试状态完成。",
        "写完后通读全文，记录最值得改进的问题。",
        "记录本次最大问题。",
      ])}
    </section>
    <section class="section-block">
      <h3>写作记录</h3>
      <div class="form-grid">
        ${selectField("writing.writingType", "写作类型", rec.writingType, ["Task 1", "Task 2"])}
        ${inputField("writing.wordCount", "字数", rec.wordCount, "number")}
        ${textareaField("writing.topic", "题目", rec.topic, false)}
        ${selectField("writing.timed", "是否限时完成", rec.timed, ["是", "否"])}
        ${textareaField("writing.mainProblem", "本次最大问题", rec.mainProblem, false)}
      </div>
    </section>
    <section class="section-block">
      <div class="section-heading-row writing-text-heading">
        <div>
          <h3>作文文本</h3>
          <p class="note">直接粘贴两篇文章，完成后自动生成对比学习页面。</p>
        </div>
        <div class="heading-actions">
          <button
            class="solid-button"
            type="button"
            data-open-writing-comparison="${state.cycleId}"
            ${writingTextsReady(rec) ? "" : "disabled"}
          >预览对比学习</button>
          <button class="quiet-button" type="button" data-open-library="writing">
            查看写作档案（${state.writingArchive.length}）
          </button>
        </div>
      </div>
      <div class="writing-text-grid">
        <label class="field">
          <span>我的作文</span>
          <textarea class="writing-essay-text" data-field="writing.essayText" placeholder="把你的作文全文粘贴到这里…">${escapeHtml(rec.essayText)}</textarea>
        </label>
        <label class="field">
          <span>范文</span>
          <textarea class="writing-essay-text" data-field="writing.modelText" placeholder="把范文全文粘贴到这里…">${escapeHtml(rec.modelText)}</textarea>
        </label>
      </div>
    </section>
    ${renderVocabularyCapture("writing", rec.topic)}
  `;
}

function renderVocabularyCapture(subject, suggestedSource = "") {
  const draft = currentCycleRecord().vocabularyDrafts[subject];
  const taskName = taskNameByKey[subject] || "雅思学习";
  const sourceValue = draft.source || suggestedSource;
  return `
    <section class="section-block vocabulary-capture">
      <div class="section-heading-row">
        <div>
          <h3>记录生词</h3>
          <p class="note">本条会标记为“${escapeHtml(taskName)}”，并进入统一生词本。</p>
        </div>
        <button class="quiet-button" type="button" data-open-library="vocabulary">
          查看生词本（${state.vocabularyBook.length}）
        </button>
      </div>
      <form class="vocabulary-form" data-vocabulary-form="${subject}">
        <label class="field">
          <span>生词 / 短语</span>
          <input
            value="${escapeAttr(draft.word)}"
            data-vocabulary-subject="${subject}"
            data-vocabulary-field="word"
            required
          />
        </label>
        <label class="field">
          <span>中文释义</span>
          <input
            value="${escapeAttr(draft.meaning)}"
            data-vocabulary-subject="${subject}"
            data-vocabulary-field="meaning"
            required
          />
        </label>
        <label class="field">
          <span>来源（选填）</span>
          <input
            value="${escapeAttr(sourceValue)}"
            data-vocabulary-subject="${subject}"
            data-vocabulary-field="source"
          />
        </label>
        <label class="field vocabulary-context">
          <span>原句 / 语境（选填）</span>
          <textarea
            data-vocabulary-subject="${subject}"
            data-vocabulary-field="context"
          >${escapeHtml(draft.context)}</textarea>
        </label>
        <button class="solid-button vocabulary-add" type="submit">加入统一生词本</button>
      </form>
    </section>
  `;
}

function renderVocabularyLibrary() {
  const filters = [
    ["all", "全部"],
    ...taskDefs.map((task) => [task.key, task.name.replace("雅思", "")]),
  ];
  const entries =
    vocabularyFilter === "all"
      ? state.vocabularyBook
      : state.vocabularyBook.filter((item) => item.subject === vocabularyFilter);
  return `
    <div class="vocabulary-library">
      <div class="vocabulary-toolbar">
        <div class="filter-tabs" aria-label="按科目筛选生词">
          ${filters
            .map(
              ([key, label]) => `
                <button
                  class="filter-tab ${vocabularyFilter === key ? "is-active" : ""}"
                  type="button"
                  data-vocabulary-filter="${key}"
                >${escapeHtml(label)}</button>
              `,
            )
            .join("")}
        </div>
        <button class="quiet-button" type="button" data-export-vocabulary ${state.vocabularyBook.length ? "" : "disabled"}>
          下载 CSV
        </button>
      </div>
      <p class="note">当前显示 ${entries.length} 条，共记录 ${state.vocabularyBook.length} 条。</p>
      ${renderVocabularyBook(entries)}
    </div>
  `;
}

function renderVocabularyBook(entries = state.vocabularyBook) {
  if (!entries.length) {
    return `<p class="empty-state">这个分类还没有生词。</p>`;
  }
  return `
    <div class="vocabulary-list">
      ${[...entries]
        .reverse()
        .map(
          (item) => `
            <article class="vocabulary-item">
              <div class="vocabulary-word">
                <strong>${escapeHtml(item.word)}</strong>
                <span>${escapeHtml(item.meaning)}</span>
              </div>
              ${item.context ? `<p>${escapeHtml(item.context)}</p>` : ""}
              <div class="vocabulary-meta">
                <span class="subject-badge ${escapeAttr(item.subject)}">${escapeHtml(item.subjectName)}</span>
                <span>第 ${escapeHtml(item.cycleId || "?")} 循环</span>
                <span>${escapeHtml(formatVocabularyDate(item.addedAt))}</span>
                ${item.source ? `<span>${escapeHtml(item.source)}</span>` : ""}
              </div>
              <button
                class="icon-delete"
                type="button"
                data-remove-vocabulary="${escapeAttr(item.id)}"
                aria-label="删除 ${escapeAttr(item.word)}"
                title="删除这条生词"
              >×</button>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderOverlay() {
  if (!dom.overlay) return;
  if (!activeLibrary) {
    dom.overlay.classList.add("hidden");
    dom.overlay.innerHTML = "";
    document.body.classList.remove("overlay-open");
    return;
  }

  const overlayViews = {
    speaking: {
      label: "口语材料库",
      eyebrow: "SPEAKING LIBRARY",
      title: "口语材料库",
      subtitle: "18 篇短文、音频和重点表达集中浏览。",
      body: renderSpeakingLibrary,
    },
    writing: {
      label: "写作档案",
      eyebrow: "WRITING ARCHIVE",
      title: "写作档案",
      subtitle: `已归档 ${state.writingArchive.length} 次写作记录。`,
      body: renderWritingArchive,
    },
    vocabulary: {
      label: "统一生词本",
      eyebrow: "VOCABULARY BOOK",
      title: "统一生词本",
      subtitle: `听、说、读、写共记录 ${state.vocabularyBook.length} 条生词。`,
      body: renderVocabularyLibrary,
    },
    "writing-cycle": {
      label: "历史写作补录",
      eyebrow: "WRITING HISTORY",
      title: `第 ${editingWritingCycleId || "?"} 个循环`,
      subtitle: "补录或修改历史写作，不会改变当前循环进度。",
      body: renderWritingCycleEditor,
    },
    comparison: {
      label: "写作对比学习",
      eyebrow: "WRITING COMPARISON",
      title: `第 ${comparisonCycleId || "?"} 个循环对比`,
      subtitle: "对照你的作文与范文，集中查看可借鉴的词汇、表达和句型。",
      body: renderWritingComparison,
    },
  };
  const view = overlayViews[activeLibrary] || overlayViews.writing;

  dom.overlay.classList.remove("hidden");
  document.body.classList.add("overlay-open");
  dom.overlay.innerHTML = `
    <div class="overlay-backdrop" data-close-library></div>
    <section class="library-dialog" role="dialog" aria-modal="true" aria-label="${escapeAttr(view.label)}">
      <header class="library-header">
        <div>
          <p class="eyebrow">${escapeHtml(view.eyebrow)}</p>
          <h2>${escapeHtml(view.title)}</h2>
          <p>${escapeHtml(view.subtitle)}</p>
        </div>
        <button class="overlay-close" type="button" data-close-library aria-label="关闭资料库">×</button>
      </header>
      <div class="library-body">
        ${view.body()}
      </div>
    </section>
  `;
}

function renderSpeakingLibrary() {
  const material = findMaterial(selectedLibraryMaterialId) || speakingMaterials[0];
  if (!material) return `<p class="empty-state">口语材料暂时不可用。</p>`;
  return `
    <div class="speaking-library-layout">
      <nav class="speaking-library-list" aria-label="18 篇口语材料">
        ${speakingMaterials
          .map(
            (item) => `
              <button
                class="library-list-item ${String(item.id) === String(material.id) ? "is-active" : ""}"
                type="button"
                data-library-material="${item.id}"
              >
                <span>${String(item.id).padStart(2, "0")}</span>
                <strong>${escapeHtml(item.title)}</strong>
              </button>
            `,
          )
          .join("")}
      </nav>
      <article class="speaking-library-detail">
        <div class="library-detail-title">
          <div>
            <p class="eyebrow">MATERIAL ${String(material.id).padStart(2, "0")}</p>
            <h3>${escapeHtml(material.displayTitle)}</h3>
          </div>
          <button class="solid-button" type="button" data-use-library-material="${material.id}">
            设为当前循环材料
          </button>
        </div>
        <audio controls preload="metadata" src="${escapeAttr(material.audio)}"></audio>
        <section class="library-content-section">
          <h4>背诵短文</h4>
          <div class="passage-card">${escapeHtml(material.passage)}</div>
        </section>
        <section class="library-content-section">
          <h4>必背表达</h4>
          <div class="chip-list">
            ${(material.expressions || []).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}
          </div>
        </section>
        <section class="library-content-section">
          <h4>替换练习</h4>
          <ul class="material-list">
            ${(material.replacements || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </section>
      </article>
    </div>
  `;
}

function renderWritingArchive() {
  if (!state.writingArchive.length) {
    return `
      <div class="empty-state archive-empty">
        <strong>还没有写作档案</strong>
        <span>完成写作任务后会自动归档；也可以从这里回到历史循环补录文章。</span>
      </div>
    `;
  }

  return `
    <div class="writing-archive-list">
      ${[...state.writingArchive]
        .reverse()
        .map(renderWritingArchiveEntry)
        .join("")}
    </div>
  `;
}

function renderWritingArchiveEntry(entry) {
  const ready = writingTextsReady(entry);
  return `
    <article class="writing-archive-card">
      <div class="archive-card-heading">
        <div>
          <span>第 ${escapeHtml(entry.cycleId)} 个循环 · ${escapeHtml(entry.writingType || "未标记类型")}</span>
          <h3>${escapeHtml(entry.topic || "未填写写作题目")}</h3>
        </div>
        <time>${escapeHtml(formatArchiveDate(entry.completedAt))}</time>
      </div>
      <div class="archive-meta">
        <span>${entry.timed === "是" ? "限时完成" : "未限时"}</span>
        <span>${entry.wordCount ? `${escapeHtml(entry.wordCount)} 词` : "未记录字数"}</span>
      </div>
      ${entry.mainProblem ? `<p class="archive-problem"><strong>本次最大问题：</strong>${escapeHtml(entry.mainProblem)}</p>` : ""}
      <div class="archive-text-status ${ready ? "is-ready" : "is-missing"}">
        <strong>${ready ? "作文与范文已保存" : "等待补录作文文本"}</strong>
        <span>${ready ? "可以打开对比学习页。" : "进入这个循环，粘贴你的作文和范文后即可生成对比。"}</span>
      </div>
      <div class="archive-actions">
        <button class="quiet-button" type="button" data-edit-writing-cycle="${escapeAttr(entry.cycleId)}">
          ${ready ? "编辑此循环" : "回到此循环补录"}
        </button>
        <button
          class="solid-button"
          type="button"
          data-open-writing-comparison="${escapeAttr(entry.cycleId)}"
          ${ready ? "" : "disabled"}
        >打开对比学习</button>
      </div>
      ${renderLegacyWritingFiles(entry.legacyAttachments)}
    </article>
  `;
}

function renderLegacyWritingFiles(attachments) {
  const files = [
    ["旧版作文文件", attachments?.essay],
    ["旧版范文文件", attachments?.model],
  ].filter(([, attachment]) => attachment?.url);
  if (!files.length) return "";
  return `
    <div class="legacy-writing-files">
      ${files
        .map(
          ([label, attachment]) => `
            <a href="${escapeAttr(attachment.url)}" target="_blank" rel="noreferrer">
              ${escapeHtml(label)}：${escapeHtml(attachment.name || "查看文件")}
            </a>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderWritingCycleEditor() {
  const cycleId = Math.max(1, Number(editingWritingCycleId) || 1);
  const writing = ensureCycleRecordFor(cycleId).writing;
  return `
    <div class="history-writing-editor">
      <div class="history-editor-toolbar">
        <button class="quiet-button" type="button" data-back-writing-archive>← 返回写作档案</button>
        <span>所有修改都会自动同步到云端</span>
      </div>
      <section class="section-block">
        <h3>写作记录</h3>
        <div class="form-grid">
          ${historySelectField(cycleId, "writingType", "写作类型", writing.writingType, ["Task 1", "Task 2"])}
          ${historyInputField(cycleId, "wordCount", "字数", writing.wordCount, "number")}
          ${historyTextareaField(cycleId, "topic", "题目", writing.topic)}
          ${historySelectField(cycleId, "timed", "是否限时完成", writing.timed, ["是", "否"])}
          ${historyTextareaField(cycleId, "mainProblem", "本次最大问题", writing.mainProblem)}
        </div>
      </section>
      <section class="section-block">
        <div class="section-heading-row">
          <div>
            <h3>补录作文文本</h3>
            <p class="note">直接粘贴全文，不需要上传文件。</p>
          </div>
          <button
            class="solid-button"
            type="button"
            data-open-writing-comparison="${cycleId}"
            ${writingTextsReady(writing) ? "" : "disabled"}
          >打开对比学习</button>
        </div>
        <div class="writing-text-grid">
          ${historyEssayField(cycleId, "essayText", "我的作文", writing.essayText)}
          ${historyEssayField(cycleId, "modelText", "范文", writing.modelText)}
        </div>
      </section>
    </div>
  `;
}

function historyInputField(cycleId, key, label, value, type = "text") {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input
        type="${escapeAttr(type)}"
        value="${escapeAttr(value)}"
        data-history-writing-cycle="${cycleId}"
        data-history-writing-field="${escapeAttr(key)}"
      />
    </label>
  `;
}

function historySelectField(cycleId, key, label, value, options) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <select data-history-writing-cycle="${cycleId}" data-history-writing-field="${escapeAttr(key)}">
        ${options
          .map(
            (option) => `
              <option value="${escapeAttr(option)}" ${option === value ? "selected" : ""}>
                ${escapeHtml(option)}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

function historyTextareaField(cycleId, key, label, value) {
  return `
    <label class="field full">
      <span>${escapeHtml(label)}</span>
      <textarea
        data-history-writing-cycle="${cycleId}"
        data-history-writing-field="${escapeAttr(key)}"
      >${escapeHtml(value)}</textarea>
    </label>
  `;
}

function historyEssayField(cycleId, key, label, value) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <textarea
        class="writing-essay-text"
        data-history-writing-cycle="${cycleId}"
        data-history-writing-field="${escapeAttr(key)}"
        placeholder="把${escapeAttr(label)}全文粘贴到这里…"
      >${escapeHtml(value)}</textarea>
    </label>
  `;
}

function renderWritingComparison() {
  const cycleId = Math.max(1, Number(comparisonCycleId) || 1);
  const writing = ensureCycleRecordFor(cycleId).writing;
  if (!writingTextsReady(writing)) {
    return `
      <div class="empty-state archive-empty">
        <strong>还不能生成对比</strong>
        <span>请先补齐这个循环的“我的作文”和“范文”。</span>
        <button class="solid-button" type="button" data-edit-writing-cycle="${cycleId}">去补录</button>
      </div>
    `;
  }
  const insights = analyzeWritingComparison(writing.essayText, writing.modelText);
  const highlights = [...insights.phrases, ...insights.vocabulary];
  return `
    <div class="writing-comparison">
      <div class="history-editor-toolbar">
        <button class="quiet-button" type="button" data-back-writing-archive>← 返回写作档案</button>
        <button class="quiet-button" type="button" data-edit-writing-cycle="${cycleId}">编辑本循环</button>
      </div>
      <section class="comparison-summary">
        <div><strong>${countEnglishWords(writing.essayText)}</strong><span>我的作文字数</span></div>
        <div><strong>${countEnglishWords(writing.modelText)}</strong><span>范文字数</span></div>
        <div><strong>${insights.vocabulary.length}</strong><span>可学习词汇</span></div>
        <div><strong>${insights.patterns.length}</strong><span>句型观察</span></div>
      </section>
      <section class="comparison-insights">
        ${renderInsightTerms("值得学习的词汇", "范文使用、而你的文章尚未使用的较有信息量词汇。", insights.vocabulary)}
        ${renderInsightTerms("可借鉴的连接与表达", "可用于组织论证、对比、让步或总结的表达。", insights.phrases)}
        ${renderSentencePatterns(insights.patterns)}
      </section>
      <section class="essay-comparison-grid">
        <article class="essay-panel">
          <div class="essay-panel-heading">
            <h3>我的作文</h3>
            <span>原文</span>
          </div>
          <div class="essay-copy">${escapeHtml(writing.essayText)}</div>
        </article>
        <article class="essay-panel model">
          <div class="essay-panel-heading">
            <h3>范文</h3>
            <span>重点已高亮</span>
          </div>
          <div class="essay-copy">${highlightEnglishText(writing.modelText, highlights)}</div>
        </article>
      </section>
    </div>
  `;
}

function renderInsightTerms(title, description, items) {
  return `
    <article class="insight-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
      ${
        items.length
          ? `<div class="insight-terms">${items.map((item) => `<mark>${escapeHtml(item)}</mark>`).join("")}</div>`
          : `<span class="muted-copy">暂未发现明显差异。</span>`
      }
    </article>
  `;
}

function renderSentencePatterns(patterns) {
  return `
    <article class="insight-card sentence-pattern-card">
      <h3>句型观察</h3>
      <p>从范文中抽取的典型复杂句或论证结构。</p>
      ${
        patterns.length
          ? `<ul>${patterns
              .map(
                (item) => `
                  <li>
                    <strong>${escapeHtml(item.label)}</strong>
                    <span>${escapeHtml(item.sentence)}</span>
                  </li>
                `,
              )
              .join("")}</ul>`
          : `<span class="muted-copy">暂未识别到预设句型。</span>`
      }
    </article>
  `;
}

function analyzeWritingComparison(essayText, modelText) {
  const stopWords = new Set(
    "about after again against also among because been before being between both could does doing during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under very what when where which while will with would your".split(
      " ",
    ),
  );
  const essayWords = new Set(extractEnglishWords(essayText).map((word) => word.toLowerCase()));
  const modelWords = extractEnglishWords(modelText).map((word) => word.toLowerCase());
  const counts = new Map();
  modelWords.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  const vocabulary = [...counts]
    .filter(
      ([word]) =>
        word.length >= 6 &&
        !stopWords.has(word) &&
        !essayWords.has(word) &&
        !/^\d+$/.test(word),
    )
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, 18)
    .map(([word]) => word);

  const phraseCandidates = [
    "as a result",
    "as a consequence",
    "on the other hand",
    "in contrast",
    "by contrast",
    "for instance",
    "for example",
    "in addition",
    "more importantly",
    "to a large extent",
    "it is clear that",
    "there is no doubt that",
    "not only",
    "but also",
    "even though",
    "rather than",
    "in terms of",
    "with regard to",
    "plays a crucial role",
    "has a significant impact",
  ];
  const lowerEssay = essayText.toLowerCase();
  const lowerModel = modelText.toLowerCase();
  const phrases = phraseCandidates
    .filter((phrase) => lowerModel.includes(phrase) && !lowerEssay.includes(phrase))
    .slice(0, 12);

  const patternDefs = [
    ["让步结构", /\b(?:although|even though|while)\b/i],
    ["转折对比", /\b(?:however|in contrast|on the other hand|whereas)\b/i],
    ["因果结果", /\b(?:therefore|consequently|as a result|as a consequence)\b/i],
    ["递进结构", /\bnot only\b.+\bbut also\b/i],
    ["条件句", /\bif\b.+\b(?:would|could|will|can)\b/i],
    ["强调结构", /\bit is\b.+\bthat\b/i],
    ["定语从句", /,\s*(?:which|who)\b/i],
  ];
  const sentences = splitEnglishSentences(modelText);
  const patterns = patternDefs
    .map(([label, pattern]) => {
      const sentence = sentences.find((item) => pattern.test(item));
      return sentence ? { label, sentence } : null;
    })
    .filter(Boolean)
    .slice(0, 6);
  return { vocabulary, phrases, patterns };
}

function extractEnglishWords(text) {
  return String(text || "").match(/[A-Za-z]+(?:['’-][A-Za-z]+)?/g) || [];
}

function countEnglishWords(text) {
  return extractEnglishWords(text).length;
}

function splitEnglishSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function highlightEnglishText(text, terms) {
  const uniqueTerms = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!uniqueTerms.length) return escapeHtml(text);
  const pattern = new RegExp(
    `\\b(${uniqueTerms.map((term) => escapeRegExp(term)).join("|")})\\b`,
    "gi",
  );
  return String(text)
    .split(pattern)
    .map((part) =>
      uniqueTerms.some((term) => term.toLowerCase() === part.toLowerCase())
        ? `<mark>${escapeHtml(part)}</mark>`
        : escapeHtml(part),
    )
    .join("");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberedSteps(steps) {
  return `
    <ol class="steps-list">
      ${steps
        .map((step, index) => `<li><span class="step-number">${index + 1}</span><span>${escapeHtml(step)}</span></li>`)
        .join("")}
    </ol>
  `;
}

function inputField(path, label, value, type = "text") {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input type="${escapeAttr(type)}" value="${escapeAttr(value)}" data-field="${escapeAttr(path)}" />
    </label>
  `;
}

function selectField(path, label, value, options) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <select data-field="${escapeAttr(path)}">
        ${options
          .map((option) => `<option value="${escapeAttr(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option || "请选择")}</option>`)
          .join("")}
      </select>
    </label>
  `;
}

function textareaField(path, label, value, tall) {
  return `
    <label class="field full">
      <span>${escapeHtml(label)}</span>
      <textarea class="${tall ? "tall" : ""}" data-field="${escapeAttr(path)}">${escapeHtml(value)}</textarea>
    </label>
  `;
}

document.addEventListener("click", (event) => {
  const openLibraryButton = event.target.closest("[data-open-library]");
  if (openLibraryButton) {
    openLibrary(openLibraryButton.dataset.openLibrary);
    return;
  }

  if (event.target.closest("[data-close-library]")) {
    closeLibrary();
    return;
  }

  if (event.target.closest("[data-back-writing-archive]")) {
    activeLibrary = "writing";
    editingWritingCycleId = null;
    comparisonCycleId = null;
    renderOverlay();
    return;
  }

  const editWritingCycleButton = event.target.closest("[data-edit-writing-cycle]");
  if (editWritingCycleButton) {
    openWritingCycle(Number(editWritingCycleButton.dataset.editWritingCycle));
    return;
  }

  const comparisonButton = event.target.closest("[data-open-writing-comparison]");
  if (comparisonButton) {
    openWritingComparison(Number(comparisonButton.dataset.openWritingComparison));
    return;
  }

  const vocabularyFilterButton = event.target.closest("[data-vocabulary-filter]");
  if (vocabularyFilterButton) {
    vocabularyFilter = vocabularyFilterButton.dataset.vocabularyFilter;
    renderOverlay();
    return;
  }

  const libraryMaterialButton = event.target.closest("[data-library-material]");
  if (libraryMaterialButton) {
    selectedLibraryMaterialId = Number(libraryMaterialButton.dataset.libraryMaterial);
    renderOverlay();
    return;
  }

  const useLibraryMaterialButton = event.target.closest("[data-use-library-material]");
  if (useLibraryMaterialButton) {
    useSpeakingMaterial(Number(useLibraryMaterialButton.dataset.useLibraryMaterial));
    return;
  }

  if (event.target.closest("[data-cloud-sync]")) {
    void syncFromCloud();
    return;
  }

  const completeButton = event.target.closest("[data-complete-task]");
  if (completeButton) {
    event.stopPropagation();
    completeTask(Number(completeButton.dataset.completeTask));
    return;
  }

  const taskCard = event.target.closest("[data-select-task]");
  if (taskCard) {
    selectedTaskId = Number(taskCard.dataset.selectTask);
    render();
    return;
  }

  const jumpButton = event.target.closest("[data-audio-jump]");
  if (jumpButton) {
    clearSentenceSelection();
    jumpAudio(Number(jumpButton.dataset.audioJump));
    return;
  }

  if (event.target.closest("[data-play-full]")) {
    playFullAudio();
    return;
  }

  const sentenceButton = event.target.closest("[data-play-sentence]");
  if (sentenceButton) {
    playSentence(Number(sentenceButton.dataset.playSentence));
    return;
  }

  const sentenceNav = event.target.closest("[data-sentence-nav]");
  if (sentenceNav) {
    navigateSentence(Number(sentenceNav.dataset.sentenceNav));
    return;
  }

  const removeVocabulary = event.target.closest("[data-remove-vocabulary]");
  if (removeVocabulary) {
    removeVocabularyItem(removeVocabulary.dataset.removeVocabulary);
    return;
  }

  if (event.target.closest("[data-export-vocabulary]")) {
    exportVocabularyCsv();
    return;
  }

});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeLibrary) {
    closeLibrary();
    return;
  }
  const taskCard = event.target.closest("[data-select-task]");
  if (!taskCard || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  selectedTaskId = Number(taskCard.dataset.selectTask);
  render();
});

document.addEventListener("input", (event) => {
  if (handleHistoryWritingField(event.target)) return;
  if (handleVocabularyDraft(event.target)) return;
  if (handleStandardField(event.target)) return;
});

document.addEventListener("change", (event) => {
  if (handleHistoryWritingField(event.target)) return;
  if (handleStandardField(event.target)) return;
  if (handleSpeakingStep(event.target)) return;
  if (handleSpeakingMaterial(event.target)) return;
  if (handleAudioSpeed(event.target)) return;
  if (handleAudioLoop(event.target)) return;
  if (handleSentenceLoop(event.target)) return;
});

document.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-vocabulary-form]")) return;
  event.preventDefault();
  addVocabularyItem(event.target.dataset.vocabularyForm);
});

dom.reset.addEventListener("click", () => {
  const confirmed = window.confirm("确认重置学习进度？统一生词本和写作档案会保留。");
  if (!confirmed) return;
  const vocabularyBook = state.vocabularyBook;
  const writingArchive = state.writingArchive;
  state = { ...defaultState(), vocabularyBook, writingArchive };
  selectedTaskId = 1;
  activeSentenceIndex = null;
  ensureState();
  saveState();
  render();
});

window.addEventListener("resize", resizeTallTextareas);

function openLibrary(kind) {
  if (!["speaking", "writing", "vocabulary"].includes(kind)) return;
  activeLibrary = kind;
  if (kind === "speaking") {
    selectedLibraryMaterialId = currentCycleRecord().speaking.materialId || 1;
  }
  renderOverlay();
  window.requestAnimationFrame(() => {
    document.querySelector(".overlay-close")?.focus();
  });
}

function openWritingCycle(cycleId) {
  editingWritingCycleId = Math.max(1, Number(cycleId) || 1);
  comparisonCycleId = null;
  activeLibrary = "writing-cycle";
  ensureCycleRecordFor(editingWritingCycleId);
  renderOverlay();
}

function openWritingComparison(cycleId) {
  comparisonCycleId = Math.max(1, Number(cycleId) || 1);
  editingWritingCycleId = null;
  activeLibrary = "comparison";
  renderOverlay();
}

function closeLibrary() {
  activeLibrary = null;
  editingWritingCycleId = null;
  comparisonCycleId = null;
  renderOverlay();
}

function useSpeakingMaterial(materialId) {
  const material = findMaterial(materialId);
  if (!material) return;
  const speaking = currentCycleRecord().speaking;
  speaking.materialId = material.id;
  speaking.materialManuallySelected = true;
  speaking.materialName = material.displayTitle;
  speaking.text = material.passage;
  speaking.steps = Array(speakingSteps.length).fill(false);
  speaking.localAudioName = "";
  selectedTaskId = 2;
  activeSentenceIndex = null;
  activeLibrary = null;
  saveState();
  render();
}

function handleStandardField(target) {
  if (!target?.dataset?.field) return false;
  setPath(currentCycleRecord(), target.dataset.field, target.value);
  if (target.matches("textarea.tall")) resizeTextarea(target);
  saveState();
  if (["writing.essayText", "writing.modelText"].includes(target.dataset.field)) {
    renderTasks();
    const comparisonButton = document.querySelector(
      `[data-open-writing-comparison="${state.cycleId}"]`,
    );
    if (comparisonButton) comparisonButton.disabled = !writingTextsReady();
  }
  return true;
}

function handleVocabularyDraft(target) {
  const subject = target?.dataset?.vocabularySubject;
  const field = target?.dataset?.vocabularyField;
  if (!subject || !field || !currentCycleRecord().vocabularyDrafts[subject]) return false;
  currentCycleRecord().vocabularyDrafts[subject][field] = target.value;
  saveState();
  return true;
}

function handleHistoryWritingField(target) {
  const field = target?.dataset?.historyWritingField;
  const cycleId = Number(target?.dataset?.historyWritingCycle);
  if (!field || !cycleId) return false;
  const writing = ensureCycleRecordFor(cycleId).writing;
  writing[field] = target.value;
  syncWritingArchiveForCycle(cycleId);
  saveState();
  if (["essayText", "modelText"].includes(field)) {
    const comparisonButton = document.querySelector(
      `[data-open-writing-comparison="${cycleId}"]`,
    );
    if (comparisonButton) comparisonButton.disabled = !writingTextsReady(writing);
  }
  return true;
}

function handleSpeakingStep(target) {
  if (!target?.dataset || target.dataset.speakingStep === undefined) return false;
  const index = Number(target.dataset.speakingStep);
  currentCycleRecord().speaking.steps[index] = target.checked;
  saveState();
  return true;
}

function handleSpeakingMaterial(target) {
  if (!target?.dataset || target.dataset.speakingMaterial === undefined) return false;
  const material = findMaterial(target.value);
  if (!material) return true;
  const speaking = currentCycleRecord().speaking;
  speaking.materialId = material.id;
  speaking.materialManuallySelected = true;
  speaking.materialName = material.displayTitle;
  speaking.text = material.passage;
  speaking.steps = Array(speakingSteps.length).fill(false);
  speaking.localAudioName = "";
  activeSentenceIndex = null;
  saveState();
  render();
  return true;
}

function handleAudioSpeed(target) {
  if (!target?.dataset || target.dataset.audioSpeed === undefined) return false;
  currentCycleRecord().speaking.speed = target.value;
  saveState();
  syncAudioSettings();
  return true;
}

function handleAudioLoop(target) {
  if (!target?.dataset || target.dataset.audioLoop === undefined) return false;
  currentCycleRecord().speaking.loop = target.checked;
  saveState();
  syncAudioSettings();
  return true;
}

function handleSentenceLoop(target) {
  if (!target?.dataset || target.dataset.sentenceLoop === undefined) return false;
  currentCycleRecord().speaking.sentenceLoop = target.checked;
  saveState();
  return true;
}

function addVocabularyItem(subject) {
  if (!taskNameByKey[subject]) return;
  const record = currentCycleRecord();
  const draft = record.vocabularyDrafts[subject];
  const word = draft.word.trim();
  const meaning = draft.meaning.trim();
  if (!word || !meaning) return;

  state.vocabularyBook.push({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    subject,
    subjectName: taskNameByKey[subject],
    cycleId: state.cycleId,
    word,
    meaning,
    context: draft.context.trim(),
    source: draft.source.trim() || suggestedVocabularySource(subject, record),
    addedAt: new Date().toISOString(),
  });
  record.vocabularyDrafts[subject] = {
    word: "",
    meaning: "",
    context: "",
    source: "",
  };
  saveState();
  render();
}

function suggestedVocabularySource(subject, record) {
  if (subject === "speaking") return record.speaking.materialName || "";
  if (subject === "writing") return record.writing.topic || "";
  if (subject === "listening") return record.listening.materialName || "";
  if (subject === "reading") return record.reading.materialName || "";
  return "";
}

function removeVocabularyItem(id) {
  const item = state.vocabularyBook.find((entry) => entry.id === id);
  if (!item || !window.confirm(`确认删除生词“${item.word}”？`)) return;
  state.vocabularyBook = state.vocabularyBook.filter((entry) => entry.id !== id);
  saveState();
  render();
}

function exportVocabularyCsv() {
  if (!state.vocabularyBook.length) return;
  const rows = [
    ["日期", "科目", "循环", "生词/短语", "中文释义", "来源", "原句/语境"],
    ...state.vocabularyBook.map((item) => [
      formatVocabularyDate(item.addedAt),
      item.subjectName || taskNameByKey[item.subject] || "",
      item.cycleId || "",
      item.word,
      item.meaning,
      item.source || "",
      item.context || "",
    ]),
  ];
  const csv = `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `雅思统一生词本-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function formatVocabularyDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatArchiveDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function syncAudioSettings() {
  const audio = document.querySelector("#speakingAudio");
  if (!audio) return;
  const speaking = currentCycleRecord().speaking;
  audio.playbackRate = Number(speaking.speed || 1);
  audio.loop = activeSentenceIndex === null && Boolean(speaking.loop);
  if (!audio.dataset.sentenceMonitor) {
    audio.dataset.sentenceMonitor = "true";
    audio.addEventListener("timeupdate", monitorSentencePlayback);
    audio.addEventListener("ended", monitorSentencePlayback);
  }
}

function currentSentences() {
  const material = findMaterial(currentCycleRecord().speaking.materialId) || speakingMaterials[0];
  return material?.sentences || [];
}

function playSentence(index) {
  const audio = document.querySelector("#speakingAudio");
  const sentences = currentSentences();
  const sentence = sentences[index];
  if (!audio || !sentence) return;

  activeSentenceIndex = index;
  audio.loop = false;
  audio.currentTime = Math.max(0, Number(sentence.start) - 0.04);
  audio.playbackRate = Number(currentCycleRecord().speaking.speed || 1);
  audio.play().catch(() => {});
  startSentenceMonitor();
  updateSentenceUi();
}

function navigateSentence(direction) {
  const sentences = currentSentences();
  if (!sentences.length) return;
  const base = activeSentenceIndex === null ? (direction > 0 ? -1 : sentences.length) : activeSentenceIndex;
  const next = Math.max(0, Math.min(sentences.length - 1, base + direction));
  playSentence(next);
}

function playFullAudio() {
  const audio = document.querySelector("#speakingAudio");
  if (!audio) return;
  activeSentenceIndex = null;
  stopSentenceMonitor();
  audio.currentTime = 0;
  syncAudioSettings();
  audio.play().catch(() => {});
  updateSentenceUi();
}

function clearSentenceSelection() {
  if (activeSentenceIndex === null) return;
  activeSentenceIndex = null;
  stopSentenceMonitor();
  syncAudioSettings();
  updateSentenceUi();
}

function monitorSentencePlayback() {
  if (activeSentenceIndex === null) return;
  const audio = document.querySelector("#speakingAudio");
  const sentence = currentSentences()[activeSentenceIndex];
  if (!audio || !sentence || audio.currentTime < Number(sentence.end) - 0.04) return;

  if (currentCycleRecord().speaking.sentenceLoop) {
    audio.currentTime = Math.max(0, Number(sentence.start) - 0.04);
    audio.play().catch(() => {});
  } else {
    audio.pause();
    audio.currentTime = Number(sentence.end);
    stopSentenceMonitor();
    updateSentenceUi(true);
  }
}

function startSentenceMonitor() {
  stopSentenceMonitor();
  sentenceMonitorTimer = window.setInterval(monitorSentencePlayback, 40);
}

function stopSentenceMonitor() {
  if (sentenceMonitorTimer === null) return;
  window.clearInterval(sentenceMonitorTimer);
  sentenceMonitorTimer = null;
}

function updateSentenceUi(finished = false) {
  const sentences = currentSentences();
  document.querySelectorAll("[data-play-sentence]").forEach((button) => {
    const active = Number(button.dataset.playSentence) === activeSentenceIndex;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    const action = button.querySelector(".sentence-action");
    if (action) action.textContent = active ? (finished ? "已听" : "播放中") : "播放";
  });
  const status = document.querySelector("#sentenceStatus");
  if (!status) return;
  if (activeSentenceIndex === null) {
    status.textContent = "当前为整篇播放，点击任意句子可切换为逐句模式。";
  } else {
    status.textContent = `第 ${activeSentenceIndex + 1} / ${sentences.length} 句${finished ? "播放完成" : "正在播放"}`;
  }
}

function jumpAudio(seconds) {
  const audio = document.querySelector("#speakingAudio");
  if (!audio) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + seconds));
}

function resizeTallTextareas() {
  document.querySelectorAll("textarea.tall").forEach(resizeTextarea);
}

function resizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function completeTask(taskId) {
  const key = taskKeyById[taskId];
  if (!key || taskId !== state.currentTask || state.tasks[key] !== "in_progress") return;
  if (taskId === 4 && !writingTextsReady()) {
    window.alert("请先粘贴“我的作文”和“范文”，再完成写作任务。");
    return;
  }

  const completedWritingCycleId = taskId === 4 ? state.cycleId : null;
  if (taskId === 4) archiveCurrentWriting();

  state.tasks[key] = "completed";
  state.completedEvents.push({
    cycleId: state.cycleId,
    taskId,
    taskName: taskDefs[taskId - 1].name,
    at: new Date().toISOString(),
  });

  if (taskId < taskDefs.length) {
    const nextId = taskId + 1;
    state.currentTask = nextId;
    state.tasks[taskKeyById[nextId]] = "in_progress";
    selectedTaskId = nextId;
  } else {
    state.completedCycles = (state.completedCycles || 0) + 1;
    state.cycleId += 1;
    state.currentTask = 1;
    state.tasks = initialTasks();
    selectedTaskId = 1;
    ensureCycleRecord();
  }

  if (completedWritingCycleId) {
    comparisonCycleId = completedWritingCycleId;
    editingWritingCycleId = null;
    activeLibrary = "comparison";
  }
  saveState();
  render();
}

function archiveCurrentWriting() {
  syncWritingArchiveForCycle(state.cycleId, new Date().toISOString());
}

function syncWritingArchiveForCycle(cycleId, completedAt) {
  const normalizedCycleId = Math.max(1, Number(cycleId) || 1);
  const writing = ensureCycleRecordFor(normalizedCycleId).writing;
  const id = `cycle-${normalizedCycleId}`;
  const existingIndex = state.writingArchive.findIndex((item) => item.id === id);
  const existing = existingIndex >= 0 ? state.writingArchive[existingIndex] : null;
  const completionEvent = state.completedEvents.find(
    (event) => event.taskId === 4 && Number(event.cycleId) === normalizedCycleId,
  );
  const now = new Date().toISOString();
  const entry = {
    id,
    cycleId: normalizedCycleId,
    writingType: writing.writingType,
    topic: writing.topic,
    timed: writing.timed,
    wordCount: writing.wordCount,
    mainProblem: writing.mainProblem,
    essayText: writing.essayText || "",
    modelText: writing.modelText || "",
    legacyAttachments: existing?.legacyAttachments || writing.attachments || null,
    completedAt: completedAt || existing?.completedAt || completionEvent?.at || now,
    updatedAt: now,
  };
  if (existingIndex >= 0) {
    state.writingArchive[existingIndex] = entry;
  } else {
    state.writingArchive.push(entry);
  }
  state.writingArchive.sort(
    (a, b) => stateTime(a.completedAt || a.updatedAt) - stateTime(b.completedAt || b.updatedAt),
  );
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let target = object;
  parts.slice(0, -1).forEach((part) => {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  });
  target[parts.at(-1)] = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
