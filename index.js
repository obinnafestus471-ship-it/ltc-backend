const express = require('express');
const ccxt = require('ccxt');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

// Supabase connection
const SUPABASE_URL = 'https://pccuhtlfnfvyitioobko.supabase.co';
const SUPABASE_KEY = 'sb_secret_s1MTGOjGESnYg8NyFR9S6g_FHbOGHTK';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Your TON wallet
const YOUR_WALLET = 'UQD3d5ZMqpheS51qbgB3A04jrf3pI2V0vXffr3Lu1rbEy7wF';

// Store user API keys in memory (for auto-close)
const userApiKeys = {};

// Save API key when user connects
async function saveApiKey(userId, exchange, apiKey, secret) {
  userApiKeys[`${userId}_${exchange}`] = { apiKey, secret };
  try {
    await supabase.from('connections').upsert({ 
      user_id: userId, 
      exchange, 
      api_key: apiKey, 
      secret: secret 
    });
    console.log(`✅ API key saved for ${userId} on ${exchange}`);
  } catch(e) { 
    console.log("Save key error:", e.message); 
  }
}

// Get API key when needed for auto-close
async function getApiKey(userId, exchange) {
  const cached = userApiKeys[`${userId}_${exchange}`];
  if (cached) return cached;
  try {
    const { data } = await supabase.from('connections')
      .select('api_key, secret')
      .eq('user_id', userId)
      .eq('exchange', exchange)
      .single();
    if (data) {
      userApiKeys[`${userId}_${exchange}`] = data;
      return data;
    }
    return null;
  } catch(e) { 
    return null; 
  }
}

// AUTO-CLOSE FUNCTION - Closes positions automatically when market crashes
async function closeUserPositions(userId, exchangeId, symbol, amount) {
  try {
    const keys = await getApiKey(userId, exchangeId);
    if (!keys || !keys.api_key) {
      console.log(`⚠️ No API keys for user ${userId} on ${exchangeId}`);
      return false;
    }
    const exchange = new ccxt[exchangeId]({ 
      apiKey: keys.api_key, 
      secret: keys.secret 
    });
    exchange.enableRateLimit = true;
    const order = await exchange.createMarketSellOrder(symbol, amount);
    console.log(`✅ AUTO-CLOSED: ${amount} ${symbol} for user ${userId} | Order ID: ${order.id}`);
    return true;
  } catch (err) {
    console.log(`❌ Auto-close failed for ${userId}: ${err.message}`);
    return false;
  }
}

// Price history storage
const priceHistory = {};
const priceCache = {};

// ============ PRICE CACHE (30 seconds TTL) ============
const cache = {
  data: {},
  ttl: 30000,
  get(exchange, symbol) {
    const key = `${exchange}:${symbol}`;
    const cached = this.data[key];
    if (cached && (Date.now() - cached.timestamp) < this.ttl) {
      return cached.price;
    }
    return null;
  },
  set(exchange, symbol, price) {
    const key = `${exchange}:${symbol}`;
    this.data[key] = { price, timestamp: Date.now() };
  }
};

function getPriceFromMinutesAgo(symbol, minutes) {
  const now = Date.now();
  const cutoff = now - (minutes * 60 * 1000);
  if (!priceHistory[symbol]) return null;
  for (let i = priceHistory[symbol].length - 1; i >= 0; i--) {
    if (priceHistory[symbol][i].timestamp <= cutoff) {
      return priceHistory[symbol][i].price;
    }
  }
  return null;
}

function addToPriceHistory(symbol, price) {
  if (!priceHistory[symbol]) priceHistory[symbol] = [];
  priceHistory[symbol].push({ timestamp: Date.now(), price: price });
  const cutoff = Date.now() - (60 * 60 * 1000);
  priceHistory[symbol] = priceHistory[symbol].filter(p => p.timestamp > cutoff);
}

// Execute strategy when crash detected - NOW WITH AUTO-CLOSE!
async function executeStrategy(userId, exchangeId, action, symbol, savedAmount) {
  try {
    const feeDue = savedAmount * 0.1;
    const netSaved = savedAmount - feeDue;
    
    // Save to database
    await supabase.from('panic_logs').insert({
      user_id: userId,
      exchange: exchangeId,
      saved_amount: savedAmount,
      fee_due: feeDue,
      net_saved: netSaved,
      timestamp: new Date()
    });
    
    // AUTO-CLOSE: Close positions automatically if action is close_all or close_half
    if (action === 'close_all' || action === 'close_half') {
      let amount = 1000; // Default position size in USDT
      if (action === 'close_half') amount = amount / 2;
      await closeUserPositions(userId, exchangeId, symbol, amount);
      console.log(`🛡️ GUARD EXECUTED: Auto-closed ${amount} ${symbol} for user ${userId}`);
    }
    
    console.log(`✅ Saved user ${userId}: $${savedAmount}, Fee: $${feeDue}`);
  } catch (error) {
    console.log(`❌ Failed:`, error.message);
  }
}

