require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY
);

/** Discord ID → users 行（001 / REPME001 重複時は REPMEXXX を優先） */
async function findUserByDiscordId(userId) {
  const { data: rows, error } = await supabase
    .from('users')
    .select('repme_code, user_id')
    .eq('user_id', userId);
  if (error) return { user: null, error };
  if (!rows || rows.length === 0) return { user: null, error: null };
  const preferred = [...rows].sort((a, b) => {
    const aRepme = /^REPME\d+$/i.test(a.repme_code) ? 1 : 0;
    const bRepme = /^REPME\d+$/i.test(b.repme_code) ? 1 : 0;
    return bRepme - aRepme;
  })[0];
  return { user: preferred, error: null };
}

const sessions = {};
const unplanSessions = {};
/** 入室チュートリアル（実験） userId → { step, repmeCode?, expiresAt } */
const tutorialSessions = {};
/** !confirm 連打防止 userId → lastUsedAt */
const confirmCooldown = {};
const CONFIRM_COOLDOWN_MS = 5 * 60 * 1000;

const notifyingTaskIds = new Set();

// ========================================
// 入室チュートリアル（実験版）
// DMで進行 / サーバーで !in !out !link を実践
// ========================================

const TUTORIAL_TTL_MS = 24 * 60 * 60 * 1000;

const TUTORIAL_MSG = {
  // 各値は連続送信する通の配列（コピー用は 本文 / コマンド / （⇧コピー用））
  welcome: [
    [
      'REPME Focus Gymへようこそ！',
      'まずは1分で終わるチュートリアルとユーザー登録を行いましょう！',
      '準備ができたらOKと送ってください',
    ].join('\n'),
    'OK',
    '（⇧コピー用）',
  ],
  practiceIn: [
    [
      'まずは、作業開始を記録する 「!in」 をやってみましょう！',
      'サーバーの「出勤・退勤｜check-in」 チャンネルで',
      '!in と送信してください。',
    ].join('\n'),
    '!in',
    '（⇧コピー用）',
  ],
  practiceOut: [
    [
      '完璧です！',
      '!in を確認しました。',
      '!in は「これから作業を開始する」という合図になります。',
      '次は終了時の !out を試してみましょう',
    ].join('\n'),
    '!out',
    '（⇧コピー用）',
  ],
  awaitLink: [
    [
      '完璧です！',
      '!out を確認しました。',
      '!out は「作業を終了する」という合図になります。',
      '今日からは、作業前に「!in」、作業後に「!out」を習慣にしていきましょう！',
      'これでチュートリアルは完了です',
      '最後にユーザー登録を行いましょう',
      '「ユーザー登録」 チャンネルで',
      '!link と送ってください。',
    ].join('\n'),
    '!link',
    '（⇧コピー用）',
  ],
  credentials: (code, password) => [
    [
      '完璧です！',
      '!link を確認しました。',
      `あなたのREPMEコードは${code}`,
      `パスワードは${password}です。`,
      'このコード、パスワードを使って',
      '下記のリンクからあなたの作業時間の記録を確認できます！',
      'https://repme-web.vercel.app',
      '',
      'これで全ての準備が整いました！',
      'ここまで理解できましたらOKと送ってください',
    ].join('\n'),
    'OK',
    '（⇧コピー用）',
  ],
  closing: [
    [
      'チュートリアルとREPME登録を完了しました！',
      '「必ずお読みください」 チャンネルで、REPMEサーバーの詳しい説明をまとめましたので、お時間のある際にお読みください。',
      'それでは、今日から一緒に集中する習慣を積み重ねていきましょう！',
    ].join('\n'),
  ],
};

function isTutorialExpired(session) {
  return !session || Date.now() > (session.expiresAt || 0);
}

function isOkText(text) {
  return /^(ok|ＯＫ|Okay)$/i.test(String(text || '').trim());
}

async function allocateRepmeCode() {
  const { data, error } = await supabase.from('users').select('repme_code');
  if (error) {
    console.error('allocateRepmeCode', error);
    throw error;
  }
  let max = 0;
  for (const row of data || []) {
    const m = String(row.repme_code || '').match(/^(?:REPME)?(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  // 既存 001 / REPME001 など数値部分の最大+1 → REPME002, REPME003...
  return `REPME${String(max + 1).padStart(3, '0')}`;
}

/** 新規コードで insert。競合したら採番し直して最大5回リトライ */
async function insertUserWithNewCode(discordUser, password) {
  const userId = discordUser.id;
  const userName = discordUser.username;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await allocateRepmeCode();
    const { error } = await supabase.from('users').insert([{
      repme_code: code,
      user_id: userId,
      password,
      display_name: userName,
    }]);
    if (!error) return code;
    lastError = error;
    // unique 競合以外は即失敗
    const msg = String(error.message || error.code || '');
    if (!/duplicate|unique|23505/i.test(msg)) throw error;
  }
  throw lastError || new Error('repme_code 発行に失敗しました');
}

function generateReadablePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomTempPassword() {
  return `tmp_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

async function dmUser(userOrId, text) {
  try {
    const user =
      typeof userOrId === 'string' ? await client.users.fetch(userOrId) : userOrId;
    await user.send(text);
    return true;
  } catch (err) {
    console.error('チュートリアルDM失敗', err?.message || err);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** チュートリアル案内を複数通に分けて連続送信 */
async function dmSequence(userOrId, parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  let ok = true;
  for (let i = 0; i < list.length; i++) {
    const sent = await dmUser(userOrId, list[i]);
    if (!sent) ok = false;
    if (i < list.length - 1) await sleep(300);
  }
  return ok;
}

/** !in 用に仮ユーザーを用意（パスワードは !link で正式発行） */
async function ensureTutorialUser(discordUser) {
  const userId = discordUser.id;
  const { user: existing } = await findUserByDiscordId(userId);
  if (existing?.repme_code) return existing.repme_code;
  return insertUserWithNewCode(discordUser, randomTempPassword());
}

function touchTutorial(session) {
  session.expiresAt = Date.now() + TUTORIAL_TTL_MS;
  return session;
}

async function beginTutorial(discordUser, { force = false } = {}) {
  const userId = discordUser.id;

  if (!force) {
    const { user: existing } = await findUserByDiscordId(userId);
    if (existing?.repme_code) {
      await dmUser(
        discordUser,
        `すでに連携済みです（コード: ${existing.repme_code}）。\nやり直しは \`!tutorial\` と送ってください。`,
      );
      return;
    }
  }

  tutorialSessions[userId] = {
    step: 'await_ok_start',
    expiresAt: Date.now() + TUTORIAL_TTL_MS,
  };

  const ok = await dmSequence(discordUser, TUTORIAL_MSG.welcome);
  if (!ok) {
    delete tutorialSessions[userId];
    console.warn(`チュートリアル開始失敗（DM不可）: ${userId}`);
  } else {
    console.log(`チュートリアル開始: ${userId}`);
  }
}

