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

// ユーザーごとの開始時刻をメモリ保存
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

<<<<<<< HEAD
=======
    // 自分のDiscord ID確認
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
    if (content === '!myid') {
      return message.reply(`your discord id: ${userId}`);
    }

<<<<<<< HEAD
=======
    // -------------------------
    // !link REPME004
    // -------------------------
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
    if (content.startsWith('!link')) {
      const parts = content.split(/\s+/);
      const repmeCode = parts[1];

      if (!repmeCode) {
        return message.reply('使い方: !link REPME004');
      }

<<<<<<< HEAD
=======
      // まずそのREPMEコードが存在するか確認
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
      const { data: targetUser, error: targetError } = await supabase
        .from('users')
        .select('repme_code, user_id')
        .eq('repme_code', repmeCode)
        .single();

      if (targetError || !targetUser) {
        console.log('REPMEコード確認エラー:', targetError);
        return message.reply('そのREPMEコードは存在しません');
      }

<<<<<<< HEAD
=======
      // すでに他のDiscord IDに紐付いている場合
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
      if (targetUser.user_id && targetUser.user_id !== userId) {
        return message.reply('このREPMEコードはすでに他のDiscordアカウントと連携されています');
      }

<<<<<<< HEAD
=======
      // 自分が別のREPMEコードに紐付いていないか確認
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
      const { data: alreadyLinkedUser, error: alreadyLinkedError } = await supabase
        .from('users')
        .select('repme_code')
        .eq('user_id', userId)
        .maybeSingle();

      if (alreadyLinkedError) {
        console.log('既存連携確認エラー:', alreadyLinkedError);
        return message.reply('連携確認中にエラーが起きました');
      }

      if (alreadyLinkedUser && alreadyLinkedUser.repme_code !== repmeCode) {
        return message.reply(
          `すでに ${alreadyLinkedUser.repme_code} と連携されています。\n別コードに変える場合は管理側で解除してください`
        );
      }

<<<<<<< HEAD
=======
      // 紐付け実行
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
      const { error: updateError } = await supabase
        .from('users')
        .update({ user_id: userId })
        .eq('repme_code', repmeCode);

      if (updateError) {
        console.log('連携更新エラー:', updateError);
        return message.reply('連携に失敗しました');
      }

      return message.reply(`連携成功\nDiscord ID と ${repmeCode} を紐付けました`);
    }

<<<<<<< HEAD
=======
    // -------------------------
    // !in
    // -------------------------
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
    if (content === '!in') {
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('repme_code')
        .eq('user_id', userId)
        .single();

      if (userError || !userData) {
        console.log('users取得エラー:', userError);
        return message.reply('まだ連携されていません。\n!link REPMEコード で連携してください');
      }

      if (sessions[userId]) {
        return message.reply('すでに作業開始済みです');
      }

      sessions[userId] = {
        start: Date.now(),
<<<<<<< HEAD
        userName: userName,
=======
        userName,
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
        repmeCode: userData.repme_code
      };

      return message.reply(`作業開始を記録しました\nREPMEコード: ${userData.repme_code}`);
    }

<<<<<<< HEAD
=======
    // -------------------------
    // !out
    // -------------------------
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
    if (content === '!out') {
      const session = sessions[userId];

      if (!session) {
        return message.reply('開始記録がありません');
      }

      const end = Date.now();
      const minutes = Math.floor((end - session.start) / 60000);

      delete sessions[userId];

      const startTime = new Date(session.start).toISOString();
      const endTime = new Date(end).toISOString();

<<<<<<< HEAD
      const { error: insertError } = await supabase
=======
      const { error } = await supabase
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
        .from('work_logs')
        .insert([
          {
            user_name: session.userName,
<<<<<<< HEAD
            minutes: minutes,
=======
            minutes,
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
            start_time: startTime,
            end_time: endTime,
            user_id: userId,
            repme_code: session.repmeCode,
            type: 'realtime'
          }
        ]);

<<<<<<< HEAD
      if (insertError) {
        console.log('Supabase保存エラー:', insertError);
=======
      if (error) {
        console.log('Supabase保存エラー:', error);
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
        return message.reply(`作業時間: ${minutes}分\nDB保存失敗`);
      }

      return message.reply(
        `作業時間: ${minutes}分\n保存成功\nREPMEコード: ${session.repmeCode}`
      );
    }
  } catch (err) {
    console.error('messageCreate 全体エラー:', err);
<<<<<<< HEAD
    try {
      await message.reply('エラーが発生しました');
    } catch (replyErr) {
      console.error('返信失敗:', replyErr);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
=======
    return message.reply('エラーが発生しました').catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);      {
        user_name: message.author.username,
        repme_code: linkData.repme_code,
        type: 'in',
        source: 'discord'
      }
    ])

  if (error) {
    console.error(error)
    await message.reply('保存失敗')
    return
  }

  await message.reply('保存成功')
  return
}

  if (message.content === '!out') {
  const discordId = message.author.id

  const { data: linkData, error: linkError } = await supabase
    .from('user_links')
    .select('repme_code')
    .eq('discord_user_id', discordId)
    .single()

  if (linkError || !linkData) {
    console.error(linkError)
    await message.reply('まだ連携されていません。')
    return
  }

  const { error } = await supabase
    .from('work_logs')
    .insert([
      {
        user_name: message.author.username,
        repme_code: linkData.repme_code,
        type: 'out',
        source: 'discord'
      }
    ])

  if (error) {
    console.error(error)
    await message.reply('保存失敗')
    return
  }

  await message.reply('作業終了を記録しました。')
  return
}
})

client.login(process.env.DISCORD_TOKEN)
>>>>>>> 299ea1259567dca8a8535829ad3848fb1c61d94f