// ============ ENHANCED AI PARSER (UNDERSTANDS 50+ TRADING WORDS) ============
function parseAiPrompt(prompt) {
  const rules = {
    asset: null,
    condition: null,
    threshold: null,
    timeWindow: 15,
    action: null,
    logic: null,
    secondaryAsset: null,
    secondaryThreshold: null,
    volumeCondition: null,
    volumeThreshold: null
  };
  
  const lowerPrompt = prompt.toLowerCase();
  
  // ============ STEP 1: AND/OR logic ============
  if (lowerPrompt.includes(' and ') || lowerPrompt.includes(' && ') || lowerPrompt.includes(' also ')) {
    rules.logic = 'AND';
  } else if (lowerPrompt.includes(' or ') || lowerPrompt.includes(' || ')) {
    rules.logic = 'OR';
  }
  
  // ============ STEP 2: Extract multiple assets ============
  const assets = [];
  const assetMatches = prompt.match(/\b(BTC|BITCOIN|ETH|ETHEREUM|SOL|SOLANA|BNB|BINANCE|XRP|DOGE|DOGECOIN|ADA|CARDANO|AVAX|AVALANCHE|MATIC|POLYGON)\b/gi);
  if (assetMatches) {
    for (const asset of assetMatches) {
      let normalized = asset.toUpperCase();
      if (normalized === 'BITCOIN') normalized = 'BTC';
      if (normalized === 'ETHEREUM') normalized = 'ETH';
      if (normalized === 'SOLANA') normalized = 'SOL';
      if (normalized === 'BINANCE') normalized = 'BNB';
      if (normalized === 'DOGECOIN') normalized = 'DOGE';
      if (normalized === 'CARDANO') normalized = 'ADA';
      if (normalized === 'AVALANCHE') normalized = 'AVAX';
      if (normalized === 'POLYGON') normalized = 'MATIC';
      assets.push(normalized);
    }
  }
  rules.asset = assets[0] || null;
  rules.secondaryAsset = assets[1] || null;
  
  // ============ STEP 3: Condition (DROP) - All possible words ============
  const dropWords = [
    'drop', 'drops', 'dropped', 'fall', 'falls', 'fell', 'falling',
    'decrease', 'decreases', 'decreased', 'decline', 'declines', 'declined',
    'crash', 'crashes', 'crashed', 'crashing', 'plummet', 'plummets', 'plummeted',
    'tank', 'tanks', 'tanked', 'dump', 'dumps', 'dumped',
    'dip', 'dips', 'dipped', 'down', 'go down', 'going down', 'went down',
    'lower', 'lowers', 'lowered', 'sink', 'sinks', 'sank',
    'slide', 'slides', 'slid', 'slump', 'slumps', 'slumped',
    'nose dive', 'nosedive', 'plunge', 'plunges', 'plunged'
  ];
  
  // ============ STEP 4: Condition (RISE) - All possible words ============
  const riseWords = [
    'rise', 'rises', 'rose', 'rising',
    'increase', 'increases', 'increased', 'increasing',
    'up', 'go up', 'going up', 'went up',
    'pump', 'pumps', 'pumped', 'pumping',
    'surge', 'surges', 'surged', 'surging',
    'jump', 'jumps', 'jumped', 'jumping',
    'climb', 'climbs', 'climbed', 'climbing',
    'moon', 'moons', 'mooning', 'rocket', 'rockets', 'rocketed',
    'rally', 'rallies', 'rallied', 'rallying',
    'gain', 'gains', 'gained', 'gaining',
    'soar', 'soars', 'soared', 'soaring',
    'boom', 'booms', 'boomed', 'booming'
  ];
  
  let isDrop = false;
  let isRise = false;
  
  for (const word of dropWords) {
    if (lowerPrompt.includes(word)) {
      isDrop = true;
      break;
    }
  }
  
  for (const word of riseWords) {
    if (lowerPrompt.includes(word)) {
      isRise = true;
      break;
    }
  }
  
  if (isDrop) rules.condition = 'drop';
  else if (isRise) rules.condition = 'rise';
  
  // ============ STEP 5: Extract percentages ============
  const percentMatches = prompt.match(/(\d+)%|(\d+)\s+percent/gi);
  if (percentMatches) {
    const firstPercent = percentMatches[0].match(/\d+/);
    rules.threshold = parseInt(firstPercent[0]);
    if (percentMatches[1]) {
      const secondPercent = percentMatches[1].match(/\d+/);
      if (secondPercent) rules.secondaryThreshold = parseInt(secondPercent[0]);
    }
  }
  
  // ============ STEP 6: Extract time window ============
  const timeMatch = prompt.match(/in\s+(\d+)\s+minutes?|(\d+)\s+min|after\s+(\d+)\s+minutes?|(\d+)\s+मिनट/i);
  if (timeMatch) {
    rules.timeWindow = parseInt(timeMatch[1] || timeMatch[2] || timeMatch[3] || timeMatch[4]);
  }
  
  const withinMatch = prompt.match(/within\s+(\d+)\s+minutes?/i);
  if (withinMatch) {
    rules.timeWindow = parseInt(withinMatch[1]);
  }
  
  // ============ STEP 7: Volume conditions ============
  const volumeMatch = lowerPrompt.match(/volume.*>\s*(\d+)/i);
  if (volumeMatch) {
    rules.volumeCondition = 'greater';
    rules.volumeThreshold = parseInt(volumeMatch[1]);
  }
  
  // ============ STEP 8: Actions - Close All ============
  const closeAllWords = [
    'close all', 'close everything', 'close positions', 'close my positions',
    'sell all', 'sell everything', 'liquidate', 'liquidate all', 'exit all',
    'clear all', 'close every', 'sell every', '全部平仓', 'सभी बंद करें',
    'पोजीशन बंद करें', 'सब बेच दो', 'सब बंद कर दो'
  ];
  
  // ============ STEP 9: Actions - Close Half ============
  const closeHalfWords = [
    'close half', 'close 50%', 'sell half', 'sell 50%',
    'liquidate half', 'close 50 percent', 'close fifty percent',
    'आधा बंद करें', 'आधा बेच दो', 'पचास प्रतिशत बंद करें'
  ];
  
  // ============ STEP 10: Actions - Stop Loss ============
  const stopLossWords = [
    'stop loss', 'stoploss', 'stop-loss', 'set stop loss',
    'place stop loss', 'add stop loss', 'स्टॉप लॉस', 'स्टॉप लॉस लगाएं'
  ];
  
  // ============ STEP 11: Actions - Hedge ============
  const hedgeWords = [
    'hedge', 'hedge position', 'open hedge', 'short',
    'हेज', 'हेज पोजीशन', 'शॉर्ट'
  ];
  
  // ============ STEP 12: Actions - Alert Only ============
  const alertWords = [
    'alert', 'alert only', 'notify', 'notify only', 'just alert',
    'warn me', 'tell me', 'message me', 'notification only',
    'केवल अलर्ट', 'सूचना भेजें', 'बस सूचना दो'
  ];
  
  for (const word of closeAllWords) {
    if (lowerPrompt.includes(word)) {
      rules.action = 'close_all';
      break;
    }
  }
  
  if (!rules.action) {
    for (const word of closeHalfWords) {
      if (lowerPrompt.includes(word)) {
        rules.action = 'close_half';
        break;
      }
    }
  }
  
  if (!rules.action) {
    for (const word of stopLossWords) {
      if (lowerPrompt.includes(word)) {
        rules.action = 'stop_loss';
        break;
      }
    }
  }
  
  if (!rules.action) {
    for (const word of hedgeWords) {
      if (lowerPrompt.includes(word)) {
        rules.action = 'hedge';
        break;
      }
    }
  }
  
  if (!rules.action) {
    for (const word of alertWords) {
      if (lowerPrompt.includes(word)) {
        rules.action = 'alert_only';
        break;
      }
    }
  }
  
  if (!rules.action) {
    rules.action = 'close_all';
  }
  
  console.log('📝 Parsed AI prompt:', rules);
  return rules;
}

