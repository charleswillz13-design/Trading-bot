/* Premium Gold Scalper - phone engine.
   Same strategy as the MT5 EA, running inside the app and trading through the MetaApi cloud REST API.
   Pure logic: all network/storage/time access goes through the `io` object so it can be tested. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    symbol: 'XAUUSD', magic: 20261101,
    balancePerStep: 100, minLot: 0.01, maxLot: 5,
    minPositions: 3, maxPositions: 5, strongMult: 2, veryStrongMult: 3,
    initialSL: 1.5, trailStart: 0.3, trailDistance: 0.6, trailStep: 0.05,
    momentumBars: 3, minBody: 0.2, useReversal: 1, reversalMove: 3,
    maxSpread: 0.6, cooldownMs: 1500, tradeOnStart: 1,
    basketRiskPct: 15, dailyLossPct: 20
  };

  function createEngine(cfgIn, io) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    const S = {
      running: false, live: false, price: null, lastBid: null,
      closes: [], curOpen: null, curMin: null,
      positions: [], account: null,
      spec: { digits: 2, contractSize: 100, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01 },
      status: 'Stopped', signal: '-', warm: '', error: '',
      dayPL: 0, dayStart: null, baskets: 0, lastEntry: 0, firstDone: true, log: []
    };
    let busy = false, lastPos = 0, lastAcct = 0, specTried = false;
    const lastMod = {};

    const log = m => { S.log.unshift({ t: io.now(), m }); if (S.log.length > 40) S.log.pop(); };
    const round = x => Number(x.toFixed(S.spec.digits));
    const ok = r => !!r && (r.stringCode === 'TRADE_RETCODE_DONE' || r.stringCode === 'TRADE_RETCODE_PLACED' ||
                            r.stringCode === 'TRADE_RETCODE_NO_CHANGES' || r.numericCode === 10009);

    function normLot(l) {
      const step = S.spec.volumeStep || 0.01;
      l = Math.floor(l / step + 1e-9) * step;
      if (l < S.spec.minVolume) l = l <= 0 ? 0 : S.spec.minVolume;
      if (l > S.spec.maxVolume) l = S.spec.maxVolume;
      return Number(l.toFixed(2));
    }

    function dynamicLot() {
      const bal = S.account ? S.account.balance : 0;
      let l = Math.max(cfg.minLot, Math.floor(bal / cfg.balancePerStep) * 0.01);
      return normLot(Math.min(l, cfg.maxLot));
    }

    // ---- price -> local M1 candles ----
    function onPrice(p) {
      const bid = +p.bid, ask = +p.ask;
      if (!(bid > 0) || !(ask > 0)) throw new Error('bad price');
      let t = p.time ? Date.parse(p.time) : NaN;
      if (isNaN(t)) t = io.now();
      const minute = Math.floor(t / 60000);
      if (S.curMin === null) { S.curMin = minute; S.curOpen = bid; }
      else if (minute > S.curMin) {
        if (minute - S.curMin > 1) S.closes = [];          // missed minutes (phone slept): history is stale
        else { S.closes.push(S.lastBid); if (S.closes.length > 20) S.closes.shift(); }
        S.curMin = minute; S.curOpen = bid;
      }
      S.lastBid = bid;
      S.price = { bid, ask };
    }

    // ---- signal (mirrors the EA) ----
    function getSignal() {
      const N = cfg.momentumBars, c = S.closes;
      if (c.length < N + 1) { S.warm = 'Warming up ' + c.length + '/' + (N + 1) + ' candles'; return { dir: 0, why: S.warm, strength: 0 }; }
      S.warm = '';
      const bid = S.price.bid, cur = bid - S.curOpen;
      const c1 = c[c.length - 1], cN = c[c.length - 1 - N], mom = c1 - cN;
      if (cfg.useReversal) {
        if (mom <= -cfg.reversalMove && cur >= cfg.minBody) return { dir: 1, why: 'Reversal BUY', strength: Math.abs(cur) };
        if (mom >= cfg.reversalMove && cur <= -cfg.minBody) return { dir: -1, why: 'Reversal SELL', strength: Math.abs(cur) };
      }
      if (cur >= cfg.minBody && mom >= 0) return { dir: 1, why: 'Momentum BUY', strength: Math.abs(cur) };
      if (cur <= -cfg.minBody && mom <= 0) return { dir: -1, why: 'Momentum SELL', strength: Math.abs(cur) };
      if (!S.firstDone) {
        const lean = bid - c1;
        return lean >= 0 ? { dir: 1, why: 'Start BUY', strength: Math.abs(lean) } : { dir: -1, why: 'Start SELL', strength: Math.abs(lean) };
      }
      return { dir: 0, why: 'waiting', strength: 0 };
    }

    function basketSize(strength) {
      const top = Math.max(1, cfg.maxPositions), base = Math.min(cfg.minPositions, top);
      let n = base;
      if (strength >= cfg.minBody * cfg.veryStrongMult) n = top;
      else if (strength >= cfg.minBody * cfg.strongMult) n = Math.min(top, base + 1);
      return Math.max(1, Math.min(n, top));
    }

    // ---- day P/L ----
    function updateDay() {
      if (!S.account) return;
      const key = io.dayKey();
      let d = io.load('pgs_day');
      if (!d || d.key !== key) { d = { key, bal: S.account.equity }; io.save('pgs_day', d); }
      S.dayStart = d.bal;
      S.dayPL = S.account.equity - d.bal;
    }

    // ---- trailing stop (always on while running) ----
    async function manage() {
      if (!S.price) return;
      const { bid, ask } = S.price, dist = cfg.trailDistance, now = io.now();
      for (const p of S.positions) {
        if (lastMod[p.id] && now - lastMod[p.id] < 1000) continue;
        const buy = /BUY/.test(p.type), open = +p.openPrice, sl = +p.stopLoss || 0;
        let ns = null;
        if (buy) {
          if (bid - open < cfg.trailStart) continue;
          const c = round(bid - dist);
          if ((sl === 0 || c >= sl + cfg.trailStep - 1e-9) && c < bid) ns = c;
        } else {
          if (open - ask < cfg.trailStart) continue;
          const c = round(ask + dist);
          if ((sl === 0 || c <= sl - cfg.trailStep + 1e-9) && c > ask) ns = c;
        }
        if (ns === null) continue;
        lastMod[p.id] = now;
        try {
          const r = await io.post('/trade', { actionType: 'POSITION_MODIFY', positionId: String(p.id), stopLoss: ns });
          if (ok(r)) p.stopLoss = ns; else log('SL modify rejected: ' + (r && (r.message || r.stringCode)));
        } catch (e) { log('SL modify failed: ' + e.message); }
      }
    }

    // ---- entries ----
    async function tryEnter() {
      const now = io.now();
      const cd = S.live ? cfg.cooldownMs : Math.max(cfg.cooldownMs, 10000);
      if (now - S.lastEntry < cd) return;
      if (!S.account || !S.price) { S.status = 'Waiting for data'; return; }
      const { bid, ask } = S.price;
      if (ask - bid > cfg.maxSpread) { S.status = 'Spread too wide'; return; }
      if (cfg.dailyLossPct > 0 && S.dayStart > 0 && S.dayPL <= -(S.dayStart * cfg.dailyLossPct / 100)) { S.status = 'Daily loss limit hit'; return; }

      const sig = getSignal();
      S.signal = sig.why;
      if (sig.dir === 0) { S.status = S.warm || 'Waiting for signal'; return; }

      let lots = dynamicLot(), count = basketSize(sig.strength);
      const sld = cfg.initialSL;

      // margin estimate from leverage
      const lev = +S.account.leverage;
      if (lev > 0 && lots > 0) {
        const mPer = ask * S.spec.contractSize * lots / lev;
        const aff = Math.floor(S.account.freeMargin * 0.85 / mPer);
        if (aff < 1) { S.status = 'Not enough margin'; return; }
        if (aff < count) count = aff;
      }
      // risk cap so a small account is never over-exposed
      if (cfg.basketRiskPct > 0) {
        const perPos = sld * S.spec.contractSize * lots;
        const cap = S.account.balance * cfg.basketRiskPct / 100;
        const maxCount = Math.floor(cap / perPos + 1e-9);
        if (maxCount < 1) { S.status = 'Risk too high for balance'; return; }
        if (maxCount < count) count = maxCount;
      }
      if (lots <= 0) { S.status = 'Not enough margin'; return; }

      const buy = sig.dir > 0, side = buy ? 'BUY' : 'SELL';
      S.lastEntry = now; S.firstDone = true;

      if (!S.live) { S.status = 'DRY RUN: would open ' + count + ' x ' + side + ' ' + lots.toFixed(2); log(S.status + ' (' + sig.why + ')'); return; }

      const sl = round(buy ? ask - sld : bid + sld);
      const orders = [];
      for (let i = 0; i < count; i++)
        orders.push(io.post('/trade', { actionType: buy ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL', symbol: cfg.symbol, volume: lots, stopLoss: sl, magic: cfg.magic, comment: 'PGS' }).catch(e => ({ error: e.message })));
      const res = await Promise.all(orders);
      const done = res.filter(ok).length;
      if (done) { S.baskets++; S.status = 'Opened ' + done + ' x ' + side + ' ' + lots.toFixed(2); }
      else S.status = 'Order failed: ' + (res[0] && (res[0].message || res[0].stringCode || res[0].error));
      log(S.status + ' (' + sig.why + ')');
      lastPos = 0;                          // refresh positions on the next tick
    }

    // ---- main loop step ----
    async function tick() {
      if (busy) return;
      busy = true;
      try {
        const now = io.now();
        if (!specTried) {
          specTried = true;
          try {
            const sp = await io.get('/symbols/' + encodeURIComponent(cfg.symbol) + '/specification');
            ['digits', 'contractSize', 'minVolume', 'maxVolume', 'volumeStep'].forEach(k => { if (sp && +sp[k] > 0) S.spec[k] = +sp[k]; });
            if (sp && sp.digits === 0) S.spec.digits = 0;
          } catch (e) { log('Using default symbol spec (' + e.message + ')'); }
        }
        onPrice(await io.get('/symbols/' + encodeURIComponent(cfg.symbol) + '/current-price'));
        if (now - lastAcct >= 5000 || !S.account) { S.account = await io.get('/account-information'); lastAcct = now; updateDay(); }
        if (S.running) {
          if (now - lastPos >= 2000 || lastPos === 0) {
            const all = await io.get('/positions');
            S.positions = (all || []).filter(p => p.symbol === cfg.symbol && +p.magic === +cfg.magic);
            lastPos = now;
          }
          await manage();
          if (!S.positions.length && !S.entering) await tryEnter();
          else if (S.positions.length) S.status = S.live ? 'In trade (' + S.positions.length + ')' : 'Positions open (trailing)';
        } else S.status = 'Stopped';
        S.error = '';
      } catch (e) { S.error = e.message || String(e); }
      busy = false;
      io.onUpdate && io.onUpdate();
    }

    async function closeAll() {
      const list = S.positions.slice();
      const res = await Promise.all(list.map(p => io.post('/trade', { actionType: 'POSITION_CLOSE_ID', positionId: String(p.id) }).catch(e => ({ error: e.message }))));
      log('Close all: ' + res.filter(ok).length + '/' + list.length + ' closed');
      lastPos = 0;
    }

    return {
      S, cfg, tick, closeAll,
      start(live) { S.running = true; S.live = !!live; S.firstDone = !cfg.tradeOnStart; lastPos = 0; log('Started (' + (live ? 'LIVE' : 'dry run') + ')'); },
      stop() { S.running = false; log('Stopped'); },
      setLive(v) { S.live = !!v; log('Mode: ' + (v ? 'LIVE' : 'dry run')); },
      setParams(p) { Object.assign(cfg, p); }
    };
  }

  const api = { createEngine, DEFAULTS };
  root.PGS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
