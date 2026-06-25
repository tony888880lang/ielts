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

const readingTypes = [
  "True / False / Not Given",
  "Matching Headings",
  "Multiple Choice",
  "Sentence Completion",
  "Summary Completion",
  "Matching Information",
  "其他",
];

const readingReasons = [
  "定位失败",
  "单词不认识",
  "同义替换没识别",
  "逻辑判断错误",
  "时间不够",
  "题型不熟",
  "粗心",
];

const task1Checks = [
  "有 overview",
  "描述主要趋势",
  "抓住最高、最低、变化、对比",
  "避免逐个数字流水账",
  "达到 150 词以上",
];

const task2Checks = [
  "明确回答题目",
  "每段有中心句",
  "观点有解释",
  "有例子或展开",
  "达到 250 词以上",
  "检查明显语法错误",
];

const xdfTasks = new Set([1, 3, 4]);

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
      materialName: "",
      sectionType: "Section 3",
      totalQuestions: "",
      correctAnswers: "",
      mainProblems: "",
      vocabulary: "",
      vocabularyDraft: {
        word: "",
        meaning: "",
        context: "",
      },
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
      expressions: [blankExpression()],
      recitation: {
        content: "",
        fluent: "",
        weak: "",
      },
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
      task1Checks: [],
      task2Checks: [],
    },
  };
}

function blankExpression() {
  return {
    expression: "",
    meaning: "",
    original: "",
    mine: "",
  };
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
    const remoteVocabularyCount = Array.isArray(remoteState.vocabularyBook)
      ? remoteState.vocabularyBook.length
      : 0;

    state = {
      ...defaultState(),
      ...(preferRemote ? remoteState : state),
      vocabularyBook: mergedVocabulary,
    };
    const stateBeforeNormalization = JSON.stringify(state);
    ensureState();
    const stateWasNormalized = JSON.stringify(state) !== stateBeforeNormalization;
    selectedTaskId = state.currentTask;
    saveLocalState();
    render();

    cloudReady = true;
    cloudHydrating = false;
    if (!preferRemote || stateWasNormalized || mergedVocabulary.length !== remoteVocabularyCount) {
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
    entries.set(key, item);
  });
  return [...entries.values()].sort((a, b) => stateTime(a.addedAt) - stateTime(b.addedAt));
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
    : "学习记录与生词本会自动跨设备保存";
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
  if (!state.tasks) state.tasks = initialTasks();
  if (!state.currentTask) state.currentTask = 1;
  if (!state.cycleId) state.cycleId = 1;
  if (!state.updatedAt) state.updatedAt = new Date().toISOString();
  ensureCycleRecord();
}