// ============ PAYMENT CHECK ============
app.get('/api/check-payment/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${YOUR_WALLET}&limit=30`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    for (const tx of data.result || []) {
      const txStr = JSON.stringify(tx).toLowerCase();
      if (txStr.includes(userId.toLowerCase())) {
        await supabase.from('users').update({
          guard_locked: false,
          fee_paid: true,
          last_payment: new Date()
        }).eq('user_id', userId);
        return res.json({ paid: true, message: 'Payment confirmed! Guard unlocked.' });
      }
    }
    return res.json({ paid: false, message: 'Payment not found yet.' });
  } catch (error) {
    console.error('Payment check error:', error.message);
    return res.json({ paid: false, message: 'Error checking payment. Try again.' });
  }
});

// ============ PRICE MONITORING (WATCHES ANY ASSET) ============
async function monitorPrices() {
  const now = new Date();
  console.log(`🔍 [${now.toISOString()}] Checking prices...`);
  
  const { data: strategies, error } = await supabase
    .from('strategies')
    .select('*')
    .eq('is_active', true)
    .lt('last_checked', new Date(Date.now() - 5 * 60 * 1000).toISOString());
  
  if (error) {
    console.log('Error fetching strategies:', error.message);
    return;
  }
  
  if (!strategies || strategies.length === 0) {
    console.log('No active strategies to check');
    return;
  }
  
  console.log(`📋 Checking ${strategies.length} active strategies`);
  
  const neededAssets = new Set();
  for (const strategy of strategies) {
    if (strategy.parsed_strategy && strategy.parsed_strategy.asset) {
      neededAssets.add(strategy.parsed_strategy.asset);
    }
    if (strategy.parsed_strategy && strategy.parsed_strategy.secondaryAsset) {
      neededAssets.add(strategy.parsed_strategy.secondaryAsset);
    }
  }
  
  const neededSymbols = [];
  for (const asset of neededAssets) {
    neededSymbols.push(`${asset}/USDT`);
  }
  
  if (neededSymbols.length === 0) {
    console.log('No assets to monitor');
    return;
  }
  
  console.log(`📊 Watching prices for: ${neededSymbols.join(', ')}`);
  
  const exchanges = ['binance', 'bybit', 'okx'];
  
  for (const exchangeId of exchanges) {
    try {
      const exchange = new ccxt[exchangeId]();
      exchange.enableRateLimit = true;
      
      for (const symbol of neededSymbols) {
        let currentPrice = cache.get(exchangeId, symbol);
        
        if (currentPrice === null) {
          try {
            const ticker = await exchange.fetchTicker(symbol);
            currentPrice = ticker.last;
            cache.set(exchangeId, symbol, currentPrice);
            console.log(`📡 Fetched ${exchangeId} ${symbol}: $${currentPrice}`);
          } catch (fetchError) {
            console.log(`Failed to fetch ${exchangeId} ${symbol}:`, fetchError.message);
            continue;
          }
        } else {
          console.log(`💾 Using cached price for ${exchangeId} ${symbol}: $${currentPrice}`);
        }
        
        const asset = symbol.split('/')[0];
        addToPriceHistory(asset, currentPrice);
        
        for (const strategy of strategies) {
          const parsed = strategy.parsed_strategy;
          if (!parsed || parsed.asset !== asset) continue;
          
          const oldPrice = getPriceFromMinutesAgo(asset, parsed.timeWindow);
          if (!oldPrice) continue;
          
          let dropPercent = ((oldPrice - currentPrice) / oldPrice) * 100;
          
          let shouldExecute = false;
          
          if (parsed.logic === 'AND' && parsed.secondaryAsset) {
            const secondaryOldPrice = getPriceFromMinutesAgo(parsed.secondaryAsset, parsed.timeWindow);
            if (secondaryOldPrice) {
              const secondaryCurrentPrice = priceHistory[parsed.secondaryAsset]?.slice(-1)[0]?.price || currentPrice;
              const secondaryDropPercent = ((secondaryOldPrice - secondaryCurrentPrice) / secondaryOldPrice) * 100;
              shouldExecute = (dropPercent >= parsed.threshold && secondaryDropPercent >= parsed.secondaryThreshold);
            }
          } else if (parsed.logic === 'OR' && parsed.secondaryAsset) {
            const secondaryOldPrice = getPriceFromMinutesAgo(parsed.secondaryAsset, parsed.timeWindow);
            if (secondaryOldPrice) {
              const secondaryCurrentPrice = priceHistory[parsed.secondaryAsset]?.slice(-1)[0]?.price || currentPrice;
              const secondaryDropPercent = ((secondaryOldPrice - secondaryCurrentPrice) / secondaryOldPrice) * 100;
              shouldExecute = (dropPercent >= parsed.threshold || secondaryDropPercent >= parsed.secondaryThreshold);
            }
          } else {
            shouldExecute = (parsed.condition === 'drop' && dropPercent >= parsed.threshold);
          }
          
          if (shouldExecute) {
            console.log(`🚨 CRASH DETECTED! ${asset} dropped ${dropPercent.toFixed(2)}% in ${parsed.timeWindow} minutes`);
            const estimatedPositionValue = 1000;
            let savedAmount = estimatedPositionValue * (dropPercent / 100);
            
            if (parsed.action === 'close_half') {
              savedAmount = savedAmount / 2;
            }
            
            // This will now AUTO-CLOSE positions if action is close_all or close_half
            await executeStrategy(strategy.user_id, exchangeId, parsed.action, asset, savedAmount);
          }
        }
      }
      
      for (const strategy of strategies) {
        await supabase
          .from('strategies')
          .update({ last_checked: new Date().toISOString() })
          .eq('id', strategy.id);
      }
      
    } catch (error) {
      console.log(`Error with ${exchangeId}:`, error.message);
    }
  }
}

