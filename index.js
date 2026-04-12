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

// ========================================
// ユーティリティ
// ========================================
function parseTimeToDate(timeText) {
  const [hour, minute] = timeText.split(':').map(Number);

  const now = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);

  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}

const dayMap = {
  '月': 'mon',
  '火': 'tue',
  '水': 'wed',
  '木': 'thu',
  '金': 'fri',
  '土': 'sat',
  '日': 'sun'
};

// ========================================
// 遅刻通知チェック（複数回対応）
// ========================================
async function checkLateTasks() {
  const now = new Date();

  const { data: tasks } = await supabase
    .from('schedule_tasks')
    .select('*')
    .eq('status', 'pending');

  if (!tasks) return;

  for (const task of tasks) {
    const start = new Date(task.start_time);

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('repme_code', task.repme_code)
      .single();

    if (!user || !user.dm_notice_enabled) continue;

    const diff = (now - start) / 1000 / 60;

    const firstDelay = user.late_notice_after_minutes;
    const repeatInterval = user.late_notice_repeat_interval_minutes;
    const maxCount = user.late_notice_repeat_count;

    const notifiedCount = task.notified_count || 0;

    // 初回通知
    if (notifiedCount === 0 && diff >= firstDelay) {
      await sendDM(task, user, 1);
    }

    // 2回目以降
    if (notifiedCount > 0 && notifiedCount < maxCount) {
      const last = new Date(task.last_notified_at || task.start_time);
      const sinceLast = (now - last) / 1000 / 60;

      if (sinceLast >= repeatInterval) {
        await sendDM(task, user, notifiedCount + 1);
      }
    }
  }
}

async function sendDM(task, user, count) {
  try {
    const discordUser = await client.users.fetch(task.user_id);

    await discordUser.send(`【遅刻通知 ${count}回目】まだ始まってない。今戻せ。`);

    await supabase
      .from('schedule_tasks')
      .update({
        notified_count: count,
        last_notified_at: new Date().toISOString()
      })
      .eq('id', task.id);

  } catch (err) {
    console.error('DM失敗', err);
  }
}

// ========================================
// 起動
// ========================================
client.once('ready', () => {
  console.log(`ログイン成功: ${client.user.tag}`);
  setInterval(checkLateTasks, 60000);
});

// ========================================
// メッセージ処理
// ========================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const userId = message.author.id;
  const userName = message.author.username;

  // ----------------------------------
  // !link
  // ----------------------------------
  if (content.startsWith('!link')) {
    const code = content.split(/\s+/)[1];

    const { data } = await supabase
      .from('users')
      .update({ user_id: userId })
      .eq('repme_code', code);

    return message.reply(`連携完了: ${code}`);
  }

  // ----------------------------------
  // !plan
  // ----------------------------------
  if (content.startsWith('!plan')) {
    const parts = content.split(/\s+/);
    const timeText = parts[1];
    const title = parts.slice(2).join(' ') || '作業';

    const { data: user } = await supabase
      .from('users')
      .select('repme_code')
      .eq('user_id', userId)
      .single();

    const start = parseTimeToDate(timeText);

    await supabase.from('schedule_tasks').insert([
      {
        repme_code: user.repme_code,
        user_id: userId,
        title,
        start_time: start.toISOString(),
        status: 'pending',
        source_type: 'single'
      }
    ]);

    return message.reply(`予定登録: ${timeText}`);
  }

  // ----------------------------------
  // !schedule（月 18:00 22:00）
  // ----------------------------------
  if (content.startsWith('!schedule ')) {
    const parts = content.split(/\s+/);
    const day = parts[1];
    const start = parts[2];
    const end = parts[3];

    const { data: user } = await supabase
      .from('users')
      .select('repme_code')
      .eq('user_id', userId)
      .single();

    await supabase.from('weekly_plans').insert([
      {
        repme_code: user.repme_code,
        user_id: userId,
        day_of_week: dayMap[day],
        start_time: start,
        end_time: end
      }
    ]);

    return message.reply(`週間登録: ${day} ${start}-${end}`);
  }

  // ----------------------------------
  // !schedulebulk
  // ----------------------------------
  if (content.startsWith('!schedulebulk')) {

    const lines = content.split('\n');

    const { data: user } = await supabase
      .from('users')
      .select('repme_code')
      .eq('user_id', userId)
      .single();

    for (const line of lines) {
      const match = line.match(/([月火水木金土日])[:：]\s*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/);

      if (!match) continue;

      const day = match[1];
      const start = match[2];
      const end = match[3];

      await supabase.from('weekly_plans').insert([
        {
          repme_code: user.repme_code,
          user_id: userId,
          day_of_week: dayMap[day],
          start_time: start,
          end_time: end
        }
      ]);
    }

    return message.reply('週間スケジュール登録完了');
  }

  // ----------------------------------
  // !in
  // ----------------------------------
  if (content === '!in') {
    const { data: user } = await supabase
      .from('users')
      .select('repme_code')
      .eq('user_id', userId)
      .single();

    sessions[userId] = {
      start: Date.now(),
      userName,
      repmeCode: user.repme_code
    };

    // 一番近い予定だけ started
    const { data: tasks } = await supabase
      .from('schedule_tasks')
      .select('*')
      .eq('repme_code', user.repme_code)
      .eq('status', 'pending')
      .order('start_time', { ascending: true })
      .limit(1);

    if (tasks && tasks.length > 0) {
      await supabase
        .from('schedule_tasks')
        .update({ status: 'started' })
        .eq('id', tasks[0].id);
    }

    return message.reply('作業開始');
  }

  // ----------------------------------
  // !out
  // ----------------------------------
  if (content === '!out') {
    const session = sessions[userId];
    if (!session) return message.reply('開始してない');

    const minutes = Math.floor((Date.now() - session.start) / 60000);

    await supabase.from('work_logs').insert([
      {
        user_name: session.userName,
        minutes,
        user_id: userId,
        repme_code: session.repmeCode,
        type: 'realtime'
      }
    ]);

    delete sessions[userId];

    return message.reply(`完了: ${minutes}分`);
  }

});

client.login(process.env.DISCORD_TOKEN);