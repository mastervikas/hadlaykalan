const express = require('express');
const router = express.Router();
const CricketMatch = require('../models/CricketMatch');
const CricketPlayer = require('../models/CricketPlayer');
const Visitor = require('../models/Visitor');
const { notifyCricket } = require('../services/cricketNotify');

// Verify visitor has a registered profile (name + phone)
async function requireRegisteredVisitor(token) {
  if (!token) return null;
  const v = await Visitor.findOne({ visitorToken: token });
  if (!v || !(v.registeredName || v.visitorName) || !v.registeredPhone) return null;
  return v;
}

// Scorer/creator tokens are visitor tokens (login keys), so they never leave the
// server. Each viewer gets isScorer/isCreator for their own token instead.
function publicMatch(match, viewerToken) {
  const m = typeof match.toObject === 'function' ? match.toObject() : { ...match };
  m.isScorer = !!viewerToken && m.scorerToken === viewerToken;
  m.isCreator = !!viewerToken && m.creatorToken === viewerToken;
  m.scorerName = m.scorerName || (m.scorerToken === m.creatorToken ? m.creatorName : '');
  delete m.scorerToken;
  delete m.creatorToken;
  return m;
}
const viewer = req => req.headers['x-visitor-token'] || req.query.visitorToken || (req.body && req.body.visitorToken) || '';