async function handleTutorialOkStart(message) {
  const userId = message.author.id;
  let code;
  try {
    code = await ensureTutorialUser(message.author);
  } catch (err) {
    console.error('チュートリアル仮登録失敗', err);
    await message.reply('準備に失敗しました。少ししてからもう一度 OK を送ってください。');
    return;
  }

  tutorialSessions[userId] = touchTutorial({
    step: 'practice_in',
    repmeCode: code,
  });
  await dmSequence(message.author, TUTORIAL_MSG.practiceIn);
}

async function finalizeTutorialLink(discordUser, { existingCode = null } = {}) {
  const userId = discordUser.id;
  const userName = discordUser.username;
  let code = existingCode;

  if (!code) {
    const { data: existing } = await supabase
      .from('users')
      .select('repme_code')
      .eq('user_id', userId)
      .maybeSingle();
    code = existing?.repme_code || null;
  }

  const password = generateReadablePassword();

  if (!code) {
    code = await insertUserWithNewCode(discordUser, password);
    return { code, password };
  }

  const { error } = await supabase
    .from('users')
    .update({
      user_id: userId,
      password,
      display_name: userName,
    })
    .eq('repme_code', code);
  if (error) throw error;
  return { code, password };
}

async function advanceTutorialOnGuildAction(userId, action) {
  const session = tutorialSessions[userId];
  if (!session || isTutorialExpired(session)) {
    if (session) delete tutorialSessions[userId];
    return;
  }

  if (action === 'in' && session.step === 'practice_in') {
    session.step = 'practice_out';
    touchTutorial(session);
    await dmSequence(userId, TUTORIAL_MSG.practiceOut);
    return;
  }

  if (action === 'out' && session.step === 'practice_out') {
    session.step = 'await_link';
    touchTutorial(session);
    await dmSequence(userId, TUTORIAL_MSG.awaitLink);
  }
}

async function advanceTutorialOnLink(userId, code, password) {
  const session = tutorialSessions[userId];
  if (!session || isTutorialExpired(session)) {
    if (session) delete tutorialSessions[userId];
    return false;
  }
  if (session.step !== 'await_link') return false;

  session.step = 'await_ok_end';
  session.repmeCode = code;
  session.password = password;
  touchTutorial(session);
  await dmSequence(userId, TUTORIAL_MSG.credentials(code, password));
  return true;
}

function tutorialStatusText(userId) {
  const session = tutorialSessions[userId];
  if (!session || isTutorialExpired(session)) {
    return 'チュートリアル進行中ではありません。\nいつでも `!tutorial` で開始／やり直しできます。';
  }
  const stepLabel = {
    await_ok_start: '① DMで OK',
    practice_in: '② サーバーで !in',
    practice_out: '③ サーバーで !out',
    await_link: '④ ユーザー登録チャンネルで !link',
    await_ok_end: '⑤ DMで OK（説明の確認）',
  }[session.step] || session.step;
  const codeLine = session.repmeCode ? `\nコード: ${session.repmeCode}` : '';
  return `いまのステップ: ${stepLabel}${codeLine}\n\nやり直し: \`!tutorial\`\n状態確認: \`!tutorial status\``;
}

async function handleTutorialCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (sub === 'status' || sub === '状態') {
    await message.reply(tutorialStatusText(message.author.id));
    return true;
  }

  if (sub === 'help' || sub === 'ヘルプ') {
    await message.reply(
      [
        '【チュートリアルコマンド】',
        '`!tutorial` … いつでも開始／最初からやり直し',
        '`!tutorial status` … いまの進行状況',
        '`!tutorial help` … この説明',
        '',
        '流れ: OK → !in → !out → !link → OK',
      ].join('\n'),
    );
    return true;
  }

  await beginTutorial(message.author, { force: true });
  if (message.guild) {
    await message.reply('DMに案内を送りました。届かないときは「サーバーメンバーからのDM」を許可してください。');
  }
  return true;
}

async function handleTutorialDM(message) {
  const userId = message.author.id;
  const content = message.content.trim();

  if (content === '!tutorial' || content.startsWith('!tutorial ')) {
    await handleTutorialCommand(message);
    return true;
  }

  const session = tutorialSessions[userId];
  if (!session || isTutorialExpired(session)) {
    if (session) delete tutorialSessions[userId];
    return false;
  }

  if (session.step === 'await_ok_start') {
    if (!isOkText(content)) {
      await message.reply('準備ができたら「OK」と送ってください。');
      return true;
    }
    await handleTutorialOkStart(message);
    return true;
  }

  if (session.step === 'await_ok_end') {
    if (!isOkText(content)) {
      await message.reply('内容を確認できたら「OK」と送ってください。');
      return true;
    }
    delete tutorialSessions[userId];
    await dmSequence(message.author, TUTORIAL_MSG.closing);
    console.log(`チュートリアル完了: ${userId}`);
    return true;
  }

  if (session.step === 'practice_in') {
    await message.reply('いまはサーバーの「出勤・退勤｜check-in」チャンネルで `!in` を送る番です。\n状況: `!tutorial status`');
    return true;
  }

  if (session.step === 'practice_out') {
    await message.reply('いまはサーバーで `!out` を送る番です。\n状況: `!tutorial status`');
    return true;
  }

  if (session.step === 'await_link') {
    await message.reply('いまは「ユーザー登録」チャンネルで `!link` を送る番です。\n状況: `!tutorial status`');
    return true;
  }

  return false;
}

