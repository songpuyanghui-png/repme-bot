require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY
);

const sessions = {};

// 二重送信防止用メモリフラグ
const notifyingTaskIds = new Set();

// ========================================
// ユーティリティ
// ========================================

function buildUTCFromDateAndTime(dateJST, timeText) {
  const [hour, minute] = timeText.split(':').map(Number);
  return new Date(Date.UTC(
    dateJST.getUTCFullYear(), dateJST.getUTCMonth(), dateJST.getUTCDate(),
    hour - 9, minute, 0, 0
  )).toISOString();
}

function parseDateMD(mdStr) {
  const match = mdStr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const month = parseInt(match[1], 10) - 1;
  const day = parseInt(match[2], 10);
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const target = new Date(Date.UTC(nowJST.getUTCFullYear(), month, day, -9, 0, 0, 0));
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
// 起動時: 過去の未通知タスクを通知済みにする
// 再起動のたびに古いタスクが拾われるのを防ぐ
// ========================================

async function markPastTasksAsNotified() {
  const now = new Date();
  const { error } = await supabase
    .from('schedule_tasks')
    .update({ notified_count: 1 })
    .eq('plan_type', 'schedule')
    .eq('status', 'planned')
    .lt('scheduled_start_at', now.toISOString())
    .eq('notified_count', 0);
  if (error) {
    console.error('過去タスク通知済み処理失敗', error);
  } else {
    console.log('過去の未通知タスクを通知済みにしました');
  }
}

// ========================================
// Schedule Plan遅刻通知
// 条件: scheduled_start_atから10分経過 + statusがplanned
// 対象: 当日のtaskのみ
// ========================================

async function checkSchedulePlanLate() {
  const now = new Date();
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const today = getTodayJST();

  // task_date基準で当日のtaskを絞る（UTC/JST日付ズレ対策）
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
    // DBの通知済みフラグチェック
    if ((task.notified_count || 0) > 0) continue;

    // メモリフラグで二重送信防止
    if (notifyingTaskIds.has(task.id)) continue;
    notifyingTaskIds.add(task.id);

    try {
      const { data: user, error: userError } = await supabase
        .from('users').select('*').eq('repme_code', task.repme_code).single();
      if (userError || !user) { notifyingTaskIds.delete(task.id); continue; }

      const discordUser = await client.users.fetch(task.user_id);
      const title = task.title || '作業';
      await discordUser.send(`【遅刻通知】「${title}」の開始時刻を過ぎています。今すぐ !in で開始して。`);

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
// Start Plan 20時通知（JST）
// 条件: JST 20:00台 + 当日未達成 + 当日未通知
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
    // 当日送信済みチェック
    if (task.last_notified_at) {
      const lastJST = new Date(new Date(task.last_notified_at).getTime() + 9 * 60 * 60 * 1000);
      const lastDateStr = `${lastJST.getUTCFullYear()}-${String(lastJST.getUTCMonth() + 1).padStart(2, '0')}-${String(lastJST.getUTCDate()).padStart(2, '0')}`;
      if (lastDateStr === today) continue;
    }

    // メモリフラグで二重送信防止
    if (notifyingTaskIds.has(`start_${task.id}`)) continue;
    notifyingTaskIds.add(`start_${task.id}`);

    try {
      const { data: logs } = await supabase
        .from('work_logs').select('minutes')
        .eq('repme_code', task.repme_code).eq('task_id', task.id);

      const totalLogged = (logs || []).reduce((sum, l) => sum + (l.minutes || 0), 0);
      const target = task.target_minutes || 0;

      if (totalLogged >= target) { notifyingTaskIds.delete(`start_${task.id}`); continue; }

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
// 朝6時タスク通知（JST 6:00 = UTC 21:00）
// ========================================

async function sendMorningTaskNotifications() {
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hourJST = nowJST.getUTCHours();
  if (hourJST !== 6) return;

  const today = getTodayJST();

  // 全ユーザーを取得
  const { data: users, error: userError } = await supabase
    .from('users').select('repme_code, user_id');
  if (userError || !users) { console.error('朝通知 users取得失敗', userError); return; }

  // JSTの今日の範囲（UTC）
  const todayStartUTC = new Date(Date.UTC(
    parseInt(today.slice(0, 4)), parseInt(today.slice(5, 7)) - 1, parseInt(today.slice(8, 10)),
    -9, 0, 0, 0
  ));
  const todayEndUTC = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);

  for (const user of users) {
    if (!user.user_id) continue;

    // 当日のschedule tasks（schedule plan）
    const { data: scheduleTasks } = await supabase
      .from('schedule_tasks')
      .select('title, scheduled_start_at, end_time, plan_type, target_minutes')
      .eq('repme_code', user.repme_code)
      .eq('plan_type', 'schedule')
      .gte('scheduled_start_at', todayStartUTC.toISOString())
      .lte('scheduled_start_at', todayEndUTC.toISOString())
      .order('scheduled_start_at', { ascending: true });

    // 当日のstart tasks
    const { data: startTasks } = await supabase
      .from('schedule_tasks')
      .select('title, target_minutes, plan_type')
      .eq('repme_code', user.repme_code)
      .eq('plan_type', 'start')
      .eq('task_date', today);

    const allTasks = [...(startTasks || []), ...(scheduleTasks || [])];
    if (allTasks.length === 0) continue;

    // メッセージ組み立て
    const nowJSTDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateStr = `${nowJSTDate.getUTCFullYear()}/${String(nowJSTDate.getUTCMonth() + 1).padStart(2, '0')}/${String(nowJSTDate.getUTCDate()).padStart(2, '0')}`;

    const toJSTTime = (utcStr) => {
      if (!utcStr) return null;
      const d = new Date(utcStr + 'Z');
      const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    };

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


// 起動時: 過去の未通知タスクを通知済みにする
async function markPastTasksAsNotified() {
  const now = new Date();
  const { error } = await supabase
    .from('schedule_tasks')
    .update({ notified_count: 1 })
    .eq('plan_type', 'schedule')
    .eq('status', 'planned')
    .lt('scheduled_start_at', now.toISOString())
    .eq('notified_count', 0);
  if (error) {
    console.error('過去タスク通知済み処理失敗', error);
  } else {
    console.log('過去の未通知タスクを通知済みにしました');
  }
}function startIntervals() {
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

  // 起動時に過去の未通知タスクを通知済みにする（再起動時の誤通知防止）
  await markPastTasksAsNotified();

  // 20時台に起動した場合のStart Plan通知チェック
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  if (nowJST.getUTCHours() === 20) await checkStartPlanEvening();

  scheduleDailyGeneration();
  await markPastTasksAsNotified();  startIntervals();
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

  if (content.startsWith('!link')) {
    const code = content.split(/\s+/)[1];
    if (!code) return message.reply('使い方: !link REPME_CODE');
    const { error } = await supabase.from('users').upsert({ repme_code: code, user_id: userId }, { onConflict: 'repme_code' });
    if (error) { console.error('!link失敗', error); return message.reply('連携失敗'); }
    return message.reply(`連携完了: ${code}`);
  }

  if (content.startsWith('!startplan')) {
    const parts = content.split(/\s+/);
    if (!parts[1]) return message.reply('使い方: !startplan 60');
    const targetMinutes = parseInt(parts[1], 10);
    if (isNaN(targetMinutes) || targetMinutes <= 0) return message.reply('分数は1以上の整数で入力して');
    const { data: user, error: userError } = await supabase.from('users').select('repme_code').eq('user_id', userId).single();
    if (userError || !user) return message.reply('先に !link で連携して');
    const { error: planError } = await supabase.from('plans').insert([{
      user_id: userId, repme_code: user.repme_code, plan_type: 'start', target_minutes: targetMinutes
    }]);
    if (planError) { console.error('!startplan insert失敗', planError); return message.reply('Start Plan登録失敗'); }
    await generateStartPlanTask(user.repme_code, userId, targetMinutes);
    return message.reply(`目標作業時間: ${targetMinutes}分`);
  }

  if (content.startsWith('!plan')) {
    const parts = content.split(/\s+/);
    if (parts.length < 2) return message.reply('使い方: !plan 14:00 タイトル / !plan 4/17 14:00 タイトル');
    const { data: user, error: userError } = await supabase.from('users').select('repme_code').eq('user_id', userId).single();
    if (userError || !user) return message.reply('先に !link で連携して');
    const isTimeStr = (s) => /^\d{1,2}:\d{2}$/.test(s);
    const isDateStr = (s) => /^\d{1,2}\/\d{1,2}$/.test(s);
    let dateTarget = null, startTimeStr = null, endTimeStr = null, titleParts = [];
    if (isDateStr(parts[1])) {
      const parsed = parseDateMD(parts[1]);
      if (parsed === 'past') return message.reply('過去の日付は登録できません');
      if (parsed === 'too_far' || parsed === null) return message.reply('登録できる範囲は当日〜7日後までです（例: 4/17）');
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
    return message.reply(`予定登録: ${jstDate.getUTCMonth() + 1}月${jstDate.getUTCDate()}日 ${startTimeStr}${displayEnd}`);
  }

  if (content.startsWith('!schedule ')) {
    const parts = content.split(/\s+/);
    const day = parts[1], start = parts[2], end = parts[3];
    if (!day || !start || !end || !dayMap[day]) return message.reply('使い方: !schedule 月 18:00 22:00');
    const { data: user, error: userError } = await supabase.from('users').select('repme_code').eq('user_id', userId).single();
    if (userError || !user) return message.reply('先に !link で連携して');
    const { error } = await supabase.from('weekly_plans').insert([{ repme_code: user.repme_code, user_id: userId, day_of_week: dayMap[day], start_time: start, end_time: end }]);
    if (error) { console.error('!schedule insert失敗', error); return message.reply('週間登録失敗'); }
    return message.reply(`週間登録: ${day} ${start}-${end}`);
  }

  if (content.startsWith('!schedulebulk')) {
    const lines = content.split('\n');
    const { data: user, error: userError } = await supabase.from('users').select('repme_code').eq('user_id', userId).single();
    if (userError || !user) return message.reply('先に !link で連携して');
    for (const line of lines) {
      const match = line.match(/([月火水木金土日])[:：]\s*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/);
      if (!match) continue;
      const { error } = await supabase.from('weekly_plans').insert([{ repme_code: user.repme_code, user_id: userId, day_of_week: dayMap[match[1]], start_time: match[2], end_time: match[3] }]);
      if (error) console.error('!schedulebulk insert失敗', error);
    }
    return message.reply('週間スケジュール登録完了');
  }

  if (content === '!in') {
    if (sessions[userId]) return message.reply('すでに作業中');
    const { data: user, error: userError } = await supabase.from('users').select('repme_code').eq('user_id', userId).single();
    if (userError || !user) return message.reply('先に !link で連携して');
<<<<<<< Updated upstream
    const { data: tasks, error: taskError } = await supabase.from('schedule_tasks').select('*').eq('user_id', userId).eq('status', 'planned').order('start_time', { ascending: true }).limit(1);
    if (taskError) return message.reply('task取得失敗');
    if (!tasks || tasks.length === 0) return message.reply('今日の予定がない。先に !plan して');
    const task = tasks[0];
=======

    const today = getTodayJST();
    const { data: scheduleTasks, error: scheduleError } = await supabase
      .from('schedule_tasks').select('*')
      .eq('user_id', userId).eq('status', 'planned')
      .eq('plan_type', 'schedule').eq('task_date', today)
      .not('scheduled_start_at', 'is', null)
      .order('scheduled_start_at', { ascending: true }).limit(1);
    if (scheduleError) return message.reply('task取得失敗');

    let task = scheduleTasks && scheduleTasks.length > 0 ? scheduleTasks[0] : null;

    if (!task) {
      const { data: startTasks, error: startError } = await supabase
        .from('schedule_tasks').select('*')
        .eq('user_id', userId).eq('status', 'planned')
        .eq('plan_type', 'start').eq('task_date', today).limit(1);
      if (startError) return message.reply('task取得失敗');
      task = startTasks && startTasks.length > 0 ? startTasks[0] : null;
    }

    // planなしの場合：task_id = null でそのまま開始
    if (!task) {
      sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: null };
      return message.reply('作業開始。終わったら !out して');
    }

>>>>>>> Stashed changes
    const { error: updateError } = await supabase.from('schedule_tasks').update({ status: 'in_progress' }).eq('id', task.id);
    if (updateError) return message.reply('task開始失敗');
    sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: task.id };
    return message.reply(`作業開始: ${task.title || '作業'}`);
  }

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

      // taskId がある場合のみ schedule_tasks を更新
      if (session.taskId !== null) {
        const { error: taskUpdateError } = await supabase.from('schedule_tasks').update({ status: 'completed' }).eq('id', session.taskId);
        if (taskUpdateError) { delete sessions[userId]; return message.reply('ログは保存したけどtask完了更新失敗'); }
      }

      delete sessions[userId];
      return message.reply(`完了: ${minutes}分`);
    } catch (err) {
      console.error('!out 例外', err);
      delete sessions[userId];
      return message.reply('ログ保存失敗');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);