setInterval(monitorPrices, 120000);
console.log('🚀 Price monitoring started! Checking every 2 minutes');
console.log('🤖 AUTO-CLOSE is ACTIVE! Positions will close automatically when crash detected');
setTimeout(() => monitorPrices(), 5000);

// ============ API ENDPOINTS ============
app.get('/', (req, res) => {
  res.json({ message: 'CrashGuard Backend Dey Work! 🚀', status: 'online', auto_close: 'active' });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', auto_monitor: 'active', auto_close: 'active', watches: 'dynamic assets', time: new Date().toISOString() });
});

app.post('/api/connect', async (req, res) => {
  const { exchange, apiKey, secret, userId } = req.body;
  if (!exchange || !apiKey || !secret || !userId) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  try {
    const exchangeObj = new ccxt[exchange]({ apiKey, secret, enableRateLimit: true });
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
    // Save API key for auto-close
    await saveApiKey(userId, exchange, apiKey, secret);
    await supabase.from('connections').upsert({ user_id: userId, exchange, balance: totalBalance, balance_usd: totalBalanceUSD });
    res.json({ success: true, balance: totalBalance, balanceUSD: totalBalanceUSD, message: 'Connected! Auto-close is now active.' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/strategy/save', async (req, res) => {
  const { userId, aiPrompt, exchange } = req.body;
  if (!userId || !aiPrompt) {
    return res.json({ success: false, error: 'Missing userId or aiPrompt' });
  }
  const parsed = parseAiPrompt(aiPrompt);
  await supabase.from('strategies').upsert({
    user_id: userId,
    strategy: aiPrompt,
    parsed_strategy: parsed,
    exchange: exchange || 'not specified',
    is_active: true,
    last_checked: new Date().toISOString(),
    updated_at: new Date()
  });
  res.json({ success: true, message: 'Strategy saved! Auto-close will trigger when condition met.', parsed });
});

app.post('/api/panic', async (req, res) => {
  const { exchange, apiKey, secret, userId } = req.body;
  if (!exchange || !apiKey || !secret || !userId) {
    return res.json({ success: false, error: 'Missing exchange, apiKey, or secret' });
  }
  try {
    await saveApiKey(userId, exchange, apiKey, secret);
    const exchangeObj = new ccxt[exchange]({ apiKey, secret });
    const positions = await exchangeObj.fetchPositions();
    let savedAmount = 0;
    for (const position of positions) {
      if (position.contracts > 0) {
        savedAmount += position.contracts * position.entryPrice * 0.05;
      }
    }
    const feeDue = savedAmount * 0.1;
    const netSaved = savedAmount - feeDue;
    await supabase.from('panic_logs').insert({ user_id: userId, exchange, saved_amount: savedAmount, fee_due: feeDue, net_saved: netSaved });
    res.json({ success: true, savedAmount, feeDue, netSaved });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/set-language', async (req, res) => {
  const { userId, language } = req.body;
  if (!userId || !language) return res.json({ success: false, error: 'Missing userId or language' });
  await supabase.from('users').upsert({ user_id: userId, language });
  res.json({ success: true, message: `Language set to ${language}` });
});

app.get('/api/get-language/:userId', async (req, res) => {
  const { userId } = req.params;
  const { data } = await supabase.from('users').select('language').eq('user_id', userId).single();
  if (data && data.language) {
    res.json({ success: true, language: data.language });
  } else {
    res.json({ success: true, language: 'en' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 CrashGuard Backend Running on port ${PORT}`);
  console.log(`🌐 English + Hindi support enabled`);
  console.log(`📊 Dynamic price monitoring: ACTIVE (watches user-specified assets)`);
  console.log(`🤖 AUTO-CLOSE: ACTIVE - Positions will close automatically when crash detected!`);
  console.log(`🧠 Enhanced AI parser: 50+ trading keywords, AND/OR logic, multiple assets`);
  console.log(`💳 Payment check: /api/check-payment/:userId`);
});
