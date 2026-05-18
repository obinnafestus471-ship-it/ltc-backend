
const express = require('express');
const ccxt = require('ccxt');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const app = express();

app.use(cors());
app.use(express.json());

// Hardcoded MongoDB connection string
const MONGODB_URI = 'mongodb+srv://obinnafestus471_db_user:Sk8KN8csJZtQumy1@cluster0.3pn4onc.mongodb.net/';
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('crashguard');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.log('❌ MongoDB connection failed:', error.message);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'CrashGuard Backend Dey Work! 🚀', status: 'online', database: db ? 'connected' : 'disconnected' });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', database: db ? 'connected' : 'disconnected', time: new Date().toISOString() });
});

// Connect exchange endpoint
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
    
    if (db && userId) {
      await db.collection('connections').updateOne(
        { userId: userId },
        { $set: { exchange: exchange, connectedAt: new Date(), balance: totalBalance, balanceUSD: totalBalanceUSD } },
        { upsert: true }
      );
    }
    
    res.json({ success: true, balance: totalBalance, balanceUSD: totalBalanceUSD });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Save strategy endpoint (with AI parser)
app.post('/api/strategy/save', async (req, res) => {
  const { userId, aiPrompt, exchange } = req.body;
  
  if (!userId || !aiPrompt) {
    return res.json({ success: false, error: 'Missing userId or aiPrompt' });
  }
  
  // Parse AI prompt (English + Hindi)
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
    return rules;
  }
  
  const parsed = parseAiPrompt(aiPrompt);
  
  try {
    if (db && userId) {
      await db.collection('strategies').updateOne(
        { userId: userId },
        { $set: { strategy: aiPrompt, parsedStrategy: parsed, exchange: exchange || 'not specified', updatedAt: new Date() } },
        { upsert: true }
      );
    }
    res.json({ success: true, message: 'Strategy saved successfully', parsed: parsed });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Panic / Kill Switch endpoint
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
        closedPositions.push({ symbol: position.symbol, contracts: position.contracts, entryPrice: position.entryPrice });
      }
    }
    
    const feeDue = savedAmount * 0.1;
    const netSaved = savedAmount - feeDue;
    
    if (db && userId) {
      await db.collection('panic_logs').insertOne({
        userId: userId, exchange: exchange, savedAmount: savedAmount, feeDue: feeDue,
        netSaved: netSaved, positionsClosed: closedPositions, timestamp: new Date()
      });
      await db.collection('users').updateOne(
        { userId: userId },
        { $inc: { totalSaved: savedAmount, totalFees: feeDue }, $set: { lastPanic: new Date() } },
        { upsert: true }
      );
    }
    
    res.json({ success: true, message: 'Panic triggered!', savedAmount: savedAmount, feeDue: feeDue, netSaved: netSaved, positionsClosed: closedPositions.length });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Save language preference
app.post('/api/set-language', async (req, res) => {
  const { userId, language } = req.body;
  if (!userId || !language) return res.json({ success: false, error: 'Missing userId or language' });
  try {
    if (db) await db.collection('users').updateOne({ userId: userId }, { $set: { language: language, updatedAt: new Date() } }, { upsert: true });
    res.json({ success: true, message: `Language set to ${language}` });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get language preference
app.get('/api/get-language/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    if (db) {
      const user = await db.collection('users').findOne({ userId: userId });
      if (user && user.language) return res.json({ success: true, language: user.language });
    }
    res.json({ success: true, language: 'en' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

// Start server immediately, connect DB in background
app.listen(PORT, () => {
  console.log(`🚀 CrashGuard Backend Running!`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🌐 English + Hindi support enabled`);
});

connectDB();