// ========================================
// ユーティリティ
// ========================================

function buildUTCFromDateAndTime(dateJST, timeText) {
  const [hour, minute] = timeText.split(':').map(Number);
  const jst = new Date(dateJST.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(),
    hour - 9, minute, 0, 0
  )).toISOString();
}

function parseDateMD(mdStr) {
  const match = mdStr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const month = parseInt(match[1], 10) - 1;
  const day = parseInt(match[2], 10);
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const target = new Date(Date.UTC(nowJST.getUTCFullYear(), month, day, 0, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const todayJSTStart = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate(), 0, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const maxJSTEnd = new Date(todayJSTStart.getTime() + 8 * 24 * 60 * 60 * 1000 - 1);
  if (target < todayJSTStart) return 'past';
  if (target > maxJSTEnd) return 'too_far';
  return target;
}

function getTodayJST() {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = nowJST.getUTCFullYear();
  const m = String(nowJST.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nowJST.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const toJSTTime = (utcStr) => {
  const d = new Date(utcStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
};

const toJSTDate = (utcStr) => {
  const d = new Date(utcStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;
};

function parseReportDate(text) {
  const today = getTodayJST();
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);

  const match = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (!match) return today;

  const month = parseInt(match[1], 10) - 1;
  const day = parseInt(match[2], 10);

  let targetJST = new Date(Date.UTC(nowJST.getUTCFullYear(), month, day));
  const todayJST = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate()));
  const diffDays = Math.floor((todayJST - targetJST) / (24 * 60 * 60 * 1000));

  if (diffDays > 3) return null;

  const y = targetJST.getUTCFullYear();
  const m = String(targetJST.getUTCMonth() + 1).padStart(2, '0');
  const d = String(targetJST.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function getScheduledPlans(repmeCode) {
  const now = new Date();
  const { data: tasks, error } = await supabase
    .from('schedule_tasks')
    .select('*')
    .eq('repme_code', repmeCode)
    .eq('plan_type', 'schedule')
    .eq('status', 'planned')
    .not('scheduled_start_at', 'is', null)
    .gte('scheduled_start_at', now.toISOString())
    .order('scheduled_start_at', { ascending: true });
  if (error || !tasks) return [];
  return tasks;
}

function formatPlanList(tasks) {
  if (tasks.length === 0) return '現在の予定はありません';
  const lines = tasks.map((task, i) => {
    const startStr = toJSTTime(task.scheduled_start_at);
    const endStr = task.end_time ? toJSTTime(task.end_time) : null;
    const timeStr = endStr ? `${startStr}〜${endStr}` : `${startStr}〜`;
    return `${i + 1}: ${toJSTDate(task.scheduled_start_at)} ${timeStr} ${task.title || '作業'}`;
  }).join('\n');
  return `📋 現在の予定一覧\n${lines}`;
}

// ========================================
// 当日の総作業時間を取得（Start Plan達成判定用）
// ========================================

async function getTodayTotalMinutes(userId) {
  const today = getTodayJST();
  const todayStartJST = new Date(today + 'T00:00:00+09:00');
  const todayEndJST = new Date(today + 'T23:59:59+09:00');
  const { data: logs } = await supabase
    .from('work_logs')
    .select('minutes')
    .eq('user_id', userId)
    .gte('start_time', todayStartJST.toISOString())
    .lte('start_time', todayEndJST.toISOString());
  return (logs || []).reduce((sum, l) => sum + (l.minutes || 0), 0);
}

// ========================================
// 連続作業日数を計算
// ========================================

async function calcStreak(userId) {
  const jstOffset = 9 * 60 * 60 * 1000;
  let streak = 0;
  let checkDate = new Date(Date.now() + jstOffset);

  while (true) {
    const dateStr = `${checkDate.getUTCFullYear()}-${String(checkDate.getUTCMonth() + 1).padStart(2, '0')}-${String(checkDate.getUTCDate()).padStart(2, '0')}`;
    const startUTC = new Date(dateStr + 'T00:00:00+09:00').toISOString();
    const endUTC = new Date(dateStr + 'T23:59:59+09:00').toISOString();

    const { data: logs } = await supabase
      .from('work_logs')
      .select('id')
      .eq('user_id', userId)
      .gte('start_time', startUTC)
      .lte('start_time', endUTC)
      .limit(1);

    if (!logs || logs.length === 0) break;
    streak++;
    checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
  }

  return streak;
}

// ========================================
// 総作業日数を計算
// ========================================

async function calcTotalDays(userId) {
  const { data: logs } = await supabase
    .from('work_logs')
    .select('start_time')
    .eq('user_id', userId)
    .not('start_time', 'is', null);

  if (!logs || logs.length === 0) return 0;

  const jstOffset = 9 * 60 * 60 * 1000;
  const uniqueDays = new Set(
    logs.map(l => {
      const jst = new Date(new Date(l.start_time).getTime() + jstOffset);
      return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
    })
  );
  return uniqueDays.size;
}

// ========================================
// 当日のStart Plan taskを取得（status問わず）
// ========================================

async function getTodayStartTask(userId) {
  const today = getTodayJST();
  const { data: rows } = await supabase
    .from('schedule_tasks')
    .select('id, target_minutes, status')
    .eq('user_id', userId)
    .eq('plan_type', 'start')
    .eq('task_date', today)
    .limit(1);
  return rows && rows.length > 0 ? rows[0] : null;
}

// ========================================
// Start Plan task自動生成
// ========================================

async function generateStartPlanTask(repmeCode, userId, targetMinutes) {
  const today = getTodayJST();
  const { data: existing } = await supabase
    .from('schedule_tasks').select('id')
    .eq('repme_code', repmeCode).eq('plan_type', 'start').eq('task_date', today).limit(1);
  if (existing && existing.length > 0) return;
  const { error } = await supabase.from('schedule_tasks').insert([{
    repme_code: repmeCode, user_id: userId,
    title: `今日の目標: ${targetMinutes}分`,
    plan_type: 'start', target_minutes: targetMinutes,
    task_date: today, status: 'planned',
    scheduled_start_at: null, source_type: 'auto'
  }]);
  if (error) console.error('Start Plan task生成失敗', error);
}

async function generateAllStartPlanTasks() {
  const today = getTodayJST();
  const { data: plans, error } = await supabase
    .from('plans').select('repme_code, user_id, target_minutes, created_at')
    .eq('plan_type', 'start').order('created_at', { ascending: false });
  if (error || !plans) { console.error('plans取得失敗', error); return; }
  const latestMap = {};
  for (const plan of plans) {
    if (!latestMap[plan.repme_code]) latestMap[plan.repme_code] = plan;
  }
  for (const plan of Object.values(latestMap)) {
    const { data: existing } = await supabase
      .from('schedule_tasks').select('id')
      .eq('repme_code', plan.repme_code).eq('plan_type', 'start').eq('task_date', today).limit(1);
    if (existing && existing.length > 0) continue;
    const { error: insertError } = await supabase.from('schedule_tasks').insert([{
      repme_code: plan.repme_code, user_id: plan.user_id,
      title: `今日の目標: ${plan.target_minutes}分`,
      plan_type: 'start', target_minutes: plan.target_minutes,
      task_date: today, status: 'planned',
      scheduled_start_at: null, source_type: 'auto'
    }]);
    if (insertError) console.error(`${plan.repme_code} Start Plan task生成失敗`, insertError);
    else console.log(`${plan.repme_code} Start Plan task生成: ${plan.target_minutes}分`);
  }
}

function scheduleDailyGeneration() {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const nextMidnightUTC = new Date(Date.UTC(
    nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate() + 1, -9, 0, 0, 0
  ));
  const msUntilMidnight = nextMidnightUTC.getTime() - Date.now();
  setTimeout(() => {
    generateAllStartPlanTasks();
    setInterval(generateAllStartPlanTasks, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
  console.log(`次回0時生成まで: ${Math.floor(msUntilMidnight / 1000 / 60)}分`);
}

// ========================================
// 起動時処理
// ========================================

async function markPastTasksAsMissed() {
  const today = getTodayJST();
  const now = new Date();
  const { error: error1 } = await supabase
    .from('schedule_tasks')
    .update({ status: 'missed' })
    .eq('status', 'planned')
    .lt('task_date', today);
  if (error1) console.error('過去タスクmissed更新失敗', error1);
  const { error: error2 } = await supabase
    .from('schedule_tasks')
    .update({ status: 'missed' })
    .eq('status', 'planned')
    .eq('plan_type', 'schedule')
    .eq('task_date', today)
    .not('scheduled_start_at', 'is', null)
    .lt('scheduled_start_at', now.toISOString());
  if (error2) console.error('当日過去タスクmissed更新失敗', error2);
  else console.log('過去のplannedタスクをmissedに更新しました');
}

// ========================================
// Schedule Plan遅刻通知
// ========================================

async function checkSchedulePlanLate() {
  const now = new Date();
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const today = getTodayJST();
  const { data: tasks, error } = await supabase
    .from('schedule_tasks')
    .select('*')
    .eq('plan_type', 'schedule')
    .eq('status', 'planned')
    .eq('task_date', today)
    .not('scheduled_start_at', 'is', null)
    .lte('scheduled_start_at', tenMinAgo.toISOString());
  if (error || !tasks || tasks.length === 0) return;
  for (const task of tasks) {
    if ((task.notified_count || 0) > 0) continue;
    if (notifyingTaskIds.has(task.id)) continue;
    notifyingTaskIds.add(task.id);
    try {
      const { data: user, error: userError } = await supabase
        .from('users').select('*').eq('repme_code', task.repme_code).single();
      if (userError || !user) { notifyingTaskIds.delete(task.id); continue; }
      const discordUser = await client.users.fetch(task.user_id);
      const title = task.title || '作業';
      await discordUser.send(`【遅刻通知】「${title}」の開始時刻を過ぎています。!in で開始をお願い致します。\n※欠席する場合は、本部への簡単な連絡をお願い致します。`);
      await supabase.from('schedule_tasks').update({
        notified_count: 1,
        last_notified_at: now.toISOString()
      }).eq('id', task.id);
      console.log(`Schedule Plan遅刻通知: ${task.repme_code} ${title}`);
    } catch (err) {
      console.error('Schedule Plan DM失敗', err);
    } finally {
      notifyingTaskIds.delete(task.id);
    }
  }
}

// ========================================
// Start Plan 20時通知
// ========================================

async function checkStartPlanEvening() {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hourJST = nowJST.getUTCHours();
  if (hourJST !== 20) return;
  const today = getTodayJST();
  const { data: tasks, error } = await supabase
    .from('schedule_tasks')
    .select('*')
    .eq('plan_type', 'start')
    .eq('task_date', today);
  if (error || !tasks || tasks.length === 0) return;
  for (const task of tasks) {
    if (task.last_notified_at) {
      const lastJST = new Date(new Date(task.last_notified_at).getTime() + 9 * 60 * 60 * 1000);
      const lastDateStr = `${lastJST.getUTCFullYear()}-${String(lastJST.getUTCMonth() + 1).padStart(2, '0')}-${String(lastJST.getUTCDate()).padStart(2, '0')}`;
      if (lastDateStr === today) continue;
    }
    if (notifyingTaskIds.has(`start_${task.id}`)) continue;
    notifyingTaskIds.add(`start_${task.id}`);
    try {
      const totalLogged = await getTodayTotalMinutes(task.user_id);
      const target = task.target_minutes || 0;
      if (totalLogged >= target) {
        await supabase.from('schedule_tasks').update({ status: 'completed' }).eq('id', task.id);
        console.log(`Start Plan達成済みのため通知スキップ: ${task.repme_code} ${totalLogged}/${target}分`);
        notifyingTaskIds.delete(`start_${task.id}`);
        continue;
      }
      const discordUser = await client.users.fetch(task.user_id);
      await discordUser.send(`【作業リマインド】今日の作業はまだですか？\n目標：${target}分 / 記録：${totalLogged}分\nあと${target - totalLogged}分です。`);
      await supabase.from('schedule_tasks').update({
        notified_count: (task.notified_count || 0) + 1,
        last_notified_at: new Date().toISOString()
      }).eq('id', task.id);
      console.log(`Start Plan 20時通知: ${task.repme_code} ${totalLogged}/${target}分`);
    } catch (err) {
      console.error('Start Plan DM失敗', err);
    } finally {
      notifyingTaskIds.delete(`start_${task.id}`);
    }
  }
}

// ========================================
// 朝6時タスク通知
// ========================================

let lastMorningNotifyDate = null;

async function sendMorningTaskNotifications() {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hourJST = nowJST.getUTCHours();
  if (hourJST !== 6) return;
  const today = getTodayJST();
  if (lastMorningNotifyDate === today) return;
  lastMorningNotifyDate = today;

  const { data: users, error: userError } = await supabase
    .from('users').select('repme_code, user_id');
  if (userError || !users) { console.error('朝通知 users取得失敗', userError); return; }

  const todayStartUTC = new Date(Date.UTC(
    parseInt(today.slice(0, 4)), parseInt(today.slice(5, 7)) - 1, parseInt(today.slice(8, 10)),
    -9, 0, 0, 0
  ));
  const todayEndUTC = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

  for (const user of users) {
    if (!user.user_id) continue;

    const { data: scheduleTasks } = await supabase
      .from('schedule_tasks')
      .select('title, scheduled_start_at, end_time, plan_type, target_minutes')
      .eq('repme_code', user.repme_code)
      .eq('plan_type', 'schedule')
      .gte('scheduled_start_at', todayStartUTC.toISOString())
      .lte('scheduled_start_at', todayEndUTC.toISOString())
      .order('scheduled_start_at', { ascending: true });

    const { data: startTasks } = await supabase
      .from('schedule_tasks')
      .select('title, target_minutes, plan_type')
      .eq('repme_code', user.repme_code)
      .eq('plan_type', 'start')
      .eq('task_date', today);

    const allTasks = [...(startTasks || []), ...(scheduleTasks || [])];
    if (allTasks.length === 0) continue;

    const nowJSTDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateStr = `${nowJSTDate.getUTCFullYear()}/${String(nowJSTDate.getUTCMonth() + 1).padStart(2, '0')}/${String(nowJSTDate.getUTCDate()).padStart(2, '0')}`;

    const taskLines = allTasks.map(task => {
      if (task.plan_type === 'start') {
        return `・${task.title || '今日の目標'} 目標：${task.target_minutes}分（Start）`;
      } else {
        const start = toJSTTime(task.scheduled_start_at);
        const end = task.end_time ? toJSTTime(task.end_time) : null;
        const timeStr = end ? `${start}〜${end}` : `${start}〜`;
        return `・${task.title || '作業'} ${timeStr}（Schedule）`;
      }
    }).join('\n');

    const msg = `おはようございます。\n今日の予定をお知らせします。\n\n📋 ${dateStr} の作業予定\n${taskLines}\n\n今日もよろしくお願いします。`;

    try {
      const discordUser = await client.users.fetch(user.user_id);
      await discordUser.send(msg);
      console.log(`朝通知送信: ${user.repme_code}`);
    } catch (err) {
      console.error(`朝通知失敗: ${user.repme_code}`, err);
    }
  }
}

function startIntervals() {
  setInterval(checkSchedulePlanLate, 60 * 1000);
  setInterval(checkStartPlanEvening, 5 * 60 * 1000);
  setInterval(sendMorningTaskNotifications, 5 * 60 * 1000);
}

// ========================================
// 起動
// ========================================

client.once('ready', async () => {
  console.log(`ログイン成功: ${client.user.tag}`);
  await generateAllStartPlanTasks();
  await markPastTasksAsMissed();
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  if (nowJST.getUTCHours() === 20) await checkStartPlanEvening();
  scheduleDailyGeneration();
  startIntervals();
});

// 入室 → DMチュートリアル開始（実験）
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  console.log(`入室検知: ${member.user.tag} (${member.id})`);
  await beginTutorial(member.user);
});

// ========================================
// メッセージ処理
// ========================================

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const userId = message.author.id;
  const userName = message.author.username;
  const dayMap = { '月': 'mon', '火': 'tue', '水': 'wed', '木': 'thu', '金': 'fri', '土': 'sat', '日': 'sun' };

  // DM: チュートリアル進行
  if (!message.guild || message.channel?.type === ChannelType.DM) {
    const handled = await handleTutorialDM(message);
    if (handled) return;
    return;
  }

  if (content === '!tutorial' || content.startsWith('!tutorial ')) {
    await handleTutorialCommand(message);
    return;
  }

  // !link … 引数なしで自動発行 / !link CODE で既存コード連携
  if (content === '!link' || content.startsWith('!link ')) {
    const arg = content.split(/\s+/)[1];
    const tut = tutorialSessions[userId];
    const inTutorialLink = tut && !isTutorialExpired(tut) && tut.step === 'await_link';

    if (!arg || inTutorialLink) {
      try {
        const existingCode = inTutorialLink ? tut.repmeCode : null;
        const { code, password } = await finalizeTutorialLink(message.author, { existingCode });
        if (inTutorialLink) {
          await advanceTutorialOnLink(userId, code, password);
          await message.reply(`登録完了: ${code}\nパスワードはDMに送りました。確認してください。`);
        } else {
          await message.reply(
            `登録完了\nREPMEコード: ${code}\nパスワード: ${password}\n記録確認: https://repme-web.vercel.app`,
          );
        }
        console.log(`!link 自動登録: ${code} / ${userId}`);
      } catch (err) {
        console.error('!link 自動登録失敗', err);
        await message.reply('登録に失敗しました。もう一度 !link を送ってください。');
      }
      return;
    }

    // 001 → REPME001 を優先（短い 001 行と正規 REPMEXXX が両方あることが多い）
    const resolveExistingLinkCode = async (raw) => {
      const input = String(raw || '').trim();
      if (!input) return null;
      if (/^\d+$/.test(input)) {
        const padded = input.padStart(3, '0');
        for (const c of [`REPME${padded}`, `REPME${input}`]) {
          const { data } = await supabase
            .from('users').select('repme_code').eq('repme_code', c).maybeSingle();
          if (data?.repme_code) return data.repme_code;
        }
      }
      const m = /^REPME(\d+)$/i.exec(input);
      if (m) {
        const padded = m[1].padStart(3, '0');
        const canonical = `REPME${padded}`;
        const { data } = await supabase
          .from('users').select('repme_code').eq('repme_code', canonical).maybeSingle();
        if (data?.repme_code) return data.repme_code;
      }
      const { data: exact } = await supabase
        .from('users').select('repme_code').eq('repme_code', input).maybeSingle();
      if (exact?.repme_code) return exact.repme_code;
      return input;
    };

    const linkCode = await resolveExistingLinkCode(arg);
    // 数字だけ指定で REPME001 が取れた場合、短い 001 行ではなく正規コードへ紐づける
    const { error } = await supabase
      .from('users')
      .upsert({ repme_code: linkCode, user_id: userId }, { onConflict: 'repme_code' });
    if (error) {
      console.error('!link失敗', error);
      return message.reply('連携失敗');
    }
    const note = linkCode !== arg ? `（${arg} → ${linkCode}）` : '';
    return message.reply(`連携完了: ${linkCode}${note}`);
  }

  // !confirm / !recover … 連携済みユーザーへコード＋新しい一時パスワードをDM
  if (content === '!confirm' || content === '!recover') {
    const last = confirmCooldown[userId] || 0;
    if (Date.now() - last < CONFIRM_COOLDOWN_MS) {
      const waitMin = Math.ceil((CONFIRM_COOLDOWN_MS - (Date.now() - last)) / 60000);
      return message.reply(`連続利用を防ぐため、約${waitMin}分あとに再度お試しください。`);
    }

    const { data: rows, error: findError } = await supabase
      .from('users')
      .select('repme_code, user_id')
      .eq('user_id', userId);
    if (findError) {
      console.error('!confirm 検索失敗', findError);
      return message.reply('確認中にエラーが起きました。しばらくして再度お試しください。');
    }
    if (!rows || rows.length === 0) {
      return message.reply(
        'まだDiscord連携されていません。\n先に `!link` または `!link REPMEコード` を送ってください。',
      );
    }

    const preferred = [...rows].sort((a, b) => {
      const aRepme = /^REPME\d+$/i.test(a.repme_code) ? 1 : 0;
      const bRepme = /^REPME\d+$/i.test(b.repme_code) ? 1 : 0;
      return bRepme - aRepme;
    })[0];
    const code = preferred.repme_code;
    const newPassword = generateReadablePassword();

    const { error: updateError } = await supabase
      .from('users')
      .update({ password: newPassword })
      .eq('user_id', userId);
    if (updateError) {
      console.error('!confirm パスワード更新失敗', updateError);
      return message.reply('パスワードの再発行に失敗しました。しばらくして再度お試しください。');
    }

    confirmCooldown[userId] = Date.now();
    const dmOk = await dmUser(
      message.author,
      [
        '【REPME ログイン情報】',
        `REPMEコード: ${code}`,
        `新しいパスワード: ${newPassword}`,
        '',
        'アプリのログイン画面で上記を入力してください。',
        '以前のパスワードは使えなくなっています。',
      ].join('\n'),
    );

    if (dmOk) {
      return message.reply('DMにREPMEコードと新しいパスワードを送りました。確認してください。');
    }
    return message.reply(
      'DMを送れませんでした。\nDiscordの「サーバーメンバーからのダイレクトメッセージ」を許可してから、もう一度 `!confirm` を送ってください。',
    );
  }

  if (content.startsWith('!startplan')) {
    const parts = content.split(/\s+/);
    if (!parts[1]) return message.reply('使い方: !startplan 60');
    const targetMinutes = parseInt(parts[1], 10);
    if (isNaN(targetMinutes) || targetMinutes <= 0) return message.reply('分数は1以上の整数で入力して');
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');
    const { error: planError } = await supabase.from('plans').insert([{
      user_id: userId, repme_code: user.repme_code, plan_type: 'start', target_minutes: targetMinutes
    }]);
    if (planError) { console.error('!startplan insert失敗', planError); return message.reply('Start Plan登録失敗'); }
    await generateStartPlanTask(user.repme_code, userId, targetMinutes);

    const today = getTodayJST();
    const { data: todayTask } = await supabase
      .from('schedule_tasks')
      .select('id, status')
      .eq('user_id', userId)
      .eq('plan_type', 'start')
      .eq('task_date', today)
      .in('status', ['planned', 'in_progress'])
      .limit(1)
      .single();

    if (todayTask) {
      await supabase.from('schedule_tasks')
        .update({ target_minutes: targetMinutes, title: `今日の目標: ${targetMinutes}分` })
        .eq('id', todayTask.id);
      return message.reply(`目標作業時間を${targetMinutes}分に更新しました。`);
    }

    return message.reply(`目標作業時間: ${targetMinutes}分`);
  }

  if (content.startsWith('!plan') && !content.startsWith('!plans')) {
    const parts = content.split(/\s+/);
    if (parts.length < 2) return message.reply('使い方: !plan 14:00 タイトル / !plan 4/17 14:00 タイトル');
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');
    const isTimeStr = (s) => /^\d{1,2}:\d{2}$/.test(s);
    const isDateStr = (s) => /^\d{1,2}\/\d{1,2}$/.test(s);
    let dateTarget = null, startTimeStr = null, endTimeStr = null, titleParts = [];
    if (isDateStr(parts[1])) {
      const parsed = parseDateMD(parts[1]);
      if (parsed === 'past') return message.reply('過去の日付は登録できません');
      if (parsed === 'too_far' || parsed === null) return message.reply('登録できる範囲は当日〜7日後までです');
      dateTarget = parsed;
      startTimeStr = parts[2];
      if (!startTimeStr || !isTimeStr(startTimeStr)) return message.reply('使い方: !plan 4/17 14:00 タイトル');
      if (parts[3] && isTimeStr(parts[3])) { endTimeStr = parts[3]; titleParts = parts.slice(4); }
      else titleParts = parts.slice(3);
    } else if (isTimeStr(parts[1])) {
      startTimeStr = parts[1];
      if (parts[2] && isTimeStr(parts[2])) { endTimeStr = parts[2]; titleParts = parts.slice(3); }
      else titleParts = parts.slice(2);
      const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
      dateTarget = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate(), 0, 0, 0, 0));
    } else {
      return message.reply('使い方: !plan 14:00 タイトル / !plan 4/17 14:00 タイトル');
    }
    const title = titleParts.join(' ') || '作業';
    const startUTC = buildUTCFromDateAndTime(dateTarget, startTimeStr);
    const endUTC = endTimeStr ? buildUTCFromDateAndTime(dateTarget, endTimeStr) : null;
    const jstDate = new Date(dateTarget.getTime() + 9 * 60 * 60 * 1000);
    const displayEnd = endTimeStr ? `〜${endTimeStr}` : '';
    const taskDate = `${jstDate.getUTCFullYear()}-${String(jstDate.getUTCMonth() + 1).padStart(2, '0')}-${String(jstDate.getUTCDate()).padStart(2, '0')}`;
    const { error } = await supabase.from('schedule_tasks').insert([{
      repme_code: user.repme_code, user_id: userId, title,
      start_time: startUTC, scheduled_start_at: startUTC, end_time: endUTC,
      plan_type: 'schedule', status: 'planned', source_type: 'single',
      task_date: taskDate
    }]);
    if (error) { console.error('!plan insert失敗', error); return message.reply('予定登録失敗'); }
    const plans = await getScheduledPlans(user.repme_code);
    return message.reply(`予定登録: ${jstDate.getUTCMonth() + 1}月${jstDate.getUTCDate()}日 ${startTimeStr}${displayEnd}\n\n${formatPlanList(plans)}`);
  }

  if (content === '!plans') {
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');
    const tasks = await getScheduledPlans(user.repme_code);
    return message.reply(formatPlanList(tasks));
  }

  if (content === '!unplan') {
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');
    const tasks = await getScheduledPlans(user.repme_code);
    if (tasks.length === 0) return message.reply('削除できる予定がありません');
    unplanSessions[userId] = { tasks, repmeCode: user.repme_code, expiresAt: Date.now() + 60 * 1000 };
    const lines = tasks.map((t, i) => {
      const startStr = toJSTTime(t.scheduled_start_at);
      const endStr = t.end_time ? toJSTTime(t.end_time) : null;
      const timeStr = endStr ? `${startStr}〜${endStr}` : `${startStr}〜`;
      return `${i + 1}: ${toJSTDate(t.scheduled_start_at)} ${timeStr} ${t.title || '作業'}`;
    }).join('\n');
    return message.reply(`削除したい予定の番号を返信して\n${lines}`);
  }

  if (unplanSessions[userId]) {
    const session = unplanSessions[userId];
    if (Date.now() > session.expiresAt) {
      delete unplanSessions[userId];
    } else {
      const num = parseInt(content, 10);
      if (!isNaN(num) && num >= 1 && num <= session.tasks.length) {
        const task = session.tasks[num - 1];
        const { error: deleteError } = await supabase.from('schedule_tasks').delete().eq('id', task.id);
        delete unplanSessions[userId];
        if (deleteError) return message.reply('削除失敗');
        const startStr = toJSTTime(task.scheduled_start_at);
        const endStr = task.end_time ? toJSTTime(task.end_time) : null;
        const timeStr = endStr ? `${startStr}〜${endStr}` : startStr;
        return message.reply(`${toJSTDate(task.scheduled_start_at)} ${timeStr} ${task.title || '作業'} を削除しました`);
      } else {
        delete unplanSessions[userId];
        return message.reply('番号が正しくありません');
      }
    }
  }

  if (content.startsWith('!schedule ')) {
    const parts = content.split(/\s+/);
    const day = parts[1], start = parts[2], end = parts[3];
    if (!day || !start || !end || !dayMap[day]) return message.reply('使い方: !schedule 月 18:00 22:00');
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');
    const { error } = await supabase.from('weekly_plans').insert([{ repme_code: user.repme_code, user_id: userId, day_of_week: dayMap[day], start_time: start, end_time: end }]);
    if (error) { console.error('!schedule insert失敗', error); return message.reply('週間登録失敗'); }
    return message.reply(`週間登録: ${day} ${start}-${end}`);
  }

  if (content.startsWith('!schedulebulk')) {
    const lines = content.split('\n');
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');
    for (const line of lines) {
      const match = line.match(/([月火水木金土日])[:：]\s*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/);
      if (!match) continue;
      const { error } = await supabase.from('weekly_plans').insert([{ repme_code: user.repme_code, user_id: userId, day_of_week: dayMap[match[1]], start_time: match[2], end_time: match[3] }]);
      if (error) console.error('!schedulebulk insert失敗', error);
    }
    return message.reply('週間スケジュール登録完了');
  }

  // ========================================
  // !absent（欠席届）
  // ========================================

  if (content.startsWith('!absent')) {
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');

    const reportDate = parseReportDate(content);
    if (!reportDate) return message.reply('対象日が古すぎます。3日以内の日付で提出してください。');

    const { data: existing } = await supabase
      .from('absence_reports')
      .select('id')
      .eq('repme_code', user.repme_code)
      .eq('report_date', reportDate)
      .eq('report_type', 'absent')
      .limit(1);
    if (existing && existing.length > 0) return message.reply('今日は欠席届を提出済みです');

    const { error: insertError } = await supabase.from('absence_reports').insert([{
      repme_code: user.repme_code,
      user_id: userId,
      report_date: reportDate,
      report_type: 'absent'
    }]);
    if (insertError) { console.error('!absent insert失敗', insertError); return message.reply('欠席届の登録に失敗しました'); }

    console.log(`欠席届受信: ${user.repme_code} ${reportDate}`);
    return message.reply('欠席届を受信しました。');
  }

  // ========================================
  // !in
  // バグ修正②: Schedule Planのtask再アタッチ
  // end_timeがまだ先のtaskにアタッチされるよう修正
  // planned / in_progress / completed を対象に、end_time > now のものを優先取得
  // ========================================

  if (content === '!in') {
    if (sessions[userId]) return message.reply('すでに作業中');
    const { user, error: userError } = await findUserByDiscordId(userId);
    if (userError || !user) return message.reply('先に !link で連携して');

    const today = getTodayJST();
    const now = new Date();

    // Schedule Plan: end_timeがまだ先のtaskを優先（planned/in_progress/completedを対象）
    const { data: scheduleTasks, error: scheduleError } = await supabase
      .from('schedule_tasks').select('*')
      .eq('user_id', userId)
      .in('status', ['planned', 'in_progress', 'completed'])
      .eq('plan_type', 'schedule')
      .eq('task_date', today)
      .not('scheduled_start_at', 'is', null)
      .gt('end_time', now.toISOString())
      .order('scheduled_start_at', { ascending: true })
      .limit(1);
    if (scheduleError) return message.reply('task取得失敗');

    let task = scheduleTasks && scheduleTasks.length > 0 ? scheduleTasks[0] : null;

    if (!task) {
      const { data: startTasks, error: startError } = await supabase
        .from('schedule_tasks').select('*')
        .eq('user_id', userId)
        .eq('plan_type', 'start')
        .eq('task_date', today)
        .limit(1);
      if (startError) return message.reply('task取得失敗');
      task = startTasks && startTasks.length > 0 ? startTasks[0] : null;
    }

    if (!task) {
      sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: null, planType: null, taskEndTime: null };
      await message.reply('作業開始');
      await advanceTutorialOnGuildAction(userId, 'in');
      return;
    }

    if (task.plan_type === 'start') {
      if (task.status === 'planned') {
        await supabase.from('schedule_tasks').update({ status: 'in_progress' }).eq('id', task.id);
      }
      sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: task.id, planType: 'start', taskEndTime: null };
      await message.reply('作業開始');
      await advanceTutorialOnGuildAction(userId, 'in');
      return;
    }

    if (task.status === 'planned') {
      const { error: updateError } = await supabase.from('schedule_tasks').update({ status: 'in_progress' }).eq('id', task.id);
      if (updateError) return message.reply('task開始失敗');
    }

    sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: task.id, planType: 'schedule', taskEndTime: task.end_time || null };
    await message.reply('作業開始');
    await advanceTutorialOnGuildAction(userId, 'in');
    return;
  }

  // ========================================
  // !out
  // バグ修正①: Schedule Plan表示
  // - end_timeはsession.taskEndTimeのみ参照（次taskは見ない）
  // - end_time過ぎ or なし → 当日plannedのschedule taskが残ってるか確認して文言分岐
  // ========================================

  if (content === '!out') {
    const session = sessions[userId];
    if (!session) return message.reply('開始してない');
    const minutes = Math.floor((Date.now() - session.start) / 60000);
    try {
      const { error: logError } = await supabase.from('work_logs').insert([{
        user_name: session.userName, minutes, user_id: userId,
        repme_code: session.repmeCode, task_id: session.taskId,
        type: 'realtime', start_time: new Date(session.start).toISOString(), end_time: new Date().toISOString()
      }]);
      if (logError) { console.error('!out work_logs保存失敗', logError); delete sessions[userId]; return message.reply('ログ保存失敗'); }

      if (session.taskId !== null && session.planType === 'schedule') {
        const { error: taskUpdateError } = await supabase.from('schedule_tasks').update({ status: 'completed' }).eq('id', session.taskId);
        if (taskUpdateError) { delete sessions[userId]; return message.reply('ログは保存したけどtask完了更新失敗'); }
      }

      // Start Plan達成判定（表示はしないがDB更新は継続）
      const todayStartTask = await getTodayStartTask(userId);
      if (todayStartTask && todayStartTask.target_minutes) {
        const totalMinutes = await getTodayTotalMinutes(userId);
        if (totalMinutes >= todayStartTask.target_minutes && todayStartTask.status !== 'completed') {
          await supabase.from('schedule_tasks').update({ status: 'completed' }).eq('id', todayStartTask.id);
          console.log(`Start Plan達成: ${session.repmeCode} ${totalMinutes}/${todayStartTask.target_minutes}分`);
        }
      }

      delete sessions[userId];
      await message.reply(`完了: ${minutes}分`);
      await advanceTutorialOnGuildAction(userId, 'out');
      return;
    } catch (err) {
      console.error('!out 例外', err);
      delete sessions[userId];
      return message.reply('ログ保存失敗');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);