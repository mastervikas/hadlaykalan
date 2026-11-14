/* Cricket pushes.
   - Match start, innings break and result go to everyone (and the bell history).
   - While a match is live, a scorecard notification is updated in place: every push
     uses the tag `cricket_<id>`, so Android replaces the previous card instead of
     stacking new ones, on the silent `hadlay_live` channel.
   Live updates are throttled: wickets, boundaries and over ends go out at once,
   other balls at most every 45 seconds per match. */
const { broadcast, pushOnly } = require('./notificationService');

const lastLive = new Map(); // matchId → timestamp
const LIVE_GAP_MS = 45_000;

const ov = inn => `${inn.overs || 0}${inn.balls ? `.${inn.balls}` : ''}`;
const score = inn => `${inn.runs || 0}/${inn.wickets || 0} (${ov(inn)})`;

function liveText(match) {
  const inn = match.innings[match.currentInnings - 1];
  if (!inn) return null;
  const parts = [`${inn.battingTeam} ${score(inn)}`];
  if (inn.target) {
    const need = inn.target - inn.runs;
    const ballsLeft = match.totalOvers * 6 - (inn.overs * 6 + inn.balls);
    if (need > 0) parts.push(`जीत के लिए ${need} रन, ${ballsLeft} गेंद`);
  } else if (match.innings.length === 1) {
    const balls = inn.overs * 6 + inn.balls;
    if (balls) parts.push(`रन रेट ${((inn.runs / balls) * 6).toFixed(2)}`);
  }
  const bats = (inn.batsmen || []).filter(b => b.status === 'batting')
    .map(b => `${b.name}${b.name === inn.striker ? '*' : ''} ${b.runs}(${b.balls})`);
  if (bats.length) parts.push(bats.join(', '));
  const bowler = (inn.bowlers || []).find(b => b.name === inn.currentBowler);
  if (bowler) parts.push(`🎯 ${bowler.name} ${bowler.wickets}-${bowler.runs}`);
  const last = (inn.ballByBall || []).slice(-1)[0];
  return { title: `🔴 LIVE · ${match.teamA} बनाम ${match.teamB}`, body: parts.join(' · '), last };
}

const data = (match, extra = {}) => ({
  type: 'cricket', targetPage: 'cricket', targetId: String(match._id), ...extra,
});

async function notifyCricket(match, event) {
  try {
    const id = String(match._id);
    const tag = `cricket_${id}`;
    if (event === 'start') {
      const inn = match.innings[0];
      await broadcast({
        title: `🏏 मैच शुरू: ${match.teamA} बनाम ${match.teamB}`,
        body: `${match.tossWinner} ने टॉस जीतकर ${match.tossElected === 'bat' ? 'बल्लेबाज़ी' : 'गेंदबाज़ी'} चुनी। ${inn ? inn.battingTeam + ' बल्लेबाज़ी कर रही है।' : ''} लाइव स्कोर देखें।`,
        type: 'cricket', targetPage: 'cricket', targetId: id, source: 'auto', tag,
      });
      lastLive.set(id, Date.now());
      return;
    }
    if (event === 'innings_break') {
      const first = match.innings[0];
      await broadcast({
        title: `🏏 पारी ब्रेक · ${match.teamA} बनाम ${match.teamB}`,
        body: `${first.battingTeam} ${score(first)} — ${match.innings[1] ? match.innings[1].battingTeam : ''} को जीत के लिए ${first.runs + 1} रन चाहिए`,
        type: 'cricket', targetPage: 'cricket', targetId: id, source: 'auto', tag,
      });
      return;
    }
    if (event === 'completed') {
      lastLive.delete(id);
      const lines = match.innings.map(i => `${i.battingTeam} ${score(i)}`).join(' · ');
      await broadcast({
        title: `🏆 ${match.result || 'मैच खत्म'}`,
        body: `${match.teamA} बनाम ${match.teamB}: ${lines}`,
        type: 'cricket', targetPage: 'cricket', targetId: id, source: 'auto', tag,
      });
      return;
    }
    if (event === 'ball') {
      const t = liveText(match);
      if (!t) return;
      const b = t.last || {};
      const inn = match.innings[match.currentInnings - 1];
      const important = b.isWicket || (!b.isBye && !b.isLegBye && (b.runs === 4 || b.runs === 6)) || (inn && inn.balls === 0 && !b.isWide && !b.isNoBall);
      if (!important && Date.now() - (lastLive.get(id) || 0) < LIVE_GAP_MS) return;
      lastLive.set(id, Date.now());
      const prefix = b.isWicket ? '☝️ विकेट! ' : b.runs === 6 ? '💥 छक्का! ' : b.runs === 4 ? '🔥 चौका! ' : '';
      await pushOnly({ title: t.title, body: prefix + t.body, category: 'cricketLive', data: data(match), tag });
    }
  } catch (err) {
    console.error('[Cricket] notify error:', err.message);
  }
}

module.exports = { notifyCricket };
