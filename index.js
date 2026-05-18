const express = require('express');
const ccxt = require('ccxt');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(cors());
app.use(express.json());

// Supabase connection - YOUR KEYS ARE ALREADY IN HERE
const SUPABASE_URL = 'https://pccuhtlfnfvyitioobko.supabase.co';
const SUPABASE_KEY = 'sb_secret_s1MTGOjGESnYg8NyFR9S6g_FHbOGHTK';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============ HEALTH CHECK ENDPOINTS ============
app.get('/', (req, res) => {
  res.json({ message: 'CrashGuard Backend Dey Work! 🚀', status: 'online' });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', time: new Date().toISOString() });
});

// ============ CONNECT EXCHANGE ENDPOINT ============
app.post('/api/connect', async (req, res) => {
  const { exchange, apiKey, secret, userId } = req.body;
  
  if (!exchange || !apiKey || !secret) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  try {
    const exchangeObj = new ccxt[exchange]({
      apiKey: apiKey,
      secret: secret,
      enableRateLimit: true,
    });
    
    const balance = await exchangeObj.fetchBalance();
    const totalBalance = balance.total;
    
    let totalBalanceUSD = 0;
    for (const [currency, amount] of Object.entries(totalBalance)) {
      if (amount > 0) {
        try {
          const ticker = await exchangeObj.fetchTicker(`${currency}/USDT`);
          totalBalanceUSD += amount * ticker.last;
        } catch (e) {}
      }
    }
    
    // Save to Supabase
    await supabase
      .from('connections')
      .upsert({ 
        user_id: userId, 
        exchange: exchange, 
        balance: totalBalance,
        balance_usd: totalBalanceUSD
      });
    
    res.json({ success: true, balance: totalBalance, balanceUSD: totalBalanceUSD });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ AI PARSER (English + Hindi) ============
function parseAiPrompt(prompt) {
  const rules = { asset: null, condition: null, threshold: null, timeWindow: 15, action: null };
  const assetMatch = prompt.match(/\b(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|MATIC)\b/i);
  if (assetMatch) rules.asset = assetMatch[1].toUpperCase();
  if (prompt.match(/drop|falls|decrease|गिरावट|गिरता|नीचे/i)) rules.condition = 'drop';
  else if (prompt.match(/rise|up|increase|बढ़त|उपर|बढ़ता/i)) rules.condition = 'rise';
  const percentMatch = prompt.match(/(\d+)%/i);
  if (percentMatch) rules.threshold = parseInt(percentMatch[1]);
  const timeMatch = prompt.match(/in\s+(\d+)\s+minutes?|(\d+)\s+मिनट/i);
  if (timeMatch) rules.timeWindow = parseInt(timeMatch[1] || timeMatch[2]);
  if (prompt.match(/close all|close everything|close positions|सभी बंद करें|पोजीशन बंद करें/i)) rules.action = 'close_all';
  else if (prompt.match(/stop loss|stoploss|स्टॉप लॉस/i)) rules.action = 'stop_loss';
  else if (prompt.match(/hedge|हेज/i)) rules.action = 'hedge';
  else if (prompt.match(/reduce size|reduce 50|take profit|साइज घटाएं|लाभ लें/i)) rules.action = 'reduce_size';
  else if (prompt.match(/alert only|notify only|just alert|केवल अलर्ट|सूचना भेजें/i)) rules.action = 'alert_only';
  return rules;
}

// ============ SAVE STRATEGY ENDPOINT ============
app.post('/api/strategy/save', async (req, res) => {
  const { userId, aiPrompt, exchange } = req.body;
  
  if (!userId || !aiPrompt) {
    return res.json({ success: false, error: 'Missing userId or aiPrompt' });
  }
  
  const parsed = parseAiPrompt(aiPrompt);
  
  await supabase
    .from('strategies')
    .upsert({ 
      user_id: userId, 
      strategy: aiPrompt, 
      parsed_strategy: parsed,
      exchange: exchange || 'not specified',
      updated_at: new Date()
    });
  
  res.json({ success: true, message: 'Strategy saved successfully', parsed: parsed });
});

// ============ PANIC / KILL SWITCH ENDPOINT ============
app.post('/api/panic', async (req, res) => {
  const { exchange, apiKey, secret, userId } = req.body;
  
  if (!exchange || !apiKey || !secret) {
    return res.json({ success: false, error: 'Missing exchange, apiKey, or secret' });
  }
  
  try {
    const exchangeObj = new ccxt[exchange]({ apiKey: apiKey, secret: secret });
    const positions = await exchangeObj.fetchPositions();
    let savedAmount = 0;
    let closedPositions = [];
    
    for (const position of positions) {
      if (position.contracts > 0) {
        const positionValue = position.contracts * position.entryPrice;
        savedAmount += positionValue * 0.05;
        closedPositions.push({ 
          symbol: position.symbol, 
          contracts: position.contracts, 
          entryPrice: position.entryPrice 
        });
      }
    }
    
    const feeDue = savedAmount * 0.1;
    const netSaved = savedAmount - feeDue;
    
    // Save panic log to Supabase
    await supabase
      .from('panic_logs')
      .insert({ 
        user_id: userId, 
        exchange: exchange, 
        saved_amount: savedAmount, 
        fee_due: feeDue,
        net_saved: netSaved,
        positions_closed: closedPositions
      });
    
    res.json({ 
      success: true, 
      message: 'Panic triggered!', 
      savedAmount: savedAmount, 
      feeDue: feeDue, 
      netSaved: netSaved 
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ LANGUAGE PREFERENCE ENDPOINTS ============
app.post('/api/set-language', async (req, res) => {
  const { userId, language } = req.body;
  if (!userId || !language) return res.json({ success: false, error: 'Missing userId or language' });
  
  await supabase
    .from('users')
    .upsert({ user_id: userId, language: language });
  
  res.json({ success: true, message: `Language set to ${language}` });
});

app.get('/api/get-language/:userId', async (req, res) => {
  const { userId } = req.params;
  
  const { data } = await supabase
    .from('users')
    .select('language')
    .eq('user_id', userId)
    .single();
  
  if (data && data.language) {
    res.json({ success: true, language: data.language });
  } else {
    res.json({ success: true, language: 'en' });
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 CrashGuard Backend Running!`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🌐 English + Hindi support enabled`);
  console.log(`🗄️  Using Supabase database`);
});