// GET /api/cricket/matches — list active & recent matches
router.get('/matches', async (req, res) => {
  try {
    const matches = await CricketMatch.find(
      { status: { $ne: 'abandoned' } },
      { 'innings.ballByBall': 0 }
    ).sort({ updatedAt: -1 }).limit(20);
    res.json(matches.map(m => publicMatch(m, viewer(req))));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/cricket/matches/:id — full match detail
router.get('/matches/:id', async (req, res) => {
  try {
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    res.json(publicMatch(match, viewer(req)));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /api/cricket/matches — create match
router.post('/matches', async (req, res) => {
  try {
    const { visitorToken, title, teamA, teamB, totalOvers, playersPerSide, venue, teamAPlayers, teamBPlayers } = req.body;
    const visitor = await requireRegisteredVisitor(visitorToken);
    if (!visitor) return res.status(403).json({ message: 'Match बनाने के लिए प्रोफ़ाइल में नाम और मोबाइल नंबर जरूरी है।' });

    const match = new CricketMatch({
      title, teamA, teamB,
      totalOvers: Math.max(1, parseInt(totalOvers) || 20),
      playersPerSide: Math.max(2, parseInt(playersPerSide) || 11),
      teamAPlayers: Array.isArray(teamAPlayers) ? teamAPlayers.map(p => String(p).trim()).filter(Boolean) : [],
      teamBPlayers: Array.isArray(teamBPlayers) ? teamBPlayers.map(p => String(p).trim()).filter(Boolean) : [],
      venue: venue || '',
      creatorToken: visitorToken,
      creatorName: visitor.registeredName || visitor.visitorName,
      scorerName: visitor.registeredName || visitor.visitorName,
      scorerToken: visitorToken,
      innings: []
    });
    await match.save();

    // Upsert players into the global registry (fire-and-forget)
    const allNames = [...match.teamAPlayers, ...match.teamBPlayers];
    if (allNames.length) {
      Promise.all(allNames.map(name =>
        CricketPlayer.findOneAndUpdate(
          { name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
          { $setOnInsert: { name } },
          { upsert: true, new: true }
        )
      )).catch(() => {});
    }

    res.status(201).json(publicMatch(match, visitorToken));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/cricket/matches/:id/toss — set toss & start innings
router.patch('/matches/:id/toss', async (req, res) => {
  try {
    const { visitorToken, tossWinner, tossElected } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.scorerToken !== visitorToken) return res.status(403).json({ message: 'Scorer only' });

    const battingTeam = tossElected === 'bat' ? tossWinner : (tossWinner === match.teamA ? match.teamB : match.teamA);
    const bowlingTeam = battingTeam === match.teamA ? match.teamB : match.teamA;

    match.tossWinner = tossWinner;
    match.tossElected = tossElected;
    match.status = 'live';
    match.innings = [{ battingTeam, bowlingTeam, batsmen: [], bowlers: [], ballByBall: [], fallOfWickets: [] }];
    match.currentInnings = 1;
    match.updatedAt = new Date();
    await match.save();
    res.json(publicMatch(match, viewer(req)));
    notifyCricket(match, 'start');
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/cricket/matches/:id/players — set players for current innings
router.patch('/matches/:id/players', async (req, res) => {
  try {
    const { visitorToken, batsmen, bowlers, striker, nonStriker, currentBowler } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.scorerToken !== visitorToken) return res.status(403).json({ message: 'Scorer only' });

    const idx = match.currentInnings - 1;
    const inn = match.innings[idx];
    if (batsmen) inn.batsmen = batsmen.map(n => ({ name: n, runs: 0, balls: 0, fours: 0, sixes: 0, status: 'yet to bat', outDesc: '' }));
    if (bowlers) inn.bowlers = bowlers.map(n => ({ name: n, overs: 0, balls: 0, maidens: 0, runs: 0, wickets: 0 }));
    if (striker) { inn.striker = striker; const b = inn.batsmen.find(x => x.name === striker); if (b) b.status = 'batting'; }
    if (nonStriker) { inn.nonStriker = nonStriker; const b = inn.batsmen.find(x => x.name === nonStriker); if (b) b.status = 'batting'; }
    if (currentBowler) {
      inn.currentBowler = currentBowler;
      // A new bowler coming on mid-innings gets a fresh line on the card.
      if (!inn.bowlers.some(b => b.name === currentBowler)) inn.bowlers.push({ name: currentBowler, overs: 0, balls: 0, maidens: 0, runs: 0, wickets: 0 });
    }
    // New batsmen (e.g. after a wicket) join the card too.
    for (const name of [striker, nonStriker].filter(Boolean)) {
      if (!inn.batsmen.some(b => b.name === name)) inn.batsmen.push({ name, runs: 0, balls: 0, fours: 0, sixes: 0, status: 'batting', outDesc: '' });
    }

    match.updatedAt = new Date();
    match.markModified('innings');
    await match.save();
    res.json(publicMatch(match, viewer(req)));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /api/cricket/matches/:id/ball — record a ball
router.post('/matches/:id/ball', async (req, res) => {
  try {
    const { visitorToken, runs, isWicket, isWide, isNoBall, isBye, isLegBye, outDesc, newBatsman, desc } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.scorerToken !== visitorToken) return res.status(403).json({ message: 'Scorer only' });
    if (match.status !== 'live') return res.status(400).json({ message: 'Match live नहीं है' });

    const idx = match.currentInnings - 1;
    const inn = match.innings[idx];
    const r = parseInt(runs) || 0;
    const isLegal = !isWide && !isNoBall;

    // Build ball record
    const ballRecord = {
      over: inn.overs,
      ball: inn.balls + (isLegal ? 1 : 0),
      runs: r,
      extras: (isWide || isNoBall) ? 1 : 0,
      isWicket: !!isWicket,
      isWide: !!isWide,
      isNoBall: !!isNoBall,
      isBye: !!isBye,
      isLegBye: !!isLegBye,
      batsmanName: inn.striker,
      bowlerName: inn.currentBowler,
      desc: desc || _buildDesc(r, isWicket, isWide, isNoBall, isBye, isLegBye, inn.striker, outDesc)
    };
    inn.ballByBall.push(ballRecord);

    // Update innings totals
    inn.runs += (isWide || isNoBall ? 1 : 0) + r;

    // Extras
    if (isWide) inn.extras.wides += 1 + r;
    if (isNoBall) inn.extras.noBalls += 1;
    if (isBye) inn.extras.byes += r;
    if (isLegBye) inn.extras.legByes += r;

    // Update batsman (only on legal balls or no-ball)
    const striker = inn.batsmen.find(b => b.name === inn.striker);
    if (striker && !isWide) {
      if (!isBye && !isLegBye) striker.runs += r;
      striker.balls += isLegal || isNoBall ? 1 : 0;
      if (r === 4 && !isBye && !isLegBye) striker.fours++;
      if (r === 6 && !isBye && !isLegBye) striker.sixes++;
    }

    // Update bowler
    const bowler = inn.bowlers.find(b => b.name === inn.currentBowler);
    if (bowler) {
      if (!isBye && !isLegBye) bowler.runs += r + (isWide || isNoBall ? 1 : 0);
      if (isLegal) {
        bowler.balls++;
        if (bowler.balls === 6) { bowler.overs++; bowler.balls = 0; }
      }
      if (isWicket && !['run out'].includes(outDesc)) bowler.wickets++;
    }

    // Advance legal balls / overs
    if (isLegal) {
      inn.balls++;
      if (inn.balls === 6) {
        // Check maiden
        const overBalls = inn.ballByBall.filter(b => b.over === inn.overs && !b.isWide && !b.isNoBall);
        const overRuns = overBalls.reduce((s, b) => s + b.runs, 0);
        if (overRuns === 0 && !isWicket && bowler) bowler.maidens++;
        inn.overs++;
        inn.balls = 0;
        // Rotate strike at end of over
        [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
      }
    }

    // Wicket handling
    if (isWicket) {
      if (newBatsman) {
        const alreadyBatting = (inn.batsmen || []).some(b => b.name === newBatsman && b.status === 'batting');
        const alreadyOut = (inn.batsmen || []).some(b => b.name === newBatsman && (b.status === 'out' || b.status === 'retired hurt'));
        if (newBatsman === inn.striker || newBatsman === inn.nonStriker) return res.status(400).json({ message: 'नया बल्लेबाज पहले से क्रीज पर है।' });
        if (alreadyBatting) return res.status(400).json({ message: 'यह खिलाड़ी पहले से बल्लेबाजी कर रहा है।' });
        if (alreadyOut) return res.status(400).json({ message: 'यह खिलाड़ी पहले ही आउट हो चुका है।' });
      }
      inn.wickets++;
      if (striker) { striker.status = 'out'; striker.outDesc = outDesc || 'out'; }
      inn.fallOfWickets.push({ score: inn.runs, over: `${inn.overs}.${inn.balls}`, batsman: inn.striker });
      inn.striker = newBatsman || '';
      if (newBatsman) {
        const nb = inn.batsmen.find(b => b.name === newBatsman);
        if (nb) nb.status = 'batting'; else inn.batsmen.push({ name: newBatsman, runs: 0, balls: 0, fours: 0, sixes: 0, status: 'batting', outDesc: '' });
      }
    }

    // Rotate strike on odd runs (legal ball)
    if (isLegal && !isWicket && r % 2 === 1 && inn.balls !== 0) {
      [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
    }

    // Check innings end
    const maxWickets = match.playersPerSide - 1;
    const oversUp = inn.overs >= match.totalOvers && inn.balls === 0;
    const allOut = inn.wickets >= maxWickets;
    const chased = match.currentInnings === 2 && inn.target > 0 && inn.runs >= inn.target;

    if (oversUp || allOut || chased) {
      inn.isCompleted = true;
      if (match.currentInnings === 1) {
        const target = inn.runs + 1;
        const battingTeam2 = inn.bowlingTeam;
        const bowlingTeam2 = inn.battingTeam;
        match.status = 'innings_break';
        match.innings.push({ battingTeam: battingTeam2, bowlingTeam: bowlingTeam2, target, batsmen: [], bowlers: [], ballByBall: [], fallOfWickets: [] });
      } else {
        match.status = 'completed';
        match.result = _calcResult(match);
      }
      // Update player career records for this innings (fire-and-forget)
      _updatePlayersFromInnings(inn, match._id, match.currentInnings - 1).catch(() => {});
    }

    match.updatedAt = new Date();
    match.markModified('innings');
    await match.save();
    res.json(publicMatch(match, viewer(req)));
    notifyCricket(match, match.status === 'completed' ? 'completed' : match.status === 'innings_break' ? 'innings_break' : 'ball');
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/cricket/matches/:id/start-innings2 — scorer starts 2nd innings
router.patch('/matches/:id/start-innings2', async (req, res) => {
  try {
    const { visitorToken, striker, nonStriker, currentBowler } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.scorerToken !== visitorToken) return res.status(403).json({ message: 'Scorer only' });

    match.currentInnings = 2;
    match.status = 'live';
    const inn = match.innings[1];
    if (striker) { inn.striker = striker; const b = inn.batsmen.find(x => x.name === striker); if (b) b.status = 'batting'; else inn.batsmen.push({ name: striker, runs: 0, balls: 0, fours: 0, sixes: 0, status: 'batting', outDesc: '' }); }
    if (nonStriker) { inn.nonStriker = nonStriker; const b = inn.batsmen.find(x => x.name === nonStriker); if (b) b.status = 'batting'; else inn.batsmen.push({ name: nonStriker, runs: 0, balls: 0, fours: 0, sixes: 0, status: 'batting', outDesc: '' }); }
    if (currentBowler) { inn.currentBowler = currentBowler; inn.bowlers.push({ name: currentBowler, overs: 0, balls: 0, maidens: 0, runs: 0, wickets: 0 }); }

    match.updatedAt = new Date();
    match.markModified('innings');
    await match.save();
    res.json(publicMatch(match, viewer(req)));
    notifyCricket(match, 'ball');
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /api/cricket/matches/:id/ball — undo last ball
router.delete('/matches/:id/ball', async (req, res) => {
  try {
    const { visitorToken } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.scorerToken !== visitorToken) return res.status(403).json({ message: 'Scorer only' });

    const inn = match.innings[match.currentInnings - 1];
    if (!inn || !inn.ballByBall.length) return res.status(400).json({ message: 'No ball to undo' });
    // Reverse everything the last ball changed: totals, extras, the batsman's and
    // bowler's figures, a wicket (bringing the batsman back) and who is on strike.
    const last = inn.ballByBall.pop();
    const r = last.runs || 0;
    const isLegal = !last.isWide && !last.isNoBall;
    const offBat = !last.isBye && !last.isLegBye;
    inn.runs -= r + (last.isWide || last.isNoBall ? 1 : 0);
    if (last.isWide) inn.extras.wides -= 1 + r;
    if (last.isNoBall) inn.extras.noBalls -= 1;
    if (last.isBye) inn.extras.byes -= r;
    if (last.isLegBye) inn.extras.legByes -= r;
    if (isLegal) {
      if (inn.balls === 0) { inn.overs = Math.max(0, inn.overs - 1); inn.balls = 5; } else inn.balls--;
    }

    const bat = inn.batsmen.find(b => b.name === last.batsmanName);
    if (bat && !last.isWide) {
      if (offBat) bat.runs = Math.max(0, bat.runs - r);
      bat.balls = Math.max(0, bat.balls - (isLegal || last.isNoBall ? 1 : 0));
      if (offBat && r === 4) bat.fours = Math.max(0, bat.fours - 1);
      if (offBat && r === 6) bat.sixes = Math.max(0, bat.sixes - 1);
    }
    const bowl = inn.bowlers.find(b => b.name === last.bowlerName);
    if (bowl) {
      if (offBat) bowl.runs = Math.max(0, bowl.runs - r - (last.isWide || last.isNoBall ? 1 : 0));
      if (isLegal) { if (bowl.balls === 0) { bowl.overs = Math.max(0, bowl.overs - 1); bowl.balls = 5; } else bowl.balls--; }
      if (last.isWicket && bat && bat.outDesc !== 'run out') bowl.wickets = Math.max(0, bowl.wickets - 1);
    }

    // Who was at the crease before this ball: the batsman who faced it plus the
    // partner who is still in (not the newcomer after a wicket).
    let crease = inn.batsmen.filter(b => b.status === 'batting' && b.name !== last.batsmanName).map(b => b.name);
    if (last.isWicket) {
      inn.wickets = Math.max(0, inn.wickets - 1);
      inn.fallOfWickets.pop();
      if (bat) { bat.status = 'batting'; bat.outDesc = ''; }
      const newcomer = [inn.striker, inn.nonStriker].find(n => n && n !== last.batsmanName && crease.includes(n) &&
        (inn.batsmen.find(b => b.name === n) || {}).balls === 0 && crease.length > 1) || (crease.length > 1 ? inn.striker : '');
      const nb = inn.batsmen.find(b => b.name === newcomer);
      if (nb && nb.balls === 0 && nb.runs === 0) nb.status = 'yet to bat';
      crease = crease.filter(n => n !== newcomer);
    }
    inn.striker = last.batsmanName || inn.striker;
    inn.nonStriker = crease[0] || inn.nonStriker;
    if (last.bowlerName) inn.currentBowler = last.bowlerName;

    match.updatedAt = new Date();
    match.markModified('innings');
    await match.save();
    res.json(publicMatch(match, viewer(req)));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Scorer handover ──────────────────────────────────────────
// A match has exactly one scorer at a time (scorerToken). The creator can hand
// scoring to another registered user, found by their exact mobile number, or take
// it back; the current scorer can hand it back to the creator.
const digitsOf = p => String(p || '').replace(/\D/g, '').slice(-10);

// GET /api/cricket/find-user?phone=… — exact number only, returns just the name.
router.get('/find-user', async (req, res) => {
  try {
    const phone = digitsOf(req.query.phone);
    if (phone.length !== 10) return res.status(400).json({ message: '10 अंकों का मोबाइल नंबर डालें' });
    const v = await Visitor.findOne({ isRegistered: true, registeredPhone: { $regex: `${phone}$` } }).select('registeredName visitorName').lean();
    if (!v) return res.status(404).json({ message: 'इस नंबर से कोई प्रोफ़ाइल नहीं मिली। उन्हें पहले ऐप में प्रोफ़ाइल बनानी होगी।' });
    res.json({ name: v.registeredName || v.visitorName });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/cricket/matches/:id/scorer { visitorToken, phone }  (phone empty = back to the creator)
router.patch('/matches/:id/scorer', async (req, res) => {
  try {
    const { visitorToken } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    const isCreator = !!visitorToken && match.creatorToken === visitorToken;
    const isScorer = !!visitorToken && match.scorerToken === visitorToken;
    if (!isCreator && !isScorer) return res.status(403).json({ message: 'सिर्फ़ मैच बनाने वाला स्कोरर बदल सकता है' });
    if (['completed', 'abandoned'].includes(match.status)) return res.status(400).json({ message: 'मैच खत्म हो चुका है' });

    const phone = digitsOf(req.body.phone);
    let next;
    if (!phone) {
      next = { token: match.creatorToken, name: match.creatorName };
    } else {
      if (!isCreator) return res.status(403).json({ message: 'सिर्फ़ मैच बनाने वाला नया स्कोरर चुन सकता है' });
      const v = await Visitor.findOne({ isRegistered: true, registeredPhone: { $regex: `${phone}$` } }).select('visitorToken registeredName visitorName');
      if (!v) return res.status(404).json({ message: 'इस नंबर से कोई प्रोफ़ाइल नहीं मिली' });
      next = { token: v.visitorToken, name: v.registeredName || v.visitorName, visitorId: v._id };
    }
    match.scorerToken = next.token;
    match.scorerName = next.name;
    match.updatedAt = new Date();
    await match.save();
    res.json(publicMatch(match, visitorToken));

    // Tell the new scorer on their phone (best effort).
    if (next.visitorId) {
      const AndroidDevice = require('../models/AndroidDevice');
      const device = await AndroidDevice.findOne({ linkedVisitorId: next.visitorId, fcmToken: { $ne: null } }).sort({ lastSeen: -1 }).catch(() => null);
      if (device) {
        require('../services/notificationService').sendToDevice(device, {
          title: `✍️ आप अब स्कोरर हैं: ${match.teamA} बनाम ${match.teamB}`,
          body: `${match.creatorName || 'मैच बनाने वाले'} ने आपको इस मैच का स्कोर डालने की ज़िम्मेदारी दी है। खोलकर स्कोर डालें।`,
          type: 'cricket', targetPage: 'cricket', targetId: String(match._id),
        }).catch(() => {});
      }
    }
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/cricket/matches/:id/abandon
router.patch('/matches/:id/abandon', async (req, res) => {
  try {
    const { visitorToken } = req.body;
    const match = await CricketMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Not found' });
    if (match.scorerToken !== visitorToken && match.creatorToken !== visitorToken) return res.status(403).json({ message: 'Scorer only' });
    match.status = 'abandoned';
    match.updatedAt = new Date();
    await match.save();
    res.json({ message: 'Match abandoned' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Player Registry ───────────────────────────────────────────

// GET /api/cricket/leaderboard?type=batting|bowling&limit=25
router.get('/leaderboard', async (req, res) => {
  try {
    const type  = req.query.type === 'bowling' ? 'bowling' : 'batting';
    const limit = Math.min(50, parseInt(req.query.limit) || 25);

    const sortField = type === 'batting' ? { 'batting.runs': -1 } : { 'bowling.wickets': -1 };
    const filterField = type === 'batting' ? { 'batting.innings': { $gt: 0 } } : { 'bowling.innings': { $gt: 0 } };

    const players = await CricketPlayer.find(filterField).sort(sortField).limit(limit).lean();

    const rows = players.map(p => _formatPlayerStats(p)).map(p => {
      const s = p.stats;
      return type === 'batting'
        ? { _id: p._id, name: p.name, innings: s.batting.innings, runs: s.batting.runs, highScore: s.batting.highScore, avg: s.batting.avg, strikeRate: s.batting.strikeRate, fifties: s.batting.fifties, hundreds: s.batting.hundreds }
        : { _id: p._id, name: p.name, innings: s.bowling.innings, wickets: s.bowling.wickets, best: s.bowling.best, avg: s.bowling.avg, economy: s.bowling.economy, fiveWickets: s.bowling.fiveWickets };
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/cricket/players?q=search
router.get('/players', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const filter = q ? { name: { $regex: q, $options: 'i' } } : {};
    const players = await CricketPlayer.find(filter).sort({ name: 1 }).limit(20);
    res.json(players);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /api/cricket/players — create (or return existing)
router.post('/players', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name || name.length < 2) return res.status(400).json({ message: 'Name too short' });
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await CricketPlayer.findOne({ name: { $regex: `^${escaped}$`, $options: 'i' } });
    if (existing) return res.json(existing);
    const player = await CricketPlayer.create({ name });
    res.status(201).json(player);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/cricket/players/:id — player with career stats (read from stored fields)
router.get('/players/:id', async (req, res) => {
  try {
    const player = await CricketPlayer.findById(req.params.id).lean();
    if (!player) return res.status(404).json({ message: 'Player not found' });
    res.json(_formatPlayerStats(player));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

function _formatPlayerStats(p) {
  const bat  = p.batting  || {};
  const bowl = p.bowling  || {};
  const field = p.fielding || {};
  const outs = (bat.innings || 0) - (bat.notOuts || 0);
  return {
    _id: p._id, name: p.name, createdAt: p.createdAt,
    matchCount: p.processedInningsKeys ? Math.ceil(p.processedInningsKeys.length / 2) : 0,
    stats: {
      batting: {
        ...bat,
        avg: outs > 0 ? (bat.runs / outs).toFixed(2) : (bat.runs > 0 ? '∞' : '0.00'),
        strikeRate: bat.balls > 0 ? ((bat.runs / bat.balls) * 100).toFixed(2) : '0.00',
      },
      bowling: {
        ...bowl,
        avg:      bowl.wickets > 0 ? (bowl.runs / bowl.wickets).toFixed(2) : '-',
        economy:  bowl.balls   > 0 ? ((bowl.runs / bowl.balls) * 6).toFixed(2) : '-',
        best:     bowl.bestWickets > 0 ? `${bowl.bestWickets}/${bowl.bestRuns}` : '-',
      },
      fielding: field,
    },
  };
}

async function _updatePlayersFromInnings(inn, matchId, inningsIndex) {
  const key = `${matchId}_${inningsIndex}`;

  for (const b of (inn.batsmen || [])) {
    if (!b.name || !(b.balls > 0)) continue;
    const notOut = b.status !== 'out';
    // Ensure player doc exists
    await CricketPlayer.findOneAndUpdate(
      { name: b.name },
      { $setOnInsert: { name: b.name } },
      { upsert: true }
    );
    // Idempotent stat increment — skipped if this innings key was already processed
    await CricketPlayer.updateOne(
      { name: b.name, processedInningsKeys: { $ne: key } },
      {
        $inc: {
          'batting.innings': 1,
          'batting.runs':    b.runs  || 0,
          'batting.balls':   b.balls || 0,
          ...(notOut                          && { 'batting.notOuts':  1 }),
          ...((b.runs || 0) >= 100            && { 'batting.hundreds': 1 }),
          ...((b.runs || 0) >= 50 && (b.runs || 0) < 100 && { 'batting.fifties': 1 }),
        },
        $max:    { 'batting.highScore': b.runs || 0 },
        $addToSet: { processedInningsKeys: key },
      }
    );
  }

  for (const b of (inn.bowlers || [])) {
    if (!b.name || !(b.balls > 0)) continue;
    await CricketPlayer.findOneAndUpdate(
      { name: b.name },
      { $setOnInsert: { name: b.name } },
      { upsert: true }
    );
    await CricketPlayer.updateOne(
      { name: b.name, processedInningsKeys: { $ne: key } },
      {
        $inc: {
          'bowling.innings':  1,
          'bowling.balls':    b.balls   || 0,
          'bowling.runs':     b.runs    || 0,
          'bowling.wickets':  b.wickets || 0,
          ...((b.wickets || 0) >= 5 && { 'bowling.fiveWickets': 1 }),
        },
        $addToSet: { processedInningsKeys: key },
      }
    );
    // Update best bowling figures only if this performance is better
    if ((b.wickets || 0) > 0) {
      await CricketPlayer.updateOne(
        {
          name: b.name,
          $or: [
            { 'bowling.bestWickets': { $lt: b.wickets } },
            { 'bowling.bestWickets': b.wickets, 'bowling.bestRuns': { $gt: b.runs || 0 } },
            { 'bowling.bestWickets': 0 },
          ],
        },
        { $set: { 'bowling.bestWickets': b.wickets, 'bowling.bestRuns': b.runs || 0 } }
      );
    }
  }
}

function _buildDesc(r, isWicket, isWide, isNoBall, isBye, isLegBye, striker, outDesc) {
  if (isWicket) return `WICKET! ${outDesc || striker + ' out'}`;
  if (isWide) return `Wide${r ? ` +${r}` : ''}`;
  if (isNoBall) return `No Ball${r ? ` +${r}` : ''}`;
  if (isBye) return `${r} Bye${r !== 1 ? 's' : ''}`;
  if (isLegBye) return `${r} Leg Bye${r !== 1 ? 's' : ''}`;
  if (r === 4) return '4 runs (boundary)';
  if (r === 6) return '6 runs (SIX!)';
  return `${r} run${r !== 1 ? 's' : ''}`;
}

function _calcResult(match) {
  const inn1 = match.innings[0];
  const inn2 = match.innings[1];
  if (!inn1 || !inn2) return 'Match ended';
  if (inn2.runs >= inn2.target) {
    const wktsLeft = (match.playersPerSide - 1) - inn2.wickets;
    return `${inn2.battingTeam} ने ${wktsLeft} विकेट से जीत दर्ज की`;
  }
  const diff = inn1.runs - inn2.runs;
  return `${inn1.battingTeam} ने ${diff} रन से जीत दर्ज की`;
}

module.exports = router;
