// RTC stats Report
// Encapsulates analytics and score computation.
const reportDiv = document.getElementById('report');


export function generateReport(importer) {

  if (!importer || !importer.data || !reportDiv) return; //No rtc data or div not found
  reportDiv.innerHTML = '';

  // Crete element to inject Bootstrap (CDN)
  if (!document.getElementById('rtcstats-bootstrap')) {
    const link = document.createElement('link');
    link.id = 'rtcstats-bootstrap';
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css';
    document.head.appendChild(link);
  }

  // Crete element to inject CSS
  if (!document.getElementById('rtcstats-modern')) {
    const style = document.createElement('style');
    style.id = 'rtcstats-modern';
    style.textContent = `
      :root { --rs-radius: 18px; --rs-bg: #f5f5f7; --rs-card-bg: #ffffffcc; --rs-border: #d2d2d7; --rs-accent: #0071e3; font-family: -apple-system, BlinkMacSystemFont,'Segoe UI', Roboto, Oxygen, 'Helvetica Neue', Arial, sans-serif; }
      #report { background: var(--rs-bg); padding: 24px; border-radius: var(--rs-radius); }
      .rs-card { backdrop-filter: saturate(180%) blur(24px); background: var(--rs-card-bg); border: 1px solid var(--rs-border); border-radius: var(--rs-radius); box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
      .rs-header { font-size: 1.15rem; letter-spacing: .5px; }
      table.rs-table th { font-weight:600; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color:#6e6e73; }
      table.rs-table td { font-size:.78rem; }
      .progress-bar { font-size:.7rem; }
      .rs-metric-grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
      .rs-metric { border:1px solid var(--rs-border); border-radius:14px; padding:10px 14px; background:#fff; display:flex; flex-direction:column; gap:4px; }
      .rs-metric span.value { font-weight:600; font-size:1.0rem; }
      .rs-subtle { color:#6e6e73; }
      .rs-pill { border-radius:999px; padding:2px 10px; font-size:.65rem; background:#e8e8ed; color:#424245; }
      .rs-overall { background: linear-gradient(135deg,#ffffff,#f0f0f5); }
      .rs-score-wrapper { min-width:260px; }
      .rs-adv-toggle { cursor:pointer; }
    `;
    document.head.appendChild(style);
  }

  const connections = importer.data.peerConnections || importer.data.PeerConnections || {};
  const isInternals = !!importer.data.PeerConnections;

  const allConnectionMetrics = [];

  function findLastGetStats(trace) {
    if (!Array.isArray(trace)) return null;
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].type === 'getStats') return trace[i];
    }
    return null;
  }

  // Last defined value of a series (any type), or undefined.
  function lastVal(arr) {
    if (!Array.isArray(arr)) return undefined;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== undefined && arr[i] !== null) return arr[i];
    }
    return undefined;
  }
  function lastNum(arr) {
    const v = lastVal(arr);
    return typeof v === 'number' ? v : undefined;
  }

  // ---- Time-series builders -------------------------------------------------
  // All builders return per-report series of the shape:
  //   { id, type, kind, timestamps:[...], series:{ prop:[v0,v1,...] } }
  // so a single aggregator (aggregateSeries) can work for both dump formats.

  // webrtc-internals: stats is keyed by `${id}-${prop}` / `${id}[derived]`, each
  // holding a JSON array of values aligned by getStats poll index.
  function buildSeriesFromInternalsStats(stats) {
    if (!stats) return [];
    const byId = {};
    Object.keys(stats).forEach(reportname => {
      let statsId;
      let statsProperty;
      if (reportname.indexOf('[') !== -1) {
        const t = reportname.split('[');
        statsProperty = '[' + t.pop();
        statsId = t.join('');
        statsId = statsId.substr(0, statsId.length - 1);
      } else {
        const t = reportname.split('-');
        statsProperty = t.pop();
        statsId = t.join('-');
      }
      const entry = stats[reportname];
      let values;
      try {
        values = JSON.parse(entry.values);
      } catch (e) {
        return;
      }
      if (!Array.isArray(values)) return;
      if (!byId[statsId]) byId[statsId] = { id: statsId, type: entry.statsType, series: {} };
      if (statsProperty === 'timestamp') { byId[statsId].timestamps = values; return; }
      byId[statsId].series[statsProperty] = values;
    });
    return Object.values(byId).map(t => {
      t.kind = lastVal(t.series.kind);
      if (!t.timestamps) t.timestamps = [];
      return t;
    });
  }

  // rtcstats / live dumps: every getStats event carries a full snapshot keyed by
  // report id. Group those snapshots into a per-report series.
  function buildSeriesFromTrace(traceEvents) {
    if (!Array.isArray(traceEvents)) return [];
    const byId = {};
    traceEvents.forEach(ev => {
      if (ev.type !== 'getStats' || !ev.value) return;
      Object.keys(ev.value).forEach(id => {
        const r = ev.value[id];
        if (!r || !r.type) return;
        if (!byId[id]) byId[id] = { id, type: r.type, kind: r.kind, timestamps: [], series: {} };
        byId[id].timestamps.push(ev.timestamp);
        Object.keys(r).forEach(prop => {
          if (!byId[id].series[prop]) byId[id].series[prop] = [];
          byId[id].series[prop].push(r[prop]);
        });
      });
    });
    return Object.values(byId);
  }

  // Fallback: turn a single getStats snapshot into 1-sample series.
  function buildSeriesFromSnapshot(snapshot) {
    const stats = snapshot?.value || {};
    return Object.keys(stats).map(id => {
      const r = stats[id];
      const series = {};
      Object.keys(r).forEach(prop => { series[prop] = [r[prop]]; });
      return { id, type: r.type, kind: r.kind, timestamps: [snapshot.timestamp], series };
    });
  }

  // ---- Aggregation ----------------------------------------------------------
  // Computes both sustained (avg / cumulative) and worst-interval (peak) values
  // from the full time series. Cumulative counters (packetsLost, framesDropped,
  // packetsSent, freezeCount...) are differenced between consecutive samples so a
  // burst of loss in the middle of a long session is no longer diluted to ~0%.
  function aggregateSeries(series) {
    const result = {
      avgPacketLossPct: 0, peakPacketLossPct: 0,
      avgJitterMs: 0, peakJitterMs: 0,
      avgFrameDropPct: 0, peakFrameDropPct: 0,
      retransmitPct: 0,
      avgRttMs: 0, peakRttMs: 0,
      bitrateKbps: 0,
      decodeMsPerFrame: 0,
      jitterBufferDelayMs: 0,
      playoutDelayMs: 0,
      audioLevelRms: 0,
      psnrY: 0,
      freezeCount: 0,
      pauseCount: 0,
      limitationReasons: {},
      tracks: [],
    };

    let lostTotal = 0, recvTotal = 0;
    let dropTotal = 0, frameTotal = 0;
    let peakLoss = 0, peakDrop = 0;
    let jitterSum = 0, jitterCount = 0, peakJitter = 0;
    let rttSum = 0, rttCount = 0, peakRtt = 0;
    let decodeSum = 0, decodeCount = 0;
    let jbufSum = 0, jbufCount = 0;
    let playoutSum = 0, playoutCount = 0;
    let audioSum = 0, audioCount = 0;
    let psnrSum = 0, psnrCount = 0;
    let packetsSentTotal = 0, retransTotal = 0;
    let bitrateBits = 0;

    series.forEach(t => {
      const s = t.series || {};
      if (t.type === 'inbound-rtp') {
        // Packet loss: peak per-interval + cumulative.
        const lost = s.packetsLost, recv = s.packetsReceived;
        if (Array.isArray(lost) && Array.isArray(recv)) {
          const n = Math.min(lost.length, recv.length);
          for (let i = 1; i < n; i++) {
            const dL = lost[i] - lost[i - 1];
            const dR = recv[i] - recv[i - 1];
            if (dL >= 0 && dR >= 0 && dL + dR > 0) {
              const pct = (dL / (dL + dR)) * 100;
              if (pct > peakLoss) peakLoss = pct;
            }
          }
          lostTotal += lastNum(lost) || 0;
          recvTotal += lastNum(recv) || 0;
        }
        // Frame drop: peak per-interval + cumulative.
        const fr = s.framesReceived, fd = s.framesDropped;
        if (Array.isArray(fr) && Array.isArray(fd)) {
          const n = Math.min(fr.length, fd.length);
          for (let i = 1; i < n; i++) {
            const dRecv = fr[i] - fr[i - 1];
            const dDrop = fd[i] - fd[i - 1];
            const denom = dRecv + dDrop;
            if (dDrop >= 0 && denom > 0) {
              const pct = (dDrop / denom) * 100;
              if (pct > peakDrop) peakDrop = pct;
            }
          }
          const lastFr = lastNum(fr) || 0, lastFd = lastNum(fd) || 0;
          dropTotal += lastFd;
          frameTotal += lastFr + lastFd;
        }
        // Jitter (gauge): peak + avg across all samples.
        if (Array.isArray(s.jitter)) {
          s.jitter.forEach(v => {
            if (typeof v === 'number') {
              const ms = v * 1000;
              jitterSum += ms; jitterCount++;
              if (ms > peakJitter) peakJitter = ms;
            }
          });
        }
        const dec = lastNum(s['[totalDecodeTime/framesDecoded_in_ms]']);
        if (typeof dec === 'number') { decodeSum += dec; decodeCount++; }
        const jb = lastNum(s['[jitterBufferDelay/jitterBufferEmittedCount_in_ms]']);
        if (typeof jb === 'number') { jbufSum += jb; jbufCount++; }
        const ar = lastNum(s['[Audio_Level_in_RMS]']);
        if (typeof ar === 'number') { audioSum += ar; audioCount++; }
        result.freezeCount += lastNum(s.freezeCount) || 0;
        result.pauseCount += lastNum(s.pauseCount) || 0;
        result.tracks.push({ direction: 'inbound', kind: t.kind });
      } else if (t.type === 'outbound-rtp') {
        packetsSentTotal += lastNum(s.packetsSent) || 0;
        retransTotal += lastNum(s.retransmittedPacketsSent) || 0;
        const br = lastNum(s['[bytesSent/s]']) ?? lastNum(s['[bytesSent_in_bits/s]']);
        if (typeof br === 'number') bitrateBits += br;
        const psnr = lastNum(s['[PSNR_y]']);
        if (typeof psnr === 'number') { psnrSum += psnr; psnrCount++; }
        // Count distinct quality-limitation reasons seen over the session.
        if (Array.isArray(s.qualityLimitationReason)) {
          s.qualityLimitationReason.forEach(reason => {
            if (reason && reason !== 'none') {
              result.limitationReasons[reason] = (result.limitationReasons[reason] || 0) + 1;
            }
          });
        }
        result.tracks.push({ direction: 'outbound', kind: t.kind });
      } else if (t.type === 'candidate-pair') {
        // Prefer the per-sample currentRoundTripTime gauge; fall back to ratio.
        if (Array.isArray(s.currentRoundTripTime)) {
          s.currentRoundTripTime.forEach(v => {
            if (typeof v === 'number') {
              const ms = v * 1000;
              rttSum += ms; rttCount++;
              if (ms > peakRtt) peakRtt = ms;
            }
          });
        } else {
          const r = lastNum(s['[totalRoundTripTime/responsesReceived]']);
          if (typeof r === 'number') {
            const ms = r * 1000;
            rttSum += ms; rttCount++;
            if (ms > peakRtt) peakRtt = ms;
          }
        }
      } else if (t.type === 'media-playout') {
        const p = lastNum(s['[totalPlayoutDelay/totalSamplesCount]']);
        if (typeof p === 'number') { playoutSum += p * 1000; playoutCount++; }
      }
    });

    result.peakPacketLossPct = peakLoss;
    result.avgPacketLossPct = (lostTotal + recvTotal) ? (lostTotal / (lostTotal + recvTotal)) * 100 : 0;
    result.peakFrameDropPct = peakDrop;
    result.avgFrameDropPct = frameTotal ? (dropTotal / frameTotal) * 100 : 0;
    result.avgJitterMs = jitterCount ? (jitterSum / jitterCount) : 0;
    result.peakJitterMs = peakJitter;
    result.retransmitPct = packetsSentTotal ? (retransTotal / packetsSentTotal) * 100 : 0;
    result.bitrateKbps = bitrateBits ? (bitrateBits / 1000) : 0;
    result.avgRttMs = rttCount ? (rttSum / rttCount) : 0;
    result.peakRttMs = peakRtt;
    result.decodeMsPerFrame = decodeCount ? (decodeSum / decodeCount) : 0;
    result.jitterBufferDelayMs = jbufCount ? (jbufSum / jbufCount) : 0;
    result.playoutDelayMs = playoutCount ? (playoutSum / playoutCount) : 0;
    result.audioLevelRms = audioCount ? (audioSum / audioCount) : 0;
    result.psnrY = psnrCount ? (psnrSum / psnrCount) : 0;
    return result;
  }

  // Score blends sustained (avg) and worst-interval (peak) behaviour so transient
  // degradations are visible while sustained problems dominate. Thresholds and
  // slopes are calibrated so a clean baseline stays ~95-100 while degraded
  // scenarios drop clearly.
  function computeScore(m) {
    let score = 100;
    const blend = (avg, peak) => 0.5 * (avg || 0) + 0.5 * (peak || 0);

    // Packet loss — most impactful; penalize from ~0.5%.
    const lossEff = blend(m.avgPacketLossPct, m.peakPacketLossPct);
    if (lossEff > 0.5) score -= Math.min(55, (lossEff - 0.5) * 9);

    // Jitter — threshold 15ms.
    const jitterEff = blend(m.avgJitterMs, m.peakJitterMs);
    if (jitterEff > 15) score -= Math.min(25, (jitterEff - 15) * 1.2);

    // Frame drop — threshold 2%.
    const dropEff = blend(m.avgFrameDropPct, m.peakFrameDropPct);
    if (dropEff > 2) score -= Math.min(20, (dropEff - 2) * 3);

    // Round-trip time — interactivity suffers above ~150ms.
    const rttEff = blend(m.avgRttMs, m.peakRttMs);
    if (rttEff > 150) score -= Math.min(15, (rttEff - 150) / 20);

    // Retransmissions — threshold 1%.
    if (m.retransmitPct > 1) score -= Math.min(10, (m.retransmitPct - 1) * 3);

    // Freezes / pauses accumulated over the session. A small grace absorbs the
    // unavoidable startup freeze each camera produces; sustained freezing still
    // penalizes heavily.
    if (m.freezeCount > 2) score -= Math.min(20, (m.freezeCount - 2) * 3);
    if (m.pauseCount) score -= Math.min(10, m.pauseCount * 3);

    return Math.max(0, Math.round(score));
  }

  // Session span across all connections: start timestamp and total length (ms).
  function computeSessionSpan() {
    let minStart = Infinity, maxEnd = -Infinity;
    Object.keys(connections).forEach(id => {
      const trace = connections[id];
      if (isInternals && trace.stats) {
        Object.values(trace.stats).forEach(entry => {
          if (!entry) return;
          const start = Date.parse(entry.startTime);
          const end = Date.parse(entry.endTime);
          if (!isNaN(start) && start < minStart) minStart = start;
          if (!isNaN(end) && end > maxEnd) maxEnd = end;
        });
      } else {
        const events = isInternals ? trace.updateLog : trace;
        if (Array.isArray(events) && events.length) {
          const first = events[0].timestamp;
          const last = events[events.length - 1].timestamp;
          if (typeof first === 'number' && first < minStart) minStart = first;
          if (typeof last === 'number' && last > maxEnd) maxEnd = last;
        }
      }
    });
    const valid = isFinite(minStart) && isFinite(maxEnd) && maxEnd > minStart;
    return {
      startMs: valid ? minStart : null,
      durationMs: valid ? (maxEnd - minStart) : 0,
    };
  }

  const sessionSpan = computeSessionSpan();
  const sessionStartLabel = sessionSpan.startMs != null
    ? new Date(sessionSpan.startMs).toLocaleString()
    : '—';
  const sessionMinutes = sessionSpan.durationMs / 60000;
  const sessionDurationLabel = sessionMinutes >= 1
    ? sessionMinutes.toFixed(1) + ' min'
    : Math.round(sessionMinutes * 60) + ' sec';

  function makeScoreBar(score) {
    const wrapper = document.createElement('div');
    wrapper.className = 'rs-score-wrapper d-flex align-items-center gap-2';
    const progress = document.createElement('div');
    progress.className = 'progress flex-grow-1';
    progress.style.height = '16px';
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.role = 'progressbar';
    bar.style.width = score + '%';
    bar.style.background = `linear-gradient(90deg, hsl(${score * 1.2},70%,55%), hsl(${score * 1.2 + 25},70%,45%))`;
    bar.innerText = score + '%';
    progress.appendChild(bar);
    wrapper.appendChild(progress);
    const badge = document.createElement('span');
    badge.className = 'rs-pill';
    badge.innerText = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Poor';
    wrapper.appendChild(badge);
    return wrapper;
  }

  const details = document.createElement('div');
  details.className = 'rs-card p-4 mb-4';
  const summary = document.createElement('div');
  summary.className = 'rs-header d-flex align-items-center justify-content-between mb-3';
  summary.innerHTML = '<span>RTC Quality Report</span><span class="rs-pill">Test Date: ' + sessionStartLabel + '</span>';
  details.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'rs-table table table-borderless table-hover mb-4 align-middle';
  const head = document.createElement('tr');
  ['Connection', 'Peak Loss %', 'Peak Jitter ms', 'Peak RTT ms', 'Decode ms/frame', 'JBuf ms', 'Bitrate kbps', 'Peak FrameDrop %', 'Retransmit %', 'Freezes', 'Score'].forEach(h => {
    const th = document.createElement('th'); th.innerText = h; head.appendChild(th);
  });
  table.appendChild(head);

  function getConnectionLabel(trace, isInternals) {
    // Try to determine connection type (Cameras or streaming)
    const traceEvents = isInternals ? trace.updateLog : trace;
    if (traceEvents && Array.isArray(traceEvents)) {
      for (let i = traceEvents.length - 1; i >= 0; i--) {
        const event = traceEvents[i];
        if (event.type === 'transceiverModified' && event.value) {
          try {
            const value = JSON.parse(event.value);
            const streams = value.receiver?.streams || [];
            for (const stream of streams) {
              if (typeof stream === 'string') {
                if (stream.includes('.camera.')) return 'Cameras';
                if (stream.includes('.kvm.')) return 'Streaming';
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
    return null;
  }

  const connectionIds = Object.keys(connections);
  connectionIds.forEach(id => {
    const trace = connections[id];
    const traceEvents = isInternals ? trace.updateLog : trace;
    let series = isInternals ? buildSeriesFromInternalsStats(trace.stats) : buildSeriesFromTrace(traceEvents);
    if (!series.length) {
      const snapshot = findLastGetStats(traceEvents);
      if (snapshot) series = buildSeriesFromSnapshot(snapshot);
    }
    const metrics = aggregateSeries(series);
    const score = computeScore(metrics);
    metrics.score = score;
    allConnectionMetrics.push(metrics);

    const connectionLabel = getConnectionLabel(trace, isInternals);
    const displayName = connectionLabel || id;

    const row = document.createElement('tr');
    function td(v) { const c = document.createElement('td'); c.innerText = typeof v === 'number' ? v.toFixed(2) : v; return c; }
    row.appendChild(td(displayName));
    row.appendChild(td(metrics.peakPacketLossPct));
    row.appendChild(td(metrics.peakJitterMs));
    row.appendChild(td(metrics.peakRttMs));
    row.appendChild(td(metrics.decodeMsPerFrame));
    row.appendChild(td(metrics.jitterBufferDelayMs));
    row.appendChild(td(metrics.bitrateKbps));
    row.appendChild(td(metrics.peakFrameDropPct));
    row.appendChild(td(metrics.retransmitPct));
    row.appendChild(td(metrics.freezeCount));
    const scoreCell = document.createElement('td'); scoreCell.appendChild(makeScoreBar(score)); row.appendChild(scoreCell);
    table.appendChild(row);
  });

  // Table with metrics
  const advDetails = document.createElement('details');
  advDetails.open = false;
  advDetails.style.margin = '10px';
  const advSummary = document.createElement('summary'); advSummary.innerText = 'Advanced Metrics'; advDetails.appendChild(advSummary);
  const advTable = document.createElement('table');
  const advHead = document.createElement('tr');
  ['Connection', 'Avg Loss %', 'Avg Jitter ms', 'Avg RTT ms', 'Avg FrameDrop %', 'Audio RMS', 'Playout Delay ms', 'Limitation Reasons', 'PSNR-Y'].forEach(h => { const th = document.createElement('th'); th.innerText = h; advHead.appendChild(th); });
  advTable.appendChild(advHead);
  allConnectionMetrics.forEach((m, i) => {
    const row = document.createElement('tr');
    function td(v) { const c = document.createElement('td'); c.innerText = typeof v === 'number' ? v.toFixed(2) : v; return c; }
    const limitation = Object.keys(m.limitationReasons).map(k => k + ':' + m.limitationReasons[k]).join(', ') || 'none';
    const id = connectionIds[i];
    const trace = connections[id];
    const connectionLabel = getConnectionLabel(trace, isInternals);
    const displayName = connectionLabel || id;
    row.appendChild(td(displayName));
    row.appendChild(td(m.avgPacketLossPct));
    row.appendChild(td(m.avgJitterMs));
    row.appendChild(td(m.avgRttMs));
    row.appendChild(td(m.avgFrameDropPct));
    row.appendChild(td(m.audioLevelRms));
    row.appendChild(td(m.playoutDelayMs));
    row.appendChild(td(limitation));
    row.appendChild(td(m.psnrY));
    advTable.appendChild(row);
  });
  advDetails.appendChild(advTable);
  details.appendChild(advDetails);

  // Overall metrics aggregation. Averaged fields keep the per-connection mean;
  // peaks and counters take the worst/total across connections so the overall
  // score reflects the most degraded path.
  const overall = allConnectionMetrics.reduce((acc, m) => {
    acc.avgPacketLossPct += m.avgPacketLossPct;
    acc.avgJitterMs += m.avgJitterMs;
    acc.avgFrameDropPct += m.avgFrameDropPct;
    acc.avgRttMs += m.avgRttMs;
    acc.retransmitPct += m.retransmitPct;
    acc.bitrateKbps += m.bitrateKbps;
    acc.peakPacketLossPct = Math.max(acc.peakPacketLossPct, m.peakPacketLossPct);
    acc.peakJitterMs = Math.max(acc.peakJitterMs, m.peakJitterMs);
    acc.peakFrameDropPct = Math.max(acc.peakFrameDropPct, m.peakFrameDropPct);
    acc.peakRttMs = Math.max(acc.peakRttMs, m.peakRttMs);
    acc.freezeCount += m.freezeCount;
    acc.pauseCount += m.pauseCount;
    return acc;
  }, { avgPacketLossPct: 0, avgJitterMs: 0, avgFrameDropPct: 0, avgRttMs: 0, retransmitPct: 0, bitrateKbps: 0, peakPacketLossPct: 0, peakJitterMs: 0, peakFrameDropPct: 0, peakRttMs: 0, freezeCount: 0, pauseCount: 0 });
  const n = allConnectionMetrics.length || 1;
  ['avgPacketLossPct', 'avgJitterMs', 'avgFrameDropPct', 'avgRttMs', 'retransmitPct'].forEach(k => { overall[k] /= n; });
  const overallScore = computeScore(overall);

  const overallDiv = document.createElement('div');
  overallDiv.className = 'rs-overall p-3 rounded-4 mb-3 d-flex flex-column flex-lg-row align-items-lg-center gap-3';
  const overallTitle = document.createElement('div'); overallTitle.innerHTML = '<strong>Overall Quality</strong><div class="rs-subtle small">Aggregated performance across all connections</div>';
  overallDiv.appendChild(overallTitle);
  overallDiv.appendChild(makeScoreBar(overallScore));
  details.appendChild(overallDiv);

  details.appendChild(table);

  // Extra analytics section
  const analytics = document.createElement('div');
  analytics.className = 'rs-metric-grid mb-2';
  function metricCard(title, value) {
    const card = document.createElement('div'); card.className = 'rs-metric';
    const t = document.createElement('span'); t.className = 'rs-subtle small'; t.innerText = title;
    const v = document.createElement('span'); v.className = 'value'; v.innerText = value;
    card.appendChild(t); card.appendChild(v); return card;
  }
  analytics.appendChild(metricCard('Session Duration', sessionDurationLabel));
  analytics.appendChild(metricCard('Avg Packet Loss %', overall.avgPacketLossPct.toFixed(2)));
  analytics.appendChild(metricCard('Peak Packet Loss %', overall.peakPacketLossPct.toFixed(2)));
  analytics.appendChild(metricCard('Avg Jitter (ms)', overall.avgJitterMs.toFixed(2)));
  analytics.appendChild(metricCard('Peak Jitter (ms)', overall.peakJitterMs.toFixed(2)));
  analytics.appendChild(metricCard('Total Bitrate (kbps)', overall.bitrateKbps.toFixed(2)));
  analytics.appendChild(metricCard('Avg Frame Drop %', overall.avgFrameDropPct.toFixed(2)));
  analytics.appendChild(metricCard('Avg Retransmit %', overall.retransmitPct.toFixed(2)));
  analytics.appendChild(metricCard('Total Freezes', overall.freezeCount));
  details.appendChild(analytics);

  const outer = document.createElement('div'); outer.className = 'container-fluid px-0'; outer.appendChild(details); reportDiv.appendChild(outer);
}
