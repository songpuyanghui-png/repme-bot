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
const unplanSessions = {};

const notifyingTaskIds = new Set();

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
    const { data: user, error: userError } = await supabase.from('users').select('repme_code').eq('user_id', userId).single();
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
    const { data: user, error: userError } = await supabase
      .from('users').select('repme_code').eq('user_id', userId).single();
    if (userError || !user) return message.reply('先に !link で連携して');
    const tasks = await getScheduledPlans(user.repme_code);
    return message.reply(formatPlanList(tasks));
  }

  if (content === '!unplan') {
    const { data: user, error: userError } = await supabase
      .from('users').select('repme_code').eq('user_id', userId).single();
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

    if (!task) {
      sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: null, planType: null, taskEndTime: null };
      return message.reply('作業開始。終わったら !out して');
    }

    const { error: updateError } = await supabase.from('schedule_tasks').update({ status: 'in_progress' }).eq('id', task.id);
    if (updateError) return message.reply('task開始失敗');
    sessions[userId] = { start: Date.now(), userName, repmeCode: user.repme_code, taskId: task.id, planType: task.plan_type, taskEndTime: task.end_time || null };
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

      if (session.taskId !== null) {
        const { error: taskUpdateError } = await supabase.from('schedule_tasks').update({ status: 'completed' }).eq('id', session.taskId);
        if (taskUpdateError) { delete sessions[userId]; return message.reply('ログは保存したけどtask完了更新失敗'); }
      }

      // Start Plan達成チェック（当日の総作業時間で判定）
      const today = getTodayJST();
      const { data: startTaskRows } = await supabase
        .from('schedule_tasks')
        .select('id, target_minutes, status')
        .eq('user_id', userId)
        .eq('plan_type', 'start')
        .eq('task_date', today)
        .in('status', ['planned', 'in_progress', 'late'])
        .limit(1);

      const startTask = startTaskRows && startTaskRows.length > 0 ? startTaskRows[0] : null;
      if (startTask && startTask.target_minutes) {
        const totalMinutes = await getTodayTotalMinutes(userId);
        if (totalMinutes >= startTask.target_minutes) {
          await supabase.from('schedule_tasks').update({ status: 'completed' }).eq('id', startTask.id);
          console.log(`Start Plan達成: ${session.repmeCode} ${totalMinutes}/${startTask.target_minutes}分`);
        }
      }

      const streak = await calcStreak(userId);
      const totalDays = await calcTotalDays(userId);
      const statsLine = `連続: ${streak}日 参加: ${totalDays}日`;

      let replyMsg = `完了: ${minutes}分\n`;

      if (session.planType === 'start') {
        const totalMinutes = await getTodayTotalMinutes(userId);
        const target = startTask ? startTask.target_minutes : 0;
        if (target && totalMinutes >= target) {
          replyMsg += `目標達成済み ✅\n`;
        } else if (target) {
          replyMsg += `目標まで残り${target - totalMinutes}分\n`;
        }
        replyMsg += statsLine;
      } else if (session.planType === 'schedule') {
        const now = new Date();
        const endTime = session.taskEndTime ? new Date(session.taskEndTime) : null;
        if (endTime && now < endTime) {
          const remainMin = Math.ceil((endTime.getTime() - now.getTime()) / 60000);
          replyMsg += `終了まで残り${remainMin}分\n`;
          replyMsg += statsLine;
        } else {
          replyMsg += statsLine + '\n次のスケジュールを提出してください。';
        }
      } else {
        replyMsg += statsLine;
      }

      delete sessions[userId];
      return message.reply(replyMsg);
    } catch (err) {
      console.error('!out 例外', err);
      delete sessions[userId];
      return message.reply('ログ保存失敗');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);