import {RTCStatsDumpImporter} from './import-rtcstats.js';
import {WebRTCInternalsDumpImporter} from './import-internals.js';
import {detectRTCStatsDump, detectWebRTCInternalsDump} from 'rtcstats-shared';

const container = document.getElementById('tables');
const reportBtn = document.getElementById('generate-report');
const reportDiv = document.getElementById('report');

function generateReport(importer) {
    if (!importer || !reportDiv) return;
    reportDiv.innerHTML = '';
    const details = document.createElement('details');
    details.open = true;
    details.style.margin = '10px';
    const summary = document.createElement('summary');
    summary.innerText = 'Test Report';
    details.appendChild(summary);

    const table = document.createElement('table');
    const head = document.createElement('tr');
    ['Connection', 'ICE states', 'Result'].forEach(h => {
        const th = document.createElement('th');
        th.innerText = h;
        head.appendChild(th);
    });
    table.appendChild(head);

    let overallPass = true;

    if (importer.data && importer.data.peerConnections) {
        const pcs = importer.data.peerConnections;
        for (const id in pcs) {
            const trace = pcs[id];
            const states = [];
            let connected = false, completed = false, failed = false;
            for (const ev of trace) {
                if (['oniceconnectionstatechange', 'onconnectionstatechange'].includes(ev.type)) {
                    const v = String(ev.value || '').replace(/"/g, '');
                    states.push(v);
                    if (v === 'connected') connected = true;
                    if (v === 'completed') completed = true;
                    if (v === 'failed') failed = true;
                }
            }
            const pass = (connected || completed) && !failed;
            overallPass = overallPass && pass;
            const row = document.createElement('tr');
            const c1 = document.createElement('td'); c1.innerText = id; row.appendChild(c1);
            const c2 = document.createElement('td'); c2.innerText = states.join(' => '); row.appendChild(c2);
            const c3 = document.createElement('td'); c3.innerText = pass ? 'PASS' : 'FAIL'; row.appendChild(c3);
            table.appendChild(row);
        }
    } else if (importer.data && importer.data.PeerConnections) {
        const pcs = importer.data.PeerConnections;
        for (const id in pcs) {
            const pc = pcs[id];
            const states = [];
            let connected = false, completed = false, failed = false;
            for (const ev of pc.updateLog) {
                if (['iceconnectionstatechange', 'connectionstatechange'].includes(ev.type)) {
                    const v = String(ev.value || '').replace(/"/g, '');
                    states.push(v);
                    if (v === 'connected') connected = true;
                    if (v === 'completed') completed = true;
                    if (v === 'failed') failed = true;
                }
            }
            const pass = (connected || completed) && !failed;
            overallPass = overallPass && pass;
            const row = document.createElement('tr');
            const c1 = document.createElement('td'); c1.innerText = id; row.appendChild(c1);
            const c2 = document.createElement('td'); c2.innerText = states.join(' => '); row.appendChild(c2);
            const c3 = document.createElement('td'); c3.innerText = pass ? 'PASS' : 'FAIL'; row.appendChild(c3);
            table.appendChild(row);
        }
    }

    const overall = document.createElement('div');
    overall.innerText = 'Overall: ' + (overallPass ? 'PASS' : 'FAIL');
    overall.style.fontWeight = 'bold';
    details.appendChild(overall);
    details.appendChild(table);
    reportDiv.appendChild(details);
}
document.getElementById('import').onchange = async (evt) => {
    evt.target.disabled = 'disabled';
    document.getElementById('useReferenceTime').disabled = true;

    const useReferenceTime = document.getElementById('useReferenceTime').checked;

    const files = evt.target.files;
    const file = files[0];
    let stream;
    if (file.type === 'application/gzip') {
        stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    } else {
        stream = file.stream();
    }
    const blob = await (new Response(stream)).blob();
    if (await detectRTCStatsDump(blob)) {
        window.importer = new RTCStatsDumpImporter(container);
        importer.process(blob);
    } else if (await detectWebRTCInternalsDump(blob)) {
        window.importer = new WebRTCInternalsDumpImporter(container, {useReferenceTime});
        importer.process(blob);
    } else {
        console.error('Unrecognized format');
    }
    window.rtcStatsDumpImporterSuccess = true;
    if (reportBtn) { reportBtn.disabled = false; reportBtn.onclick = () => generateReport(window.importer); }
};

