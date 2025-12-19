// RTC stats Report.
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
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].type === 'getStats') return trace[i];
    }
    return null;
  }

  function computeMetricsFromSnapshot(snapshot) {
    const stats = snapshot?.value || {};
    const metrics = {
      inbound: [],
      outbound: [],
      datachannel: [],
      candidatePair: [],
      playout: [],
    };
    Object.keys(stats).forEach(id => {
      const r = stats[id];
      switch (r.type) {
        case 'inbound-rtp':
          metrics.inbound.push(r);
          break;
        case 'outbound-rtp':
          metrics.outbound.push(r);
          break;
        case 'data-channel':
          metrics.datachannel.push(r);
          break;
        case 'candidate-pair':
          metrics.candidatePair.push(r);
          break;
        case 'media-playout':
          metrics.playout.push(r);
          break;
      }
    });
    return metrics;
  }

  function buildSnapshotFromInternalsStats(stats) {
    if (!stats) return null;
    const reports = {};
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
      if (statsProperty === 'timestamp') return;
      const entry = stats[reportname];
      let values;
      try {
        values = JSON.parse(entry.values);
      } catch (e) {
        return;
      }
      if (!values || !values.length) return;
      if (!reports[statsId]) reports[statsId] = { type: entry.statsType };
      if (statsProperty === 'type') {
        reports[statsId].type = values[values.length - 1];
        return;
      }
      if (!reports[statsId].timestamp) {
        const tsEntry = stats[`${statsId}-timestamp`];
        if (tsEntry) {
          try {
            const tsValues = JSON.parse(tsEntry.values);
            reports[statsId].timestamp = tsValues[tsValues.length - 1];
          } catch (e) {
            /* ignore timestamp parsing errors */
          }
        }
      }
      reports[statsId][statsProperty] = values[values.length - 1];
    });
    return Object.keys(reports).length ? { value: reports } : null;
  }

  function aggregate(metrics) {
    const result = {
      packetLossPct: 0,
      jitterMsAvg: 0,
      bitrateKbps: 0,
      frameDropPct: 0,
      retransmitPct: 0,
      pauseCount: 0,
      avgRttMs: 0,
      decodeMsPerFrame: 0,
      jitterBufferDelayMs: 0,
      playoutDelayMs: 0,
      audioLevelRms: 0,
      psnrY: 0,
      limitationReasons: {},
      tracks: [],
    };

    let inboundCount = 0, jitterSum = 0;
    let packetsLostTotal = 0, packetsReceivedTotal = 0;
    let framesReceivedTotal = 0, framesDroppedTotal = 0;
    let packetsSentTotal = 0, retransmittedPacketsSentTotal = 0;
    let bytesSentPerSecondTotalBits = 0;
    let rttSumMs = 0, rttCount = 0;
    let decodeSum = 0, decodeCount = 0;
    let jitterBufferDelaySum = 0, jitterBufferDelayCount = 0;
    let playoutDelaySumMs = 0, playoutDelayCount = 0;
    let audioRmsSum = 0, audioRmsCount = 0;
    let psnrYSum = 0, psnrYCount = 0;

    metrics.inbound.forEach(r => {
      if (typeof r.jitter === 'number') { jitterSum += r.jitter * 1000; inboundCount++; }
      if (typeof r.packetsLost === 'number') packetsLostTotal += r.packetsLost;
      if (typeof r.packetsReceived === 'number') packetsReceivedTotal += r.packetsReceived;
      if (typeof r.framesReceived === 'number') framesReceivedTotal += r.framesReceived;
      if (typeof r.framesDropped === 'number') framesDroppedTotal += r.framesDropped;
      const decodeMetric = r['[totalDecodeTime/framesDecoded_in_ms]'];
      if (typeof decodeMetric === 'number') { decodeSum += decodeMetric; decodeCount++; }
      const jitterBufferMetric = r['[jitterBufferDelay/jitterBufferEmittedCount_in_ms]'];
      if (typeof jitterBufferMetric === 'number') { jitterBufferDelaySum += jitterBufferMetric; jitterBufferDelayCount++; }
      const audioRms = r['[Audio_Level_in_RMS]'];
      if (typeof audioRms === 'number') { audioRmsSum += audioRms; audioRmsCount++; }
      if (r.active === false) result.pauseCount++;
      if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') result.pauseCount++;
      result.tracks.push({ direction: 'inbound', kind: r.kind, mid: r.mid, codecId: r.codecId });
    });

    metrics.outbound.forEach(r => {
      if (typeof r.packetsSent === 'number') packetsSentTotal += r.packetsSent;
      if (typeof r.retransmittedPacketsSent === 'number') retransmittedPacketsSentTotal += r.retransmittedPacketsSent;
      const outboundBitrate = r['[bytesSent/s]'] ?? r['[bytesSent_in_bits/s]'];
      if (typeof outboundBitrate === 'number') bytesSentPerSecondTotalBits += outboundBitrate;
      const rttMetric = r['[totalRoundTripTime/roundTripTimeMeasurements]'];
      if (typeof rttMetric === 'number') { rttSumMs += rttMetric * 1000; rttCount++; }
      if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') {
        result.limitationReasons[r.qualityLimitationReason] = (result.limitationReasons[r.qualityLimitationReason] || 0) + 1;
      }
      if (r.active === false) result.pauseCount++;
      result.tracks.push({ direction: 'outbound', kind: r.kind, mid: r.mid, codecId: r.codecId });
    });

    // Candidate pair RTT fallback.
    metrics.candidatePair?.forEach(r => {
      const rttMetric = r['[totalRoundTripTime/responsesReceived]'];
      if (typeof rttMetric === 'number') { rttSumMs += rttMetric * 1000; rttCount++; }
    });

    // Media playout
    metrics.playout?.forEach(r => {
      const playoutMetric = r['[totalPlayoutDelay/totalSamplesCount]'];
      if (typeof playoutMetric === 'number') { playoutDelaySumMs += playoutMetric * 1000; playoutDelayCount++; }
    });

    // PSNR (video quality)
    metrics.outbound.forEach(r => {
      const psnrYMetric = r['[PSNR_y]'];
      if (typeof psnrYMetric === 'number') { psnrYSum += psnrYMetric; psnrYCount++; }
    });

    result.jitterMsAvg = inboundCount ? (jitterSum / inboundCount) : 0;
    const totalPacketsInbound = packetsLostTotal + packetsReceivedTotal;
    result.packetLossPct = totalPacketsInbound ? (packetsLostTotal / totalPacketsInbound) * 100 : 0;
    result.frameDropPct = framesReceivedTotal ? (framesDroppedTotal / (framesReceivedTotal + framesDroppedTotal)) * 100 : 0;
    result.retransmitPct = packetsSentTotal ? (retransmittedPacketsSentTotal / packetsSentTotal) * 100 : 0;
    result.bitrateKbps = bytesSentPerSecondTotalBits ? (bytesSentPerSecondTotalBits / 1000) : 0;
    result.avgRttMs = rttCount ? (rttSumMs / rttCount) : 0;
    result.decodeMsPerFrame = decodeCount ? (decodeSum / decodeCount) : 0;
    result.jitterBufferDelayMs = jitterBufferDelayCount ? (jitterBufferDelaySum / jitterBufferDelayCount) : 0;
    result.playoutDelayMs = playoutDelayCount ? (playoutDelaySumMs / playoutDelayCount) : 0;
    result.audioLevelRms = audioRmsCount ? (audioRmsSum / audioRmsCount) : 0;
    result.psnrY = psnrYCount ? (psnrYSum / psnrYCount) : 0;
    return result;
  }

  function computeScore(m) {
    let score = 100;
    // Packet loss penalty.
    score -= Math.min(50, m.packetLossPct * 2);
    // Jitter penalty (threshold 30ms).
    if (m.jitterMsAvg > 30) score -= Math.min(25, (m.jitterMsAvg - 30) / 2);
    // Frame drop penalty (threshold 5%).
    if (m.frameDropPct > 5) score -= Math.min(15, (m.frameDropPct - 5) * 2);
    // Retransmission penalty (threshold 2%).
    if (m.retransmitPct > 2) score -= Math.min(10, (m.retransmitPct - 2) * 2);
    // Pause events penalty.
    if (m.pauseCount) score -= Math.min(10, m.pauseCount * 2);
    return Math.max(0, Math.round(score));
  }

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
  summary.innerHTML = '<span>RTC Quality Report</span><span class="rs-pill">' + new Date().toLocaleTimeString() + '</span>';
  details.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'rs-table table table-borderless table-hover mb-4 align-middle';
  const head = document.createElement('tr');
  ['Connection', 'PacketLoss %', 'Jitter ms', 'Avg RTT ms', 'Decode ms/frame', 'JBuf ms', 'Bitrate kbps', 'FrameDrop %', 'Retransmit %', 'Pause', 'Score'].forEach(h => {
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
    const snapshot = findLastGetStats(traceEvents) || (isInternals ? buildSnapshotFromInternalsStats(trace.stats) : null);
    const metricsRaw = computeMetricsFromSnapshot(snapshot);
    const metrics = aggregate(metricsRaw);
    const score = computeScore(metrics);
    metrics.score = score;
    allConnectionMetrics.push(metrics);

    const connectionLabel = getConnectionLabel(trace, isInternals);
    const displayName = connectionLabel || id;

    const row = document.createElement('tr');
    function td(v) { const c = document.createElement('td'); c.innerText = typeof v === 'number' ? v.toFixed(2) : v; return c; }
    row.appendChild(td(displayName));
    row.appendChild(td(metrics.packetLossPct));
    row.appendChild(td(metrics.jitterMsAvg));
    row.appendChild(td(metrics.avgRttMs));
    row.appendChild(td(metrics.decodeMsPerFrame));
    row.appendChild(td(metrics.jitterBufferDelayMs));
    row.appendChild(td(metrics.bitrateKbps));
    row.appendChild(td(metrics.frameDropPct));
    row.appendChild(td(metrics.retransmitPct));
    row.appendChild(td(metrics.pauseCount));
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
  ['Connection', 'Audio RMS', 'Playout Delay ms', 'Limitation Reasons', 'PSNR-Y'].forEach(h => { const th = document.createElement('th'); th.innerText = h; advHead.appendChild(th); });
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
    row.appendChild(td(m.audioLevelRms));
    row.appendChild(td(m.playoutDelayMs));
    row.appendChild(td(limitation));
    row.appendChild(td(m.psnrY));
    advTable.appendChild(row);
  });
  advDetails.appendChild(advTable);
  details.appendChild(advDetails);

  // Overall metrics aggregation
  const overall = allConnectionMetrics.reduce((acc, m) => {
    acc.packetLossPct += m.packetLossPct;
    acc.jitterMsAvg += m.jitterMsAvg;
    acc.bitrateKbps += m.bitrateKbps;
    acc.frameDropPct += m.frameDropPct;
    acc.retransmitPct += m.retransmitPct;
    acc.pauseCount += m.pauseCount;
    return acc;
  }, { packetLossPct: 0, jitterMsAvg: 0, bitrateKbps: 0, frameDropPct: 0, retransmitPct: 0, pauseCount: 0 });
  const n = allConnectionMetrics.length || 1;
  Object.keys(overall).forEach(k => { if (k !== 'bitrateKbps' && k !== 'pauseCount') overall[k] /= n; });
  overall.bitrateKbps = overall.bitrateKbps;
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
  analytics.appendChild(metricCard('Avg Packet Loss %', overall.packetLossPct.toFixed(2)));
  analytics.appendChild(metricCard('Avg Jitter (ms)', overall.jitterMsAvg.toFixed(2)));
  analytics.appendChild(metricCard('Total Bitrate (kbps)', overall.bitrateKbps.toFixed(2)));
  analytics.appendChild(metricCard('Avg Frame Drop %', overall.frameDropPct.toFixed(2)));
  analytics.appendChild(metricCard('Avg Retransmit %', overall.retransmitPct.toFixed(2)));
  analytics.appendChild(metricCard('Total Pause Events', overall.pauseCount));
  details.appendChild(analytics);

  const outer = document.createElement('div'); outer.className = 'container-fluid px-0'; outer.appendChild(details); reportDiv.appendChild(outer);
}
