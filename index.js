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

// セッション管理
const sessions = {};

client.once('ready', () => {
  console.log(`ログイン成功: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const content = message.content.trim();
    const userId = message.author.id;
    const userName = message.author.username;

    console.log(`受信: ${content} / userId: ${userId}`);

    // -------------------------
    // !myid
    // -------------------------
    if (content === '!myid') {
      return message.reply(`your discord id: ${userId}`);
    }

    // -------------------------
    // !link
    // -------------------------
    if (content.startsWith('!link')) {
      const parts = content.split(/\s+/);
      const repmeCode = parts[1];

      if (!repmeCode) {
        return message.reply('使い方: !link REPME004');
      }

      const { data: targetUser, error: targetError } = await supabase
        .from('users')
        .select('repme_code, user_id')
        .eq('repme_code', repmeCode)
        .single();

      if (targetError || !targetUser) {
        return message.reply('そのREPMEコードは存在しません');
      }

      if (targetUser.user_id && targetUser.user_id !== userId) {
        return message.reply('このREPMEコードはすでに他のアカウントと連携されています');
      }

      const { data: alreadyLinkedUser } = await supabase
        .from('users')
        .select('repme_code')
        .eq('user_id', userId)
        .maybeSingle();

      if (alreadyLinkedUser && alreadyLinkedUser.repme_code !== repmeCode) {
        return message.reply(`すでに ${alreadyLinkedUser.repme_code} と連携されています`);
      }

      const { error: updateError } = await supabase
        .from('users')
        .update({ user_id: userId })
        .eq('repme_code', repmeCode);

      if (updateError) {
        return message.reply('連携に失敗しました');
      }

      return message.reply(`連携成功: ${repmeCode}`);
    }

    // -------------------------
    // !in
    // -------------------------
    if (content === '!in') {
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('repme_code')
        .eq('user_id', userId)
        .single();

      if (userError || !userData) {
        return message.reply('先に !link で連携してください');
      }

      if (sessions[userId]) {
        return message.reply('すでに開始しています');
      }

      sessions[userId] = {
        start: Date.now(),
        userName,
        repmeCode: userData.repme_code
      };

      return message.reply(`作業開始`);
    }

    // -------------------------
    // !out
    // -------------------------
    if (content === '!out') {
      const session = sessions[userId];

      if (!session) {
        return message.reply('開始記録なし');
      }

      const end = Date.now();
      const minutes = Math.floor((end - session.start) / 60000);

      delete sessions[userId];

      const { error } = await supabase
        .from('work_logs')
        .insert([
          {
            user_name: session.userName,
            minutes,
            user_id: userId,
            repme_code: session.repmeCode,
            type: 'realtime'
          }
        ]);

      if (error) {
        return message.reply('保存失敗');
      }

      return message.reply(`作業時間: ${minutes}分`);
    }

  } catch (err) {
    console.error(err);
    return message.reply('エラー発生').catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);