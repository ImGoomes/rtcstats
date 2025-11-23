// RTC stats Report.
// Encapsulates analytics and score computation.
export function generateReport(importer) {
  const reportDiv = document.getElementById('report');
  if (!importer || !importer.data || !reportDiv) return;
  reportDiv.innerHTML = '';

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
      }
    });
    return metrics;
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
      encodeMsPerFrame: 0,
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
    let encodeSum = 0, encodeCount = 0;
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
      // Pause detection heuristic.
      if (r.active === false) result.pauseCount++;
      if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') result.pauseCount++;
      result.tracks.push({direction: 'inbound', kind: r.kind, mid: r.mid, codecId: r.codecId});
    });

    metrics.outbound.forEach(r => {
      if (typeof r.packetsSent === 'number') packetsSentTotal += r.packetsSent;
      if (typeof r.retransmittedPacketsSent === 'number') retransmittedPacketsSentTotal += r.retransmittedPacketsSent;
      if (typeof r['[bytesSent/s]'] === 'number') bytesSentPerSecondTotalBits += r['[bytesSent/s]'];
      const encodeMetric = r['[totalEncodeTime/framesEncoded_in_ms]'];
      if (typeof encodeMetric === 'number') { encodeSum += encodeMetric; encodeCount++; }
      const rttMetric = r['[totalRoundTripTime/roundTripTimeMeasurements]'];
      if (typeof rttMetric === 'number') { rttSumMs += rttMetric * 1000; rttCount++; }
      if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') {
        result.limitationReasons[r.qualityLimitationReason] = (result.limitationReasons[r.qualityLimitationReason] || 0) + 1;
      }
      if (r.active === false) result.pauseCount++;
      result.tracks.push({direction: 'outbound', kind: r.kind, mid: r.mid, codecId: r.codecId});
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
    result.encodeMsPerFrame = encodeCount ? (encodeSum / encodeCount) : 0;
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
    const barContainer = document.createElement('div');
    barContainer.style.position = 'relative';
    barContainer.style.width = '250px';
    barContainer.style.height = '20px';
    barContainer.style.border = '1px solid #666';
    barContainer.style.borderRadius = '4px';
    const bar = document.createElement('div');
    bar.style.height = '100%';
    bar.style.width = score + '%';
    const hue = (score * 1.2);
    bar.style.background = 'linear-gradient(90deg, hsl(' + hue + ',70%,50%), hsl(' + (hue+20) + ',70%,40%))';
    bar.style.borderRadius = '4px';
    barContainer.appendChild(bar);
    const label = document.createElement('span');
    label.innerText = ' Score: ' + score;
    label.style.marginLeft = '8px';
    barContainer.appendChild(label);
    return barContainer;
  }

  const details = document.createElement('details');
  details.open = true;
  details.style.margin = '10px';
  const summary = document.createElement('summary');
  summary.innerText = 'Quality Report';
  details.appendChild(summary);

  const table = document.createElement('table');
  const head = document.createElement('tr');
  ['Connection','PacketLoss %','Jitter ms','Avg RTT ms','Encode ms/frame','Decode ms/frame','JBuf ms','Bitrate kbps','FrameDrop %','Retransmit %','Pause','Score'].forEach(h => {
    const th = document.createElement('th'); th.innerText = h; head.appendChild(th);
  });
  table.appendChild(head);

  const connectionIds = Object.keys(connections);
  connectionIds.forEach(id => {
    const trace = connections[id];
    const traceEvents = isInternals ? trace.updateLog : trace;
    const snapshot = findLastGetStats(traceEvents);
    const metricsRaw = computeMetricsFromSnapshot(snapshot);
    const metrics = aggregate(metricsRaw);
    const score = computeScore(metrics);
    metrics.score = score;
    allConnectionMetrics.push(metrics);

    const row = document.createElement('tr');
    function td(v){const c=document.createElement('td'); c.innerText=typeof v==='number'?v.toFixed(2):v; return c;}
    row.appendChild(td(id));
    row.appendChild(td(metrics.packetLossPct));
    row.appendChild(td(metrics.jitterMsAvg));
    row.appendChild(td(metrics.avgRttMs));
    row.appendChild(td(metrics.encodeMsPerFrame));
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
  ['Connection','Audio RMS','Playout Delay ms','Limitation Reasons','PSNR-Y'].forEach(h=>{const th=document.createElement('th'); th.innerText=h; advHead.appendChild(th);});
  advTable.appendChild(advHead);
  allConnectionMetrics.forEach((m,i) => {
    const row = document.createElement('tr');
    function td(v){const c=document.createElement('td'); c.innerText=typeof v==='number'?v.toFixed(2):v; return c;}
    const limitation = Object.keys(m.limitationReasons).map(k=>k+':'+m.limitationReasons[k]).join(', ') || 'none';
    row.appendChild(td(connectionIds[i]));
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
  }, {packetLossPct:0,jitterMsAvg:0,bitrateKbps:0,frameDropPct:0,retransmitPct:0,pauseCount:0});
  const n = allConnectionMetrics.length || 1;
  Object.keys(overall).forEach(k => { if (k !== 'bitrateKbps' && k !== 'pauseCount') overall[k] /= n; });
  overall.bitrateKbps = overall.bitrateKbps;
  const overallScore = computeScore(overall);

  const overallDiv = document.createElement('div');
  overallDiv.style.margin = '10px 0';
  overallDiv.style.fontWeight = 'bold';
  overallDiv.innerText = 'Overall Score';
  overallDiv.appendChild(makeScoreBar(overallScore));
  details.appendChild(overallDiv);

  details.appendChild(table);

  // Extra analytics section
  const analytics = document.createElement('div');
  analytics.style.marginTop = '10px';
  analytics.innerHTML = '<h4>Analytics</h4>';
  const list = document.createElement('ul');
  function li(t){const e=document.createElement('li'); e.innerText=t; return e;}
  list.appendChild(li('Average packet loss across connections: ' + overall.packetLossPct.toFixed(2) + '%'));
  list.appendChild(li('Average jitter across connections: ' + overall.jitterMsAvg.toFixed(2) + ' ms'));
  list.appendChild(li('Total outbound bitrate: ' + overall.bitrateKbps.toFixed(2) + ' kbps'));
  list.appendChild(li('Average frame drop percentage: ' + overall.frameDropPct.toFixed(2) + '%'));
  list.appendChild(li('Average retransmission percentage: ' + overall.retransmitPct.toFixed(2) + '%'));
  list.appendChild(li('Total pause-like events detected: ' + overall.pauseCount));
  analytics.appendChild(list);
  details.appendChild(analytics);

  reportDiv.appendChild(details);
}
