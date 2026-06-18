const XDF_URL = "https://ieltscat.xdf.cn/";
const STORAGE_KEY = "ielts-study-panel-state-v1";

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
let state = loadState();
let selectedTaskId = state.currentTask || 1;
let localAudioUrl = null;

const dom = {
  today: document.querySelector("#todayText"),
  cycle: document.querySelector("#cycleText"),
  progress: document.querySelector("#progressText"),
  completedCycles: document.querySelector("#completedCyclesText"),
  weeklyTasks: document.querySelector("#weeklyTasksText"),
  progressBar: document.querySelector("#cycleProgressBar"),
  taskList: document.querySelector("#taskList"),
  taskDetail: document.querySelector("#taskDetail"),
  reset: document.querySelector("#resetProgress"),
};

init();

async function init() {
  const response = await fetch("./data/speaking.json");
  const data = await response.json();
  speakingMaterials = data.materials;
  ensureState();
  saveState();
  render();
}

function defaultState() {
  return {
    cycleId: 1,
    currentTask: 1,
    completedCycles: 0,
    tasks: initialTasks(),
    records: {},
    completedEvents: [],
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
  return {
    listening: {
      materialName: "",
      sectionType: "Section 3",
      totalQuestions: "",
      correctAnswers: "",
      mainProblems: "",
      vocabulary: "",
    },
    speaking: {
      materialId: 1,
      customTopic: "",
      materialName: "",
      text: "",
      speed: "1",
      loop: false,
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

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState(), ...JSON.parse(raw) } : defaultState();
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function ensureState() {
  if (!state.records || typeof state.records !== "object") state.records = {};
  if (!state.completedEvents || !Array.isArray(state.completedEvents)) state.completedEvents = [];
  if (!state.tasks) state.tasks = initialTasks();
  if (!state.currentTask) state.currentTask = 1;
  if (!state.cycleId) state.cycleId = 1;
  ensureCycleRecord();
}

function ensureCycleRecord() {
  const cycleKey = String(state.cycleId);
  if (!state.records[cycleKey]) {
    state.records[cycleKey] = initialCycleRecord(state.cycleId);
  }
  const record = state.records[cycleKey];
  if (!record.speaking) record.speaking = initialCycleRecord(state.cycleId).speaking;
  if (!record.speaking.expressions?.length) record.speaking.expressions = [blankExpression()];
  if (!record.speaking.steps?.length) record.speaking.steps = Array(speakingSteps.length).fill(false);
  hydrateSpeakingDefaults(record.speaking);
  if (!record.writing) record.writing = initialCycleRecord(state.cycleId).writing;
  if (!record.writing.writingType) record.writing.writingType = recommendedWritingType(state.cycleId);
  return record;
}

function hydrateSpeakingDefaults(speaking) {
  const material = findMaterial(speaking.materialId) || speakingMaterials[0];
  if (!material) return;
  if (!speaking.materialId) speaking.materialId = material.id;
  if (!speaking.materialName) speaking.materialName = material.displayTitle;
  if (!speaking.text) speaking.text = material.passage;
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
  renderStatus();
  renderTasks();
  renderDetail();
  syncAudioSettings();
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
        ${textareaField("listening.vocabulary", "记录的生词 / 表达", rec.vocabulary, false)}
      </div>
    </section>
  `;
}

function renderSpeaking() {
  const rec = currentCycleRecord().speaking;
  const material = findMaterial(rec.materialId) || speakingMaterials[0];
  const expressionList = material?.expressions || [];
  const replacements = material?.replacements || [];
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
        <label class="field">
          <span>上传本地 MP3</span>
          <input type="file" accept="audio/mpeg,audio/mp3" data-local-audio />
        </label>
      </div>
    </section>

    <section class="section-block">
      <h3>MP3 播放器</h3>
      <div class="audio-box">
        <audio id="speakingAudio" controls preload="metadata" src="${escapeAttr(localAudioUrl || material?.audio || "")}"></audio>
        <div class="audio-tools">
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
            <span>循环当前音频</span>
          </label>
        </div>
      </div>
    </section>

    <section class="section-block">
      <h3>文本内容</h3>
      <div class="form-grid">
        <label class="field full">
          <span>上传文本文件</span>
          <input type="file" accept=".txt,text/plain" data-text-upload />
        </label>
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
    jumpAudio(Number(jumpButton.dataset.audioJump));
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
  if (handleLocalAudio(event.target)) return;
  if (handleTextUpload(event.target)) return;
});

dom.reset.addEventListener("click", () => {
  const confirmed = window.confirm("确认清空本地学习进度？");
  if (!confirmed) return;
  state = defaultState();
  selectedTaskId = 1;
  ensureState();
  saveState();
  render();
});

function handleStandardField(target) {
  if (!target?.dataset?.field) return false;
  setPath(currentCycleRecord(), target.dataset.field, target.value);
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
  speaking.materialName = material.displayTitle;
  speaking.text = material.passage;
  speaking.steps = Array(speakingSteps.length).fill(false);
  speaking.localAudioName = "";
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
  localAudioUrl = null;
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

function handleLocalAudio(target) {
  if (!target?.dataset || target.dataset.localAudio === undefined || !target.files?.[0]) return false;
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
  localAudioUrl = URL.createObjectURL(target.files[0]);
  currentCycleRecord().speaking.localAudioName = target.files[0].name;
  saveState();
  const audio = document.querySelector("#speakingAudio");
  if (audio) {
    audio.src = localAudioUrl;
    audio.load();
    syncAudioSettings();
  }
  return true;
}

function handleTextUpload(target) {
  if (!target?.dataset || target.dataset.textUpload === undefined || !target.files?.[0]) return false;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    currentCycleRecord().speaking.text = String(reader.result || "");
    saveState();
    render();
  });
  reader.readAsText(target.files[0]);
  return true;
}

function syncAudioSettings() {
  const audio = document.querySelector("#speakingAudio");
  if (!audio) return;
  const speaking = currentCycleRecord().speaking;
  audio.playbackRate = Number(speaking.speed || 1);
  audio.loop = Boolean(speaking.loop);
}

function jumpAudio(seconds) {
  const audio = document.querySelector("#speakingAudio");
  if (!audio) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + seconds));
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