function ensureCycleRecord() {
  const cycleKey = String(state.cycleId);
  if (!state.records[cycleKey]) {
    state.records[cycleKey] = initialCycleRecord(state.cycleId);
  }
  const record = state.records[cycleKey];
  if (!record.listening) record.listening = initialCycleRecord(state.cycleId).listening;
  if (!record.listening.vocabularyDraft) {
    record.listening.vocabularyDraft = { word: "", meaning: "", context: "" };
  }
  if (!record.speaking) record.speaking = initialCycleRecord(state.cycleId).speaking;
  if (!record.speaking.expressions?.length) record.speaking.expressions = [blankExpression()];
  if (!record.speaking.steps?.length) record.speaking.steps = Array(speakingSteps.length).fill(false);
  if (typeof record.speaking.sentenceLoop !== "boolean") record.speaking.sentenceLoop = true;
  if (typeof record.speaking.materialManuallySelected !== "boolean") {
    record.speaking.materialManuallySelected = false;
  }
  hydrateSpeakingDefaults(record.speaking, state.cycleId);
  if (!record.writing) record.writing = initialCycleRecord(state.cycleId).writing;
  if (!record.writing.writingType) record.writing.writingType = recommendedWritingType(state.cycleId);
  return record;
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

function render() {
  stopSentenceMonitor();
  activeSentenceIndex = null;
  renderStatus();
  renderTasks();
  renderDetail();
  renderCloudPanel();
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
            <button class="mini-button" type="button" data-complete-task="${task.id}" ${isCurrent ? "" : "disabled"}>
              ${isCompleted ? "已完成" : isCurrent ? "完成" : "等待"}
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
  const canComplete = state.currentTask === task.id && status === "in_progress";
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
        <p class="note">${status === "completed" ? "这个任务已在当前循环完成。" : "完成后会自动进入下一项任务。"}</p>
        <button class="solid-button" type="button" data-complete-task="${task.id}" ${canComplete ? "" : "disabled"}>
          完成${escapeHtml(task.name)}任务
        </button>
      </div>
    </div>
  `;
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
  const rec = currentCycleRecord().listening;
  const draft = rec.vocabularyDraft;
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
    <section class="section-block">
      <h3>听力记录</h3>
      <div class="form-grid">
        ${inputField("listening.materialName", "听力材料名称", rec.materialName)}
        ${selectField("listening.sectionType", "Section 类型", rec.sectionType, ["Section 3", "Section 4"])}
        ${inputField("listening.totalQuestions", "题目总数", rec.totalQuestions, "number")}
        ${inputField("listening.correctAnswers", "正确题数", rec.correctAnswers, "number")}
        ${textareaField("listening.mainProblems", "本次主要问题", rec.mainProblems, false)}
      </div>
    </section>
    <section class="section-block">
      <h3>记录听力生词</h3>
      <p class="note vocabulary-note">每次只记录一个生词或短语。来源材料和 Section 会自动带入生词本。</p>
      <form class="vocabulary-form" data-vocabulary-form>
        <label class="field">
          <span>生词 / 短语</span>
          <input value="${escapeAttr(draft.word)}" data-vocabulary-draft="word" required />
        </label>
        <label class="field">
          <span>中文释义</span>
          <input value="${escapeAttr(draft.meaning)}" data-vocabulary-draft="meaning" required />
        </label>
        <label class="field vocabulary-context">
          <span>原句 / 听力语境（选填）</span>
          <textarea data-vocabulary-draft="context">${escapeHtml(draft.context)}</textarea>
        </label>
        <button class="solid-button vocabulary-add" type="submit">加入生词本</button>
      </form>
    </section>
    <section class="section-block">
      <div class="section-heading-row">
        <div>
          <h3>我的听力生词本</h3>
          <p class="note">共 ${state.vocabularyBook.length} 条，按最新记录排序。</p>
        </div>
        <button class="quiet-button" type="button" data-export-vocabulary ${state.vocabularyBook.length ? "" : "disabled"}>下载 CSV</button>
      </div>
      ${renderVocabularyBook()}
    </section>
  `;
}

function renderVocabularyBook() {
  if (!state.vocabularyBook.length) {
    return `<p class="empty-state">还没有生词。完成上面的三个字段后，第一条记录就会出现在这里。</p>`;
  }

  return `
    <div class="vocabulary-list">
      ${[...state.vocabularyBook]
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
                <span>${escapeHtml(formatVocabularyDate(item.addedAt))}</span>
                <span>${escapeHtml(item.materialName || "未填写材料")}</span>
                <span>${escapeHtml(item.sectionType || "未填写 Section")}</span>
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

    <section class="section-block">
      <h3>表达记录</h3>
      <div class="expression-list">
        ${rec.expressions.map(renderExpressionRow).join("")}
      </div>
      <button class="quiet-button" type="button" data-add-expression>新增表达</button>
    </section>

    <section class="section-block">
      <h3>背诵记录</h3>
      <div class="form-grid">
        ${textareaField("speaking.recitation.content", "今日背诵内容", rec.recitation.content, false)}
        ${textareaField("speaking.recitation.fluent", "我能脱稿复述的部分", rec.recitation.fluent, false)}
        ${textareaField("speaking.recitation.weak", "还不熟的部分", rec.recitation.weak, false)}
      </div>
    </section>
  `;
}

function renderExpressionRow(item, index) {
  return `
    <div class="expression-row">
      <label class="field">
        <span>表达</span>
        <input value="${escapeAttr(item.expression)}" data-expression-field="${index}.expression" />
      </label>
      <label class="field">
        <span>中文意思</span>
        <input value="${escapeAttr(item.meaning)}" data-expression-field="${index}.meaning" />
      </label>
      <button class="danger-button" type="button" data-remove-expression="${index}">删除</button>
      <label class="field wide">
        <span>原句</span>
        <textarea data-expression-field="${index}.original">${escapeHtml(item.original)}</textarea>
      </label>
      <label class="field wide">
        <span>我自己的造句</span>
        <textarea data-expression-field="${index}.mine">${escapeHtml(item.mine)}</textarea>
      </label>
    </div>
  `;
}

function renderReading() {
  const rec = currentCycleRecord().reading;
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
    <section class="section-block">
      <h3>阅读记录</h3>
      <div class="form-grid">
        ${inputField("reading.materialName", "阅读材料名称", rec.materialName)}
        ${inputField("reading.passageNo", "Passage 编号", rec.passageNo)}
        ${inputField("reading.totalQuestions", "题目总数", rec.totalQuestions, "number")}
        ${inputField("reading.correctAnswers", "正确题数", rec.correctAnswers, "number")}
        ${checkboxGroup("reading.wrongTypes", "错误题型", readingTypes, rec.wrongTypes)}
        ${selectField("reading.mainReason", "主要错因", rec.mainReason, ["", ...readingReasons])}
      </div>
    </section>
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
        "写完后做简单自查。",
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
      <h3>Task 1 自查</h3>
      ${checkRows("writing.task1Checks", task1Checks, rec.task1Checks)}
    </section>
    <section class="section-block">
      <h3>Task 2 自查</h3>
      ${checkRows("writing.task2Checks", task2Checks, rec.task2Checks)}
    </section>
  `;
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

function checkboxGroup(path, label, options, selected) {
  return `
    <fieldset class="field full">
      <legend>${escapeHtml(label)}</legend>
      <div class="inline-options">
        ${options
          .map(
            (option) => `
              <label class="check-row">
                <input type="checkbox" data-array-field="${escapeAttr(path)}" value="${escapeAttr(option)}" ${
                  selected.includes(option) ? "checked" : ""
                } />
                <span>${escapeHtml(option)}</span>
              </label>
            `,
          )
          .join("")}
      </div>
    </fieldset>
  `;
}

function checkRows(path, options, selected) {
  return `
    <div class="inline-options">
      ${options
        .map(
          (option) => `
            <label class="check-row">
              <input type="checkbox" data-array-field="${escapeAttr(path)}" value="${escapeAttr(option)}" ${
                selected.includes(option) ? "checked" : ""
              } />
              <span>${escapeHtml(option)}</span>
            </label>
          `,
        )
        .join("")}
    </div>
  `;
}

document.addEventListener("click", (event) => {
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

  const addExpression = event.target.closest("[data-add-expression]");
  if (addExpression) {
    currentCycleRecord().speaking.expressions.push(blankExpression());
    saveState();
    render();
    return;
  }

  const removeExpression = event.target.closest("[data-remove-expression]");
  if (removeExpression) {
    const expressions = currentCycleRecord().speaking.expressions;
    expressions.splice(Number(removeExpression.dataset.removeExpression), 1);
    if (!expressions.length) expressions.push(blankExpression());
    saveState();
    render();
  }
});

document.addEventListener("keydown", (event) => {
  const taskCard = event.target.closest("[data-select-task]");
  if (!taskCard || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  selectedTaskId = Number(taskCard.dataset.selectTask);
  render();
});

document.addEventListener("input", (event) => {
  if (handleVocabularyDraft(event.target)) return;
  if (handleStandardField(event.target)) return;
  if (handleExpressionField(event.target)) return;
});

document.addEventListener("change", (event) => {
  if (handleStandardField(event.target)) return;
  if (handleArrayField(event.target)) return;
  if (handleSpeakingStep(event.target)) return;
  if (handleExpressionField(event.target)) return;
  if (handleSpeakingMaterial(event.target)) return;
  if (handleAudioSpeed(event.target)) return;
  if (handleAudioLoop(event.target)) return;
  if (handleSentenceLoop(event.target)) return;
});

document.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-vocabulary-form]")) return;
  event.preventDefault();
  addVocabularyItem();
});

dom.reset.addEventListener("click", () => {
  const confirmed = window.confirm("确认重置学习进度？已经积累的听力生词本会保留。");
  if (!confirmed) return;
  const vocabularyBook = state.vocabularyBook;
  state = { ...defaultState(), vocabularyBook };
  selectedTaskId = 1;
  activeSentenceIndex = null;
  ensureState();
  saveState();
  render();
});

window.addEventListener("resize", resizeTallTextareas);

function handleStandardField(target) {
  if (!target?.dataset?.field) return false;
  setPath(currentCycleRecord(), target.dataset.field, target.value);
  if (target.matches("textarea.tall")) resizeTextarea(target);
  saveState();
  return true;
}

function handleVocabularyDraft(target) {
  if (!target?.dataset || target.dataset.vocabularyDraft === undefined) return false;
  currentCycleRecord().listening.vocabularyDraft[target.dataset.vocabularyDraft] = target.value;
  saveState();
  return true;
}

function handleArrayField(target) {
  if (!target?.dataset?.arrayField) return false;
  const record = currentCycleRecord();
  const path = target.dataset.arrayField;
  const current = getPath(record, path) || [];
  const next = target.checked
    ? Array.from(new Set([...current, target.value]))
    : current.filter((item) => item !== target.value);
  setPath(record, path, next);
  saveState();
  return true;
}

function handleSpeakingStep(target) {
  if (!target?.dataset || target.dataset.speakingStep === undefined) return false;
  const index = Number(target.dataset.speakingStep);
  currentCycleRecord().speaking.steps[index] = target.checked;
  saveState();
  return true;
}

function handleExpressionField(target) {
  if (!target?.dataset?.expressionField) return false;
  const [indexText, key] = target.dataset.expressionField.split(".");
  const expression = currentCycleRecord().speaking.expressions[Number(indexText)];
  if (expression && key) {
    expression[key] = target.value;
    saveState();
  }
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

function addVocabularyItem() {
  const listening = currentCycleRecord().listening;
  const draft = listening.vocabularyDraft;
  const word = draft.word.trim();
  const meaning = draft.meaning.trim();
  if (!word || !meaning) return;

  state.vocabularyBook.push({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    word,
    meaning,
    context: draft.context.trim(),
    materialName: listening.materialName.trim(),
    sectionType: listening.sectionType,
    addedAt: new Date().toISOString(),
  });
  listening.vocabularyDraft = { word: "", meaning: "", context: "" };
  saveState();
  render();
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
    ["日期", "生词/短语", "中文释义", "来源材料", "Section", "原句/语境"],
    ...state.vocabularyBook.map((item) => [
      formatVocabularyDate(item.addedAt),
      item.word,
      item.meaning,
      item.materialName || "",
      item.sectionType || "",
      item.context || "",
    ]),
  ];
  const csv = `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `雅思听力生词本-${new Date().toISOString().slice(0, 10)}.csv`;
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

  saveState();
  render();
}

function getPath(object, path) {
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), object);
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